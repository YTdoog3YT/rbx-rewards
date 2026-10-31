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
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
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
            { $match: { createdAt: { $gte: polandMidnight }, source: { $nin: ['Admin', 'Promo', 'BundleDeposit', 'BundleRefund', 'BundleRejected', 'BundleDone'] } } },
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

// Pobieranie aktywnych kodów dla panelu admina
app.get('/api/admin/promo-codes', isAdmin, async (req, res) => {
    try {
        const codes = await PromoCode.find({}).sort({ _id: -1 });
        // Automatycznie odrzucamy te, które w pełni wygasły (currentUses >= maxUses)
        const activeCodes = codes.filter(c => c.currentUses < c.maxUses);
        res.json(activeCodes);
    } catch (e) { res.status(500).json([]); }
});

// Usuwanie kodu przez admina
app.post('/api/admin/delete-code', isAdmin, async (req, res) => {
    try {
        const { codeId } = req.body;
        await PromoCode.findByIdAndDelete(codeId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Błąd usuwania kodu' }); }
});

app.get('/ping', (req, res) => { res.status(200).send('OK'); });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ Brak zmiennej MONGO_URI'); process.exit(1); }
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
    wheelStreak: { type: Number, default: 0 }, goals: [GoalSchema],
    verified: { type: Boolean, default: false }, robloxName: { type: String, default: '' }, gaijinId: { type: String, default: '' }, discordName: { type: String, default: '' }
});
const User = mongoose.model('User', UserSchema);

const EarningSchema = new mongoose.Schema({ username: String, amount: Number, source: { type: String, default: 'Survey' }, details: { type: String, default: '' }, txId: String, createdAt: { type: Date, default: Date.now } });
EarningSchema.index({ source: 1, txId: 1 }, { unique: true, partialFilterExpression: { txId: { $type: 'string' } } });
const Earning = mongoose.model('Earning', EarningSchema);

const PayoutSchema = new mongoose.Schema({ 
    username: String, payoutMethod: { type: String, default: 'PayPal' }, payoutAddress: String, paypalEmail: String, 
    pointsWithdrawn: Number, usdAmount: Number, status: { type: String, default: 'Pending Manual' }, createdAt: { type: Date, default: Date.now } 
});
const Payout = mongoose.model('Payout', PayoutSchema);

const PromoCodeSchema = new mongoose.Schema({ code: { type: String, unique: true, uppercase: true }, reward: Number, maxUses: Number, currentUses: { type: Number, default: 0 }, usedBy: [String] });
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);

const BundleSchema = new mongoose.Schema({
    username: String, category: String, offerId: String, title: String,
    priceC: Number, depositedC: { type: Number, default: 0 },
    customUsd: { type: Number, default: 0 }, approxRobux: { type: Number, default: 0 },
    gameId: String, discord: String,
    status: { type: String, default: 'filling' },
    createdAt: { type: Date, default: Date.now }, paidAt: Date, doneAt: Date
});
const Bundle = mongoose.model('Bundle', BundleSchema);

const dbModels = { User, Earning, Payout, PromoCode, Bundle };

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

const POSTBACK_KEY = process.env.POSTBACK_KEY || '';
const POSTBACK_ENFORCE = process.env.POSTBACK_ENFORCE === 'true';
const MAX_SURVEY_REWARD = 500;

