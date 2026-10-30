const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');
const { Server } = require('socket.io');

const discordBot = require('./discord-bot');
const botAdmin = require('./bot-2.js');
const botTwitch = require('./bot-twitch.js');

const ADMIN_DISCORD_ID = "398911896893521921";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1546268855708684318"; 
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "sQ_3XRcNGuEHnoDUdy5zKfPvZOGry0FF"; 
const REDIRECT_URI = process.env.REDIRECT_URI || "https://rbx-rewards.onrender.com/api/admin/callback";
const ADMIN_PROMO_CHANNEL_ID = "1556029618077704192";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

let discordClient = null;
if (DISCORD_BOT_TOKEN) {
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
}

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } }); 

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const activeAdminTokens = new Set();
function isAdmin(req, res, next) {
    const token = req.headers.authorization;
    if (token && activeAdminTokens.has(token)) return next();
    return res.status(403).json({ error: 'Brak dostępu!' });
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPolandMidnight() {
    const now = new Date();
    const polandTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
    const diffMs = polandTime.getTime() - now.getTime();
    polandTime.setHours(0, 0, 0, 0);
    return new Date(polandTime.getTime() - diffMs);
}

app.get('/api/admin/login', (req, res) => {
    const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(authUrl);
});

app.get('/api/admin/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=NoCode');

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI
            })
        });
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.redirect('/?error=AuthFailed');

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();

        if (userData.id === ADMIN_DISCORD_ID) {
            const sessionToken = crypto.randomBytes(32).toString('hex');
            activeAdminTokens.add(sessionToken);
            res.redirect(`/?adminToken=${sessionToken}`); 
        } else {
            res.redirect('/?error=Unauthorized');
        }
    } catch (error) { res.redirect('/?error=ServerError'); }
});

app.post('/api/admin/verify', (req, res) => {
    const { token } = req.body;
    if (token && activeAdminTokens.has(token)) res.json({ success: true });
    else res.json({ success: false });
});