function postbackAllowed(givenKey, label) {
    const a = Buffer.from(String(givenKey || ''));
    const b = Buffer.from(POSTBACK_KEY);
    if (b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    console.warn(`[postback] ${label}: brak lub zły klucz`);
    return !POSTBACK_ENFORCE;
}

function findUserCI(name) {
    return User.findOne({ username: new RegExp(`^${escapeRegex(name)}$`, 'i') });
}

async function creditSurvey(userId, amount, txId) {
    let user = await findUserCI(userId);
    const name = user ? user.username : userId;
    const earning = new Earning({ username: name, amount, source: 'Survey', txId });
    try { await earning.save(); }
    catch (e) { if (e && e.code === 11000) return 'duplicate'; throw e; }
    try {
        if (!user) user = new User({ username: name, points: 0 });
        user.points += amount;
        await addXPAndDailyEarned(user, amount);
        allocateGoalProgress(user, amount);
        await user.save();
    } catch (e) {
        await Earning.deleteOne({ _id: earning._id }).catch(() => {});
        throw e;
    }
    await processReferralBonus(name, amount);
    return 'ok';
}

async function reverseSurvey(userId, txId, fallbackAmount) {
    const user = await findUserCI(userId);
    if (!user) return 'no_user';
    const original = await Earning.findOne({ source: 'Survey', txId: 'cpx:' + txId });
    const amount = original ? original.amount : fallbackAmount;
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SURVEY_REWARD) return 'bad_amount';

    try { await new Earning({ username: user.username, amount: -amount, source: 'Reversal', details: 'CPX Research', txId: 'cpx-rev:' + txId }).save(); }
    catch (e) { if (e && e.code === 11000) return 'duplicate'; throw e; }

    await User.updateOne({ _id: user._id }, { $inc: { points: -amount } });

    if (user.referredBy) {
        const bonus = parseFloat((amount * 0.15).toFixed(2));
        if (bonus > 0) {
            const referrer = await User.findOneAndUpdate({ username: user.referredBy }, { $inc: { points: -bonus } });
            if (referrer) await new Earning({ username: referrer.username, amount: -bonus, source: 'ReferralReversal', details: user.username }).save();
        }
    }
    return 'ok';
}

app.get('/postback', async (req, res) => {
    const userId = String(req.query.user_id || '').trim();
    const amount = parseFloat(req.query.amount_local);
    const status = String(req.query.status || '');
    const txId = String(req.query.trans_id || '').trim();

    if (!postbackAllowed(req.query.key, 'CPX')) return res.status(403).send('Forbidden');
    res.status(200).send('OK');

    if (!userId || !txId) return console.warn('[postback] CPX: brak user_id lub trans_id');
    try {
        if (status === '1') {
            if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SURVEY_REWARD) return console.warn('[postback] CPX: zła kwota');
            await creditSurvey(userId, amount, 'cpx:' + txId);
        } else if (status === '2') {
            await reverseSurvey(userId, txId, amount);
        }
    } catch (e) { console.error('[postback] CPX błąd:', e.message); }
});

app.all('/api/theoremreach-postback/:key?', async (req, res) => {
    const q = { ...(req.body || {}), ...req.query };
    const uid = String(q.user_id || q.uid || '').trim();
    const reward = parseFloat(q.reward);
    const txId = String(q.tx_id || '').trim();
    const isReversal = String(q.reversal) === 'true';
    console.log('[TR postback]', { uid, reward, tx_id: txId, reversal: q.reversal, debug: q.debug });

    if (!postbackAllowed(req.params.key, 'TheoremReach')) return res.status(403).send('0');
    if (String(q.debug) === 'true') return res.status(200).send('1');
    if (!uid || !Number.isFinite(reward)) return res.status(400).send('0');
    if (isReversal || reward <= 0) return res.status(200).send('1');
    if (reward > MAX_SURVEY_REWARD || !txId) return res.status(400).send('0');
    try { await creditSurvey(uid, reward, 'tr:' + txId); return res.status(200).send('1'); }
    catch (e) { console.error('[postback] TR błąd:', e.message); return res.status(500).send('0'); }
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
    try { const safe = escapeRegex(req.params.username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) { user = new User({ username: req.params.username.trim(), points: 0 }); await user.save(); } res.json({ points: user.points, referredBy: user.referredBy, linkedPayPal: user.linkedPayPal, verified: !!user.verified });; } catch (error) { res.json({ points: 0 }); }
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
        const period = req.query.period || '7days'; const now = new Date(); let matchStage = { source: { $nin: ['Promo', 'Admin', 'BundleDeposit', 'BundleRefund', 'BundleRejected', 'BundleDone'] } };
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

const MIN_PAYOUT = 1;

app.post('/api/withdraw', async (req, res) => {
    const paypalEmail = String(req.body.paypalEmail || req.body.payoutAddress || '').trim().toLowerCase();
    const username = String(req.body.username || '').trim();
    const pts = Math.round(Number(req.body.points) * 100) / 100;

    if (!username) return res.status(400).json({ error: 'Brak nazwy użytkownika.' });
    if (!Number.isFinite(pts) || pts < MIN_PAYOUT) return res.status(400).json({ error: `Minimalna wypłata to ${MIN_PAYOUT} R$.` });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail)) return res.status(400).json({ error: 'Nieprawidłowy adres PayPal.' });

    try {
        const safe = escapeRegex(username);
        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') });
        if (!user) return res.status(400).json({ error: 'Nie masz tylu R$!' });

        if (user.linkedPayPal && user.linkedPayPal.toLowerCase() !== paypalEmail) {
            return res.status(400).json({ error: `Konto przypisane do adresu: ${user.linkedPayPal}` });
        }

        // odejmij tylko wtedy, gdy saldo wystarcza (jedna operacja, bez wyścigu)
        const updated = await User.findOneAndUpdate(
            { _id: user._id, points: { $gte: pts } },
            { $inc: { points: -pts }, $set: { linkedPayPal: user.linkedPayPal || paypalEmail } },
            { new: true }
        );
        if (!updated) return res.status(400).json({ error: 'Nie masz tylu R$!' });

        const usdAmount = parseFloat((pts * 0.025).toFixed(2));
        const newPayout = await new Payout({
            username: updated.username, payoutMethod: 'PayPal', payoutAddress: paypalEmail,
            paypalEmail, pointsWithdrawn: pts, usdAmount, status: 'Pending Manual'
        }).save();
        discordBot.sendPayoutAlert(newPayout);
        res.json({ success: true, newBalance: updated.points, usd: usdAmount });
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
    // =================== PAKIETY (BUNDLES) ===================
const BUNDLE_CATEGORIES = { robux: 'Robux', wt: 'War Thunder' };
const BUNDLE_OFFERS = {
    robux: [
        { id: 'rb50',  title: '50 Robux',  price: 80 },
        { id: 'rb100', title: '100 Robux', price: 150 },
        { id: 'rb175', title: '175 Robux', price: 195 },
        { id: 'rb200', title: '200 Robux', price: 225 }
    ],
    wt: [
        { id: 'wt150',   title: '150 GE',   price: 50 },
        { id: 'wt1000',  title: '1000 GE',  price: 325 },
        { id: 'wt2500',  title: '2500 GE',  price: 815 },
        { id: 'wt5000',  title: '5000 GE',  price: 1250 },
        { id: 'wt10000', title: '10000 GE', price: 2440 },
        { id: 'wt25000', title: '25000 GE', price: 5620 }
    ]
};
const BUNDLE_CUSTOM = { minUsd: 10, maxUsd: 500, rsPerUsd: 44, approxRobuxPerUsd: 65.4 };
const BUNDLE_MAX_OPEN = 2;
const BUNDLE_NAME_RE = /^[A-Za-z0-9_.\-]{2,32}$/;

const toC = v => Math.round(Number(v) * 100);
const fromC = c => c / 100;
const cleanName = v => String(v || '').trim();
const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const bundleLabel = b => `${BUNDLE_CATEGORIES[b.category]} – ${b.title}`;

function resolveBundleOffer(category, offerId, customUsd) {
    if (!BUNDLE_CATEGORIES[category]) return null;
    if (category === 'robux' && offerId === 'custom') {
        const usd = Number(customUsd);
        if (!Number.isInteger(usd) || usd < BUNDLE_CUSTOM.minUsd || usd > BUNDLE_CUSTOM.maxUsd) return null;
        return { id: 'custom', title: `Custom $${usd}`, price: usd * BUNDLE_CUSTOM.rsPerUsd, customUsd: usd, approxRobux: Math.floor(usd * BUNDLE_CUSTOM.approxRobuxPerUsd) };
    }
    const offer = BUNDLE_OFFERS[category].find(o => o.id === offerId);
    return offer ? { ...offer, customUsd: 0, approxRobux: 0 } : null;
}

function bundleView(b) {
    return {
        id: String(b._id), category: b.category, categoryLabel: BUNDLE_CATEGORIES[b.category], title: b.title,
        price: fromC(b.priceC), deposited: fromC(b.depositedC),
        percent: Math.min(100, Math.round(b.depositedC / b.priceC * 1000) / 10),
        status: b.status, approxRobux: b.approxRobux || 0, createdAt: b.createdAt, paidAt: b.paidAt || null
    };
}

app.get('/api/bundles/offers', (req, res) => {
    res.json({ categories: BUNDLE_CATEGORIES, offers: BUNDLE_OFFERS, custom: BUNDLE_CUSTOM, maxOpen: BUNDLE_MAX_OPEN });
});

app.get('/api/bundles/:username', async (req, res) => {
    try {
        const user = await findUserCI(cleanName(req.params.username));
        const empty = { verified: false, profile: { robloxName: '', gaijinId: '', discordName: '' }, bundles: [], current: null };
        if (!user) return res.json(empty);
        const all = await Bundle.find({ username: user.username }).sort({ createdAt: 1 }).lean();
        const filling = all.filter(b => b.status === 'filling');
        const paid = all.filter(b => b.status === 'paid');
        const closed = all.filter(b => b.status !== 'filling' && b.status !== 'paid').reverse().slice(0, 30);
        res.json({
            verified: !!user.verified,
            profile: { robloxName: user.robloxName || '', gaijinId: user.gaijinId || '', discordName: user.discordName || '' },
            bundles: [...filling, ...paid, ...closed].map(bundleView),
            current: filling.length ? bundleView(filling[0]) : null
        });
    } catch (e) { console.error('[bundles] list:', e.message); res.json({ verified: false, profile: {}, bundles: [], current: null }); }
});

app.post('/api/bundles/create', async (req, res) => {
    try {
        const category = String(req.body.category || '');
        const offer = resolveBundleOffer(category, String(req.body.offerId || ''), req.body.customUsd);
        if (!offer) return res.status(400).json({ error: 'Nieprawidłowy pakiet.' });

        const gameId = cleanName(req.body.gameId);
        const discord = cleanName(req.body.discord);
        if (!BUNDLE_NAME_RE.test(gameId)) return res.status(400).json({ error: category === 'wt' ? 'Nieprawidłowe ID Gaijin.' : 'Nieprawidłowy nick Roblox.' });
        if (!BUNDLE_NAME_RE.test(discord)) return res.status(400).json({ error: 'Nieprawidłowa nazwa Discord.' });

        const user = await findUserCI(cleanName(req.body.username));
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });

        const gameField = category === 'wt' ? 'gaijinId' : 'robloxName';
        if (user[gameField] && !sameText(user[gameField], gameId)) return res.status(400).json({ error: `To konto ma na stałe przypisane: ${user[gameField]}. Zmiana tylko przez Support.` });
        if (user.discordName && !sameText(user.discordName, discord)) return res.status(400).json({ error: `To konto ma na stałe przypisany Discord: ${user.discordName}. Zmiana tylko przez Support.` });

        const open = await Bundle.countDocuments({ username: user.username, category, status: { $in: ['filling', 'paid'] } });
        if (open >= BUNDLE_MAX_OPEN) return res.status(400).json({ error: `Możesz mieć maksymalnie ${BUNDLE_MAX_OPEN} aktywne pakiety w tej kategorii.` });

        const set = {};
        if (!user[gameField]) set[gameField] = gameId;
        if (!user.discordName) set.discordName = discord;
        if (Object.keys(set).length) await User.updateOne({ _id: user._id }, { $set: set });

        const bundle = await new Bundle({
            username: user.username, category, offerId: offer.id, title: offer.title, priceC: toC(offer.price),
            customUsd: offer.customUsd, approxRobux: offer.approxRobux, gameId: user[gameField] || gameId, discord: user.discordName || discord
        }).save();
        res.json({ success: true, bundle: bundleView(bundle) });
    } catch (e) { console.error('[bundles] create:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/bundles/deposit', async (req, res) => {
    try {
        const user = await findUserCI(cleanName(req.body.username));
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });
        const amountC = toC(req.body.amount);
        if (!Number.isInteger(amountC) || amountC <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
        if (!mongoose.Types.ObjectId.isValid(req.body.bundleId)) return res.status(400).json({ error: 'Nieprawidłowy pakiet.' });

        const bundle = await Bundle.findOne({ _id: req.body.bundleId, username: user.username });
        if (!bundle) return res.status(404).json({ error: 'Nie znaleziono pakietu.' });
        if (bundle.status !== 'filling') return res.status(400).json({ error: 'Ten pakiet jest już opłacony lub zamknięty.' });
        const remainingC = bundle.priceC - bundle.depositedC;
        if (amountC > remainingC) return res.status(400).json({ error: `Do pełnej kwoty pakietu brakuje ${fromC(remainingC).toFixed(2)} R$.` });

        const amount = fromC(amountC);
        const charged = await User.findOneAndUpdate({ _id: user._id, points: { $gte: amount } }, { $inc: { points: -amount } }, { new: true });
        if (!charged) return res.status(400).json({ error: 'Nie masz tylu R$!' });
        await new Earning({ username: user.username, amount: -amount, source: 'BundleDeposit', details: bundleLabel(bundle) }).save();

        const filled = await Bundle.findOneAndUpdate(
            { _id: bundle._id, status: 'filling', depositedC: { $lte: bundle.priceC - amountC } },
            { $inc: { depositedC: amountC } }, { new: true }
        );
        if (!filled) {
            await User.updateOne({ _id: user._id }, { $inc: { points: amount } });
            await new Earning({ username: user.username, amount: amount, source: 'BundleRefund', details: bundleLabel(bundle) }).save();
            return res.status(400).json({ error: 'Pakiet właśnie się zmienił, spróbuj ponownie.' });
        }

        let current = filled;
        if (filled.depositedC >= filled.priceC) {
            const paidBundle = await Bundle.findOneAndUpdate(
                { _id: bundle._id, status: 'filling', depositedC: { $gte: bundle.priceC } },
                { $set: { status: 'paid', paidAt: new Date() } }, { new: true }
            );
            if (paidBundle) {
                current = paidBundle;
                try { if (typeof discordBot.sendBundleAlert === 'function') await discordBot.sendBundleAlert(paidBundle, charged); }
                catch (err) { console.error('[bundles] alert Discord:', err.message); }
            }
        }
        res.json({ success: true, newBalance: charged.points, bundle: bundleView(current) });
    } catch (e) { console.error('[bundles] deposit:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/bundles/withdraw', async (req, res) => {
    try {
        const user = await findUserCI(cleanName(req.body.username));
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });
        if (!mongoose.Types.ObjectId.isValid(req.body.bundleId)) return res.status(400).json({ error: 'Nieprawidłowy pakiet.' });
        const bundle = await Bundle.findOne({ _id: req.body.bundleId, username: user.username });
        if (!bundle) return res.status(404).json({ error: 'Nie znaleziono pakietu.' });
        if (bundle.status !== 'filling') return res.status(400).json({ error: 'Z opłaconego pakietu nie można wycofać R$.' });

        let refundC = 0;
        if (req.body.cancel === true) {
            const old = await Bundle.findOneAndUpdate({ _id: bundle._id, status: 'filling' }, { $set: { status: 'canceled', doneAt: new Date() } });
            if (!old) return res.status(400).json({ error: 'Pakiet właśnie się zmienił, spróbuj ponownie.' });
            refundC = old.depositedC;
        } else {
            const amountC = toC(req.body.amount);
            if (!Number.isInteger(amountC) || amountC <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
            const dec = await Bundle.findOneAndUpdate({ _id: bundle._id, status: 'filling', depositedC: { $gte: amountC } }, { $inc: { depositedC: -amountC } });
            if (!dec) return res.status(400).json({ error: 'Tyle nie masz wpłacone w tym pakiecie.' });
            refundC = amountC;
        }

        let newBalance = user.points;
        if (refundC > 0) {
            const refund = fromC(refundC);
            const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { points: refund } }, { new: true });
            newBalance = updated.points;
            await new Earning({ username: user.username, amount: refund, source: 'BundleRefund', details: bundleLabel(bundle) }).save();
        }
        res.json({ success: true, refunded: fromC(refundC), newBalance });
    } catch (e) { console.error('[bundles] withdraw:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/admin/set-verified', isAdmin, async (req, res) => {
    try {
        const user = await findUserCI(cleanName(req.body.username));
        if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza.' });
        const verified = req.body.verified === true;
        await User.updateOne({ _id: user._id }, { $set: { verified } });
        res.json({ success: true, username: user.username, verified });
    } catch (e) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.get('/api/admin/bundle-users', isAdmin, async (req, res) => {
    try {
        const users = await User.find({ discordName: { $exists: true, $nin: ['', null] } })
            .select('username verified robloxName gaijinId discordName').sort({ verified: 1, username: 1 }).limit(200).lean();
        res.json(users);
    } catch (e) { res.status(500).json([]); }
});
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