// --- ADMIN API ---
const onlineUsersMap = new Map();

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const polandMidnight = getPolandMidnight();

        const dailyPointsAggr = await Earning.aggregate([
            { $match: { createdAt: { $gte: polandMidnight }, source: { $nin: ['Admin', 'Promo'] } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const dailyRobux = dailyPointsAggr.length > 0 ? dailyPointsAggr[0].total : 0;

        const pendingPayoutsAggr = await Payout.aggregate([
            { $match: { status: 'Pending Manual' } },
            { $group: { _id: null, total: { $sum: "$pointsWithdrawn" } } }
        ]);
        const pendingRobux = pendingPayoutsAggr.length > 0 ? pendingPayoutsAggr[0].total : 0;
        
        const uniqueOnline = new Set(onlineUsersMap.values()).size;
        
        res.json({ online: uniqueOnline, dailyRobux: dailyRobux, pendingRobux: pendingRobux });
    } catch (err) { res.status(500).json({ error: 'Błąd statystyk' }); }
});

app.get('/api/admin/online', isAdmin, (req, res) => {
    res.json(Array.from(new Set(onlineUsersMap.values())).sort((a, b) => a.localeCompare(b)));
});

app.get('/api/admin/users/search', isAdmin, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 1) return res.json([]);
        const safeQ = escapeRegex(q);
        const users = await User.find({ username: new RegExp(`^${safeQ}`, 'i') })
            .select('username')
            .sort({ username: 1 })
            .limit(20);
        const sortedNames = users.map(u => u.username).sort((a, b) => a.localeCompare(b));
        res.json(sortedNames);
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/admin/user-details/:username', isAdmin, async (req, res) => {
    try {
        const safeName = escapeRegex(req.params.username.trim());
        const regex = new RegExp(`^${safeName}$`, 'i');
        const user = await User.findOne({ username: regex });
        if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza' });
        
        const pending = await Payout.find({ username: regex, status: 'Pending Manual' }).sort({ createdAt: -1 });
        const pendingSum = pending.reduce((sum, p) => sum + (p.pointsWithdrawn || 0), 0);
        
        res.json({
            username: user.username,
            points: user.points,
            pendingSum: pendingSum,
            pendingRequests: pending
        });
    } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/admin/manage-balance', isAdmin, async (req, res) => {
    const { username, amount, action } = req.body;
    try {
        const safeName = escapeRegex((username || '').trim());
        let user = await User.findOne({ username: new RegExp(`^${safeName}$`, 'i') });
        if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza!' });
        
        let amt = parseFloat(amount);
        if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota!' });
        
        if (action === 'add') {
            user.points += amt;
            await new Earning({ username: user.username, amount: amt, source: 'Admin', details: 'Dodano ręcznie' }).save();
        } else if (action === 'subtract') {
            user.points = Math.max(0, user.points - amt);
            await new Earning({ username: user.username, amount: -amt, source: 'Admin', details: 'Odebrano ręcznie' }).save();
        }
        
        await user.save();
        res.json({ success: true, newBalance: user.points });
    } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.get('/api/admin/pending-payouts', isAdmin, async (req, res) => {
    try {
        const payouts = await Payout.find({ status: 'Pending Manual' }).sort({ createdAt: -1 });
        res.json(payouts);
    } catch(e) { res.status(500).json([]); }
});

app.post('/api/admin/resolve-payout', isAdmin, async (req, res) => {
    const { payoutId, action } = req.body; 
    try {
        const payout = await Payout.findById(payoutId);
        if(!payout) return res.status(404).json({ error: 'Wypłata nie istnieje' });
        
        if(action === 'complete') {
            payout.status = 'Completed';
            await payout.save();
        } else if(action === 'reject') {
            const safeName = escapeRegex(payout.username);
            let user = await User.findOne({ username: new RegExp(`^${safeName}$`, 'i') });
            if(user) {
                user.points += payout.pointsWithdrawn;
                await user.save();
            }
            payout.status = 'Rejected';
            await payout.save();
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Błąd' }); }
});

app.post('/api/admin/create-code', isAdmin, async (req, res) => {
    const { code, reward, maxUses } = req.body;
    if (!code || !reward || !maxUses) return res.status(400).json({ error: 'Uzupełnij wszystkie pola!' });
    try {
        const newCode = new PromoCode({ code: code.toUpperCase(), reward, maxUses, usedBy: [] });
        await newCode.save();
        if (discordClient && ADMIN_PROMO_CHANNEL_ID) {
            const channel = discordClient.channels.cache.get(ADMIN_PROMO_CHANNEL_ID);
            if (channel) {
                channel.send(`🎉 **Nowy Kod Promocyjny!** 🎉\n\n🎟️ Kod: \`${code.toUpperCase()}\`\n💰 Wartość: **${reward} R$**\n👥 Limit użyć: **${maxUses}**\n\nSzybko wbijajcie na stronę i odbierajcie!`);
            }
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Błąd dodawania kodu. Kod już istnieje?' }); }
});

app.get('/ping', (req, res) => { res.status(200).send('OK'); });

const MONGO_URI = 'mongodb+srv://contactcatlover_db_user:E8zvsX5pv1oMtKNE@robux.h3weh54.mongodb.net/?appName=Robux';
mongoose.connect(MONGO_URI).then(() => console.log('✅ Baza MongoDB gotowa!')).catch(err => console.error(err));

// --- SCHEMATY BAZY DANYCH ---
const GoalSchema = new mongoose.Schema({
    id: { type: String, required: true }, title: String, target: Number, current: { type: Number, default: 0 },
    status: { type: String, default: 'active' }, imageUrl: { type: String, default: '' }, createdAt: { type: Date, default: Date.now }
});

const UserSchema = new mongoose.Schema({
    username: String, points: { type: Number, default: 0 }, referredBy: { type: String, default: null }, referredUsers: { type: [String], default: [] },
    redeemedPromoCodes: { type: [{ code: String, reward: Number, date: { type: Date, default: Date.now } }], default: [] },
    inbox: { type: [{ message: String, date: { type: Date, default: Date.now }, read: { type: Boolean, default: false } }], default: [] },
    linkedPayPal: { type: String, default: null }, xp: { type: Number, default: 0 }, claimedLevels: { type: [Number], default: [] },
    dailyEarned: { type: Number, default: 0 }, lastEarnedDate: { type: String, default: "" }, lastWheelSpin: { type: Date, default: null },
    wheelStreak: { type: Number, default: 0 }, goals: [GoalSchema]
});
const User = mongoose.model('User', UserSchema);

const EarningSchema = new mongoose.Schema({ username: String, amount: Number, source: { type: String, default: 'Survey' }, details: { type: String, default: '' }, createdAt: { type: Date, default: Date.now } });
const Earning = mongoose.model('Earning', EarningSchema);

const PayoutSchema = new mongoose.Schema({ 
    username: String, payoutMethod: { type: String, default: 'PayPal' }, payoutAddress: String, paypalEmail: String, 
    pointsWithdrawn: Number, usdAmount: Number, status: { type: String, default: 'Pending Manual' }, createdAt: { type: Date, default: Date.now } 
});
const Payout = mongoose.model('Payout', PayoutSchema);

const PromoCodeSchema = new mongoose.Schema({ code: { type: String, unique: true, uppercase: true }, reward: Number, maxUses: Number, currentUses: { type: Number, default: 0 }, usedBy: [String] });
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);

const dbModels = { User, Earning, Payout, PromoCode };

function allocateGoalProgress(user, amountToAllocate) {
    let remaining = amountToAllocate;
    let activeGoals = user.goals.filter(g => g.status === 'active').sort((a, b) => a.createdAt - b.createdAt);
    for (let goal of activeGoals) {
        if (remaining <= 0) break;
        let needed = goal.target - goal.current;
        if (remaining >= needed) { goal.current = goal.target; goal.status = 'completed'; remaining -= needed; } 
        else { goal.current += remaining; remaining = 0; }
    }
}

async function processReferralBonus(username, amountEarned) {
    try {
        const user = await User.findOne({ username: username });
        if (user && user.referredBy) {
            const bonus = parseFloat((amountEarned * 0.15).toFixed(2));
            const referrer = await User.findOne({ username: user.referredBy });
            if (referrer) { referrer.points += bonus; allocateGoalProgress(referrer, bonus); await referrer.save(); await new Earning({ username: referrer.username, amount: bonus, source: 'Referral', details: username }).save(); }
        }
    } catch (err) {}
}

async function addXPAndDailyEarned(user, amount) {
    const today = new Date().toISOString().split('T')[0];
    if (user.lastEarnedDate !== today) { user.dailyEarned = 0; user.lastEarnedDate = today; }
    user.dailyEarned += amount; user.xp += amount * 100;
}

app.get('/postback', async (req, res) => {
    const userId = req.query.user_id; const amount = parseFloat(req.query.amount_local); const status = req.query.status;
    res.status(200).send('OK');
    if ((status === '1' || status === '2') && userId && amount) {
        try { let user = await User.findOne({ username: userId }); if (!user) user = new User({ username: userId, points: 0 });
            user.points += amount; await addXPAndDailyEarned(user, amount); allocateGoalProgress(user, amount); await user.save();
            await new Earning({ username: userId, amount: amount, source: 'Survey' }).save(); await processReferralBonus(userId, amount);
        } catch (error) {}
    }
});

app.all('/api/theoremreach-postback', async (req, res) => {
    const uid = req.query.user_id || req.body.user_id || req.query.uid || req.body.uid; const reward = parseFloat(req.query.reward || req.body.reward); const isReversal = req.query.reversal === 'true' || req.query.reversal === true;
    if (!uid || isNaN(reward)) return res.status(400).send('0'); if (isReversal) return res.status(200).send('1');
    if (reward > 0) {
        try { let user = await User.findOne({ username: uid }); if (!user) user = new User({ username: uid, points: 0 }); user.points += reward; await addXPAndDailyEarned(user, reward); allocateGoalProgress(user, reward); await user.save(); await new Earning({ username: uid, amount: reward, source: 'Survey' }).save(); await processReferralBonus(uid, reward); return res.status(200).send('1'); } 
        catch (error) { return res.status(500).send('0'); }
    }
    res.status(200).send('1');
});

app.get('/api/goals/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.json([]); res.json(user.goals); } catch (e) { res.json([]); }
});

app.post('/api/goals/add', async (req, res) => {
    const { username, title, target } = req.body;
    try {
        const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak usera' });
        const activeCount = user.goals.filter(g => g.status === 'active').length; if (activeCount >= 5) return res.status(400).json({ error: 'Limit 5 aktywnych celów osiągnięty!' });
        user.goals.push({ id: crypto.randomBytes(8).toString('hex'), title: title || 'Mój Cel', target: parseFloat(target), current: 0, status: 'active', imageUrl: '' });
        await user.save(); res.json({ success: true, goals: user.goals });
    } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/goals/cancel', async (req, res) => {
    const { username, goalId } = req.body;
    try {
        const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak usera' });
        const goalIndex = user.goals.findIndex(g => g.id === goalId); if (goalIndex === -1) return res.status(404).json({ error: 'Nie znaleziono celu' });
        let goal = user.goals[goalIndex]; if (goal.status !== 'active') return res.status(400).json({ error: 'Cel już zakończony' });
        goal.status = 'canceled'; const rollover = goal.current; goal.current = 0; if (rollover > 0) allocateGoalProgress(user, rollover); await user.save(); res.json({ success: true, goals: user.goals });
    } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/goals/clear', async (req, res) => {
    const { username } = req.body;
    try { const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak usera' }); user.goals = user.goals.filter(g => g.status === 'active'); await user.save(); res.json({ success: true, goals: user.goals }); } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.get('/api/points/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) { user = new User({ username: req.params.username.trim(), points: 0 }); await user.save(); } res.json({ points: user.points, referredBy: user.referredBy, linkedPayPal: user.linkedPayPal }); } catch (error) { res.json({ points: 0 }); }
});

app.get('/api/user-stats/:username', async (req, res) => {
    try {
        const safe = escapeRegex(req.params.username);
        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.json({ xp: 0, dailyEarned: 0, claimedLevels: [], lastWheelSpin: null, wheelStreak: 0 });
        const startOfDay = getPolandMidnight();
        const dailyEarnedAggr = await Earning.aggregate([{ $match: { username: new RegExp(`^${safe}$`, 'i'), createdAt: { $gte: startOfDay }, source: { $in: ['Survey'] } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const actualDailyEarned = dailyEarnedAggr.length > 0 ? dailyEarnedAggr[0].total : 0;
        let currentStreak = user.wheelStreak || 0;
        if (user.lastWheelSpin) { const diffHours = (new Date() - new Date(user.lastWheelSpin)) / (1000 * 60 * 60); if (diffHours > 48 && currentStreak !== 0) { currentStreak = 0; user.wheelStreak = 0; await user.save(); } }
        res.json({ xp: user.xp || 0, dailyEarned: actualDailyEarned, claimedLevels: user.claimedLevels || [], lastWheelSpin: user.lastWheelSpin, wheelStreak: currentStreak });
    } catch (error) { res.json({ xp: 0, dailyEarned: 0, claimedLevels: [], lastWheelSpin: null, wheelStreak: 0 }); }
});

const LEVEL_THRESHOLDS = { 1: { xp: 1000, reward: 3 }, 2: { xp: 5000, reward: 8 }, 3: { xp: 15000, reward: 20 }, 4: { xp: 40000, reward: 50 }, 5: { xp: 100000, reward: 100 } };

app.post('/api/claim-level', async (req, res) => {
    const { username, level } = req.body;
    try { const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak użytkownika.' }); const lvlData = LEVEL_THRESHOLDS[level]; if (!lvlData || user.xp < lvlData.xp || user.claimedLevels.includes(level)) return res.status(400).json({ error: 'Nie możesz odebrać tego poziomu.' }); user.claimedLevels.push(level); user.points += lvlData.reward; allocateGoalProgress(user, lvlData.reward); await user.save(); await new Earning({ username: user.username, amount: lvlData.reward, source: 'LevelUp', details: `Level ${level}` }).save(); res.json({ success: true, reward: lvlData.reward, newBalance: user.points }); } 
    catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/spin-wheel', async (req, res) => {
    const { username } = req.body;
    try {
        const safe = escapeRegex(username);
        let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });
        const startOfDay = getPolandMidnight();
        const dailyEarnedAggr = await Earning.aggregate([{ $match: { username: new RegExp(`^${safe}$`, 'i'), createdAt: { $gte: startOfDay }, source: { $in: ['Survey'] } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const actualDailyEarned = dailyEarnedAggr.length > 0 ? dailyEarnedAggr[0].total : 0;
        if (actualDailyEarned < 4.5) return res.status(400).json({ error: 'Zarób dzisiaj minimum 4.50 R$ (Oferty/Ankiety), aby zakręcić kołem!' });
        const now = new Date();
        if (user.lastWheelSpin) { const diffHours = (now - new Date(user.lastWheelSpin)) / (1000 * 60 * 60); if (diffHours < 24) return res.status(400).json({ error: 'Koło jest jeszcze zablokowane (trwa 24h blokady)!' }); if (diffHours <= 48) user.wheelStreak = (user.wheelStreak || 0) + 1; else user.wheelStreak = 1; } else { user.wheelStreak = 1; }
        const rand = Math.random() * 100; let reward = 0.1; if (rand <= 1) reward = 2.5; else if (rand <= 5) reward = 1.0; else if (rand <= 20) reward = 0.5; else if (rand <= 55) reward = 0.2; else reward = 0.1;
        user.points += reward; user.lastWheelSpin = now; allocateGoalProgress(user, reward); await user.save(); await new Earning({ username: user.username, amount: reward, source: 'Wheel', details: `Streak: ${user.wheelStreak}` }).save(); res.json({ success: true, reward, newBalance: user.points, streak: user.wheelStreak });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.get('/api/latest-earners', async (req, res) => { try { res.json(await Earning.find({ source: { $in: ['Survey', 'Promo', 'LevelUp', 'Spinner', 'Wheel'] } }).sort({ createdAt: -1 }).limit(5)); } catch (e) { res.json([]); } });
app.get('/api/latest-payouts', async (req, res) => { try { res.json(await Payout.find({ status: 'Completed' }).sort({ createdAt: -1 }).limit(5)); } catch (e) { res.json([]); } });
app.get('/api/leaderboard', async (req, res) => {
    try {
        const period = req.query.period || '7days'; const now = new Date(); let matchStage = { source: { $nin: ['Promo', 'Admin'] } }; 
        if (period !== 'alltime') { let startDate = new Date(); if (period === 'today') startDate = getPolandMidnight(); else if (period === '7days') startDate.setDate(now.getDate() - 7); else if (period === '30days') startDate.setDate(now.getDate() - 30); else if (period === 'year') startDate.setFullYear(now.getFullYear() - 1); matchStage.createdAt = { $gte: startDate }; }
        const leaderboard = await Earning.aggregate([{ $match: matchStage }, { $group: { _id: "$username", earned: { $sum: "$amount" } } }, { $sort: { earned: -1 } }, { $limit: 100 }, { $project: { _id: 0, username: "$_id", earned: 1 } }]); res.json(leaderboard);
    } catch (error) { res.status(500).json({ error: "Błąd podczas ładowania rankingu." }); }
});

app.get('/api/earning-history/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); const regex = new RegExp(`^${safe}$`, 'i'); const earnings = await Earning.find({ username: regex }).lean(); const payouts = await Payout.find({ username: regex }).lean(); const combined = [...earnings.map(e => ({ ...e, recordType: 'earning' })), ...payouts.map(p => ({ ...p, recordType: 'payout' }))]; combined.sort((a, b) => b.createdAt - a.createdAt); res.json(combined.slice(0, 100)); } catch (error) { res.status(500).json({ error: "Error" }); }
});

app.get('/api/inbox/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.json([]); const unread = user.inbox.filter(msg => !msg.read); if (unread.length > 0) { user.inbox.forEach(msg => msg.read = true); await user.save(); } res.json(unread); } catch (error) { res.json([]); }
});

app.post('/api/support-ticket', async (req, res) => {
    try { const { username, contact, message } = req.body; if (!username || !message) return res.status(400).json({ error: 'Brak wymaganych danych.' }); discordBot.sendTicketAlert(username, contact, message); return res.json({ success: true, message: 'Ticket pomyślnie wysłany!' }); } catch (error) { return res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/withdraw', async (req, res) => {
    const paypalEmail = req.body.paypalEmail || req.body.payoutAddress; const { username, points } = req.body;
    try {
        const safe = escapeRegex(username);
        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user || user.points < points) return res.status(400).json({ error: 'Nie masz tylu R$!' });
        if (user.linkedPayPal) { if (user.linkedPayPal.toLowerCase() !== paypalEmail.toLowerCase()) return res.status(400).json({ error: `Konto przypisane do adresu: ${user.linkedPayPal}` }); } else { user.linkedPayPal = paypalEmail.toLowerCase(); }
        const usdAmount = parseFloat((points * 0.025).toFixed(2)); user.points -= points; await user.save(); const newPayout = await new Payout({ username: user.username, payoutMethod: 'PayPal', payoutAddress: paypalEmail.toLowerCase(), paypalEmail: paypalEmail.toLowerCase(), pointsWithdrawn: points, usdAmount, status: 'Pending Manual' }).save(); discordBot.sendPayoutAlert(newPayout); res.json({ success: true, newBalance: user.points, usd: usdAmount });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/redeem-promo', async (req, res) => {
    const { username, promoCode } = req.body; if (!username || !promoCode) return res.status(400).json({ error: 'Brak danych.' });
    try {
        const promo = await PromoCode.findOne({ code: promoCode.toUpperCase() }); if (!promo || promo.currentUses >= promo.maxUses || promo.usedBy.includes(username.toLowerCase())) return res.status(400).json({ error: 'Kod nieprawidłowy, zużyty lub już go odebrałeś!' });
        const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) user = new User({ username, points: 0 }); user.points += promo.reward; if (!user.redeemedPromoCodes) user.redeemedPromoCodes = []; user.redeemedPromoCodes.push({ code: promo.code, reward: promo.reward, date: new Date() }); allocateGoalProgress(user, promo.reward); await user.save(); promo.currentUses += 1; promo.usedBy.push(username.toLowerCase()); await promo.save(); await new Earning({ username: user.username, amount: promo.reward, source: 'Promo', details: promo.code }).save(); res.json({ success: true, newBalance: user.points, message: `Odebrano ${promo.reward} R$!` });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.get('/api/promo-history/:username', async (req, res) => { try { const safe = escapeRegex(req.params.username); const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.json([]); const history = user.redeemedPromoCodes || []; history.sort((a, b) => new Date(b.date) - new Date(a.date)); res.json(history); } catch (error) { res.status(500).json({ error: "Error" }); } });

app.post('/api/redeem-code', async (req, res) => {
    const { username, code } = req.body; if (!username || !code) return res.status(400).json({ error: 'Missing data.' }); if (username.toLowerCase() === code.toLowerCase()) return res.status(400).json({ error: "Can't refer yourself!" });
    try {
        const safeUser = escapeRegex(username); const safeCode = escapeRegex(code);
        let user = await User.findOne({ username: new RegExp(`^${safeUser}$`, 'i') }); if (!user) user = new User({ username: username, points: 0 }); if (user.referredBy) return res.status(400).json({ error: 'Already used referral code!' });
        let referrer = await User.findOne({ username: new RegExp(`^${safeCode}$`, 'i') }); if (!referrer) return res.status(404).json({ error: 'Referral not found.' }); user.referredBy = referrer.username; await user.save(); if (!referrer.referredUsers.includes(user.username)) { referrer.referredUsers.push(user.username); await referrer.save(); } res.json({ success: true, message: 'Code activated!' });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/referral-stats/:username', async (req, res) => {
    try {
        const safe = escapeRegex(req.params.username); const period = req.query.period || '7days'; let startDate = new Date(0); let endDate = new Date(); const now = new Date();
        if (period === 'today') { startDate = getPolandMidnight(); } else if (period === '7days') { startDate = new Date(now.setDate(now.getDate() - 7)); } else if (period === '30days') { startDate = new Date(now.setDate(now.getDate() - 30)); }
        const referredDocs = await User.find({ referredBy: new RegExp(`^${safe}$`, 'i') }); const referredUsernames = referredDocs.map(u => u.username); if (referredUsernames.length === 0) return res.json([]);
        const earnings = await Earning.aggregate([{ $match: { username: { $in: referredUsernames }, createdAt: { $gte: startDate, $lte: endDate }, source: 'Survey' } }, { $group: { _id: "$username", totalEarned: { $sum: "$amount" } } }]);
        const finalStats = referredUsernames.map(ru => { const found = earnings.find(e => e._id === ru); return { username: ru, earned: found ? found.totalEarned * 0.15 : 0 }; }); finalStats.sort((a, b) => b.earned - a.earned); res.json(finalStats); 
    } catch (error) { res.json([]); }
});

io.on('connection', (socket) => { 
    socket.on('user_joined', (username) => { if(username) onlineUsersMap.set(socket.id, username); });
    socket.on('chatMessage', (data) => { io.emit('chatMessage', data); }); 
    socket.on('disconnect', () => { onlineUsersMap.delete(socket.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Serwer śmiga na porcie ${PORT}`); });

if (discordClient) {
    discordClient.once('ready', () => { console.log(`🤖 Bot Discord połączony!`); discordBot.init(discordClient, dbModels); });
    discordClient.login(DISCORD_BOT_TOKEN).catch(console.error);
}
botAdmin.init();
botTwitch.init();