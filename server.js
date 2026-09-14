const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');
const { Server } = require('socket.io');

// Ładujemy nasz nowy moduł bota
const discordBot = require('./discord-bot');

const PAYPAL_CLIENT_ID = "BAAGR8OP_rMS5K6OGviXl4mHaC4_1YBS8BK2pHeBgjMujM7ac5RgPcFwZYJOeSnIRpgypw6hqn3cEeKSPE";
const PAYPAL_SECRET = "ELOtGxTd_DhXSkDOu3F7wjEQBjUa2DTw0JIGTa5L58GKFyQ2FFkPNlIL-tBReV-Jrd1iIxxpC_3XiJOT";
const PAYPAL_API_BASE = "https://api-m.paypal.com";

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

const MONGO_URI = 'mongodb+srv://contactcatlover_db_user:E8zvsX5pv1oMtKNE@robux.h3weh54.mongodb.net/?appName=Robux';

mongoose.connect(MONGO_URI).then(() => console.log('✅ Baza MongoDB gotowa!')).catch(err => console.error(err));

// --- BAZA DANYCH ---
const UserSchema = new mongoose.Schema({
    username: String,
    points: { type: Number, default: 0 },
    lastDailyReward: { type: Date, default: null },
    referredBy: { type: String, default: null },
    streak: { type: Number, default: 0 },
    referredUsers: { type: [String], default: [] },
    bonusClicksToday: { type: Number, default: 0 },
    lastBonusClickDate: { type: Date, default: null },
    redeemedPromoCodes: { type: [{ code: String, reward: Number, date: { type: Date, default: Date.now } }], default: [] },
    inbox: { type: [{ message: String, date: { type: Date, default: Date.now }, read: { type: Boolean, default: false } }], default: [] }
});
const User = mongoose.model('User', UserSchema);

const EarningSchema = new mongoose.Schema({ username: String, amount: Number, source: { type: String, default: 'Survey' }, details: { type: String, default: '' }, createdAt: { type: Date, default: Date.now } });
const Earning = mongoose.model('Earning', EarningSchema);

const PayoutSchema = new mongoose.Schema({ username: String, paypalEmail: String, pointsWithdrawn: Number, usdAmount: Number, status: { type: String, default: 'Completed' }, createdAt: { type: Date, default: Date.now } });
const Payout = mongoose.model('Payout', PayoutSchema);

const PromoCodeSchema = new mongoose.Schema({ code: { type: String, unique: true, uppercase: true }, reward: Number, maxUses: Number, currentUses: { type: Number, default: 0 }, usedBy: [String] });
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);

const dbModels = { User, Earning, Payout, PromoCode };

// --- LOGIKA BIZNESOWA ---
async function processReferralBonus(username, amountEarned) {
    try {
        const user = await User.findOne({ username: username });
        if (user && user.referredBy) {
            const bonus = parseFloat((amountEarned * 0.15).toFixed(2));
            const referrer = await User.findOne({ username: user.referredBy });
            if (referrer) {
                referrer.points += bonus; await referrer.save();
                await new Earning({ username: referrer.username, amount: bonus, source: 'Referral', details: username }).save();
            }
        }
    } catch (err) {}
}

app.get('/postback', async (req, res) => {
    const userId = req.query.user_id; const amount = parseFloat(req.query.amount_local); const status = req.query.status;
    res.status(200).send('OK');
    if ((status === '1' || status === '2') && userId && amount) {
        try {
            let user = await User.findOne({ username: userId });
            if (!user) user = new User({ username: userId, points: 0 });
            user.points += amount; await user.save();
            await new Earning({ username: userId, amount: amount, source: 'Survey' }).save();
            await processReferralBonus(userId, amount);
        } catch (error) {}
    }
});

app.all('/api/theoremreach-postback', async (req, res) => {
    const uid = req.query.user_id || req.body.user_id || req.query.uid || req.body.uid;
    const reward = parseFloat(req.query.reward || req.body.reward);
    const isReversal = req.query.reversal === 'true' || req.query.reversal === true;

    if (!uid || isNaN(reward)) return res.status(400).send('0');
    if (isReversal) return res.status(200).send('1');

    if (reward > 0) {
        try {
            let user = await User.findOne({ username: uid });
            if (!user) user = new User({ username: uid, points: 0 });
            user.points += reward;
            await user.save();
            await new Earning({ username: uid, amount: reward, source: 'Survey' }).save();
            await processReferralBonus(uid, reward);
            return res.status(200).send('1');
        } catch (error) { return res.status(500).send('0'); }
    }
    res.status(200).send('1');
});

app.all('/api/jitscape-postback', async (req, res) => {
    const data = req.method === 'POST' ? req.body : req.query;
    if (!data.txId || data.amountMilliCents === undefined || !data.userId || !data.signature) return res.status(400).send('Missing data');
    const JITSCAPE_SECRET = "vrx_pub_OnJTafRy9KWQMss5eJCVfdas6Rsn9Y7Z";
    if (data.signature !== crypto.createHmac('sha256', JITSCAPE_SECRET).update(`${data.txId}:${data.amountMilliCents}:${data.userId}`).digest('hex')) return res.status(400).send('Invalid sig');
    if (data.amountMilliCents == 0) return res.status(200).send('Test OK');
    res.status(200).send('OK');
    const pointsToAward = parseFloat(((data.amountMilliCents / 100000) * 15).toFixed(2));
    try {
        let user = await User.findOne({ username: data.userId });
        if (!user) user = new User({ username: data.userId, points: 0 });
        user.points += pointsToAward; await user.save();
        await new Earning({ username: data.userId, amount: pointsToAward, source: 'Survey' }).save();
        await processReferralBonus(data.userId, pointsToAward);
    } catch (error) {}
});

app.get('/api/points/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        res.json({ points: user ? user.points : 0, referredBy: user ? user.referredBy : null });
    } catch (error) { res.json({ points: 0 }); }
});

app.get('/api/latest-earners', async (req, res) => { try { res.json(await Earning.find().sort({ createdAt: -1 }).limit(5)); } catch (e) { res.json([]); } });
app.get('/api/latest-payouts', async (req, res) => { try { res.json(await Payout.find({ status: 'Completed' }).sort({ createdAt: -1 }).limit(5)); } catch (e) { res.json([]); } });

app.get('/api/earning-history/:username', async (req, res) => {
    try {
        const regex = new RegExp(`^${req.params.username}$`, 'i');
        const earnings = await Earning.find({ username: regex }).lean();
        const payouts = await Payout.find({ username: regex }).lean();
        const combined = [...earnings.map(e => ({ ...e, recordType: 'earning' })), ...payouts.map(p => ({ ...p, recordType: 'payout' }))];
        combined.sort((a, b) => b.createdAt - a.createdAt);
        res.json(combined.slice(0, 100));
    } catch (error) { res.status(500).json({ error: "Error" }); }
});

// POBIERANIE SKRZYNKI
app.get('/api/inbox/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: new RegExp(`^${req.params.username}$`, 'i') });
        if (!user) return res.json([]);
        const unread = user.inbox.filter(msg => !msg.read);
        
        if (unread.length > 0) {
            user.inbox.forEach(msg => msg.read = true);
            await user.save();
        }
        res.json(unread);
    } catch (error) { res.json([]); }
});

// TICKET
app.post('/api/support-ticket', async (req, res) => {
    try {
        const { username, contact, message } = req.body;
        if (!username || !message) return res.status(400).json({ error: 'Brak wymaganych danych.' });
        discordBot.sendTicketAlert(username, contact, message);
        return res.json({ success: true, message: 'Ticket pomyślnie wysłany!' });
    } catch (error) { return res.status(500).json({ error: 'Błąd serwera.' }); }
});

// WYPŁATA
app.post('/api/withdraw', async (req, res) => {
    const { username, paypalEmail, points } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || user.points < points) return res.status(400).json({ error: 'Nie masz tylu Robuxów!' });
        
        const usdAmount = parseFloat((points * 0.025).toFixed(2)); 
        user.points -= points; await user.save();
        
        const newPayout = await new Payout({ username, paypalEmail, pointsWithdrawn: points, usdAmount, status: 'Pending Manual' }).save();

        discordBot.sendPayoutAlert(newPayout);
        res.json({ success: true, newBalance: user.points, usd: usdAmount });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

// KODY PROMOCYJNE
app.post('/api/redeem-promo', async (req, res) => {
    const { username, promoCode } = req.body;
    if (!username || !promoCode) return res.status(400).json({ error: 'Brak danych.' });
    try {
        const promo = await PromoCode.findOne({ code: promoCode.toUpperCase() });
        if (!promo) return res.status(404).json({ error: 'Ten kod nie istnieje lub wygasł.' });
        if (promo.currentUses >= promo.maxUses) return res.status(400).json({ error: 'Kod został w pełni wyczerpany!' });
        if (promo.usedBy.includes(username)) return res.status(400).json({ error: 'Już użyłeś tego kodu!' });

        let user = await User.findOne({ username });
        if (!user) user = new User({ username, points: 0, streak: 0 });

        user.points += promo.reward;
        if (!user.redeemedPromoCodes) user.redeemedPromoCodes = [];
        user.redeemedPromoCodes.push({ code: promo.code, reward: promo.reward, date: new Date() });
        await user.save();

        promo.currentUses += 1; promo.usedBy.push(username); await promo.save();
        await new Earning({ username, amount: promo.reward, source: 'Promo', details: promo.code }).save();
        await processReferralBonus(username, promo.reward);

        res.json({ success: true, newBalance: user.points, message: `Odebrano ${promo.reward} Robuxów z kodu!` });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

// PRZYWRÓCONA ŚCIEŻKA (Historia Promokodów)
app.get('/api/promo-history/:username', async (req, res) => {
    try {
        const username = req.params.username; const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
        if (!user) return res.status(404).json({ error: "User not found" });
        const history = user.redeemedPromoCodes || [];
        history.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(history);
    } catch (error) { res.status(500).json({ error: "Internal server error" }); }
});

// POLECENIA
app.post('/api/redeem-code', async (req, res) => {
    const { username, code } = req.body;
    if (!username || !code) return res.status(400).json({ error: 'Missing data.' });
    if (username.toLowerCase() === code.toLowerCase()) return res.status(400).json({ error: "Can't refer yourself!" });
    try {
        let user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
        if (!user) user = new User({ username: username, points: 0 });
        if (user.referredBy) return res.status(400).json({ error: 'Already used referral code!' });
        let referrer = await User.findOne({ username: new RegExp(`^${code}$`, 'i') });
        if (!referrer) return res.status(404).json({ error: 'Referral not found.' });
        user.referredBy = referrer.username; await user.save();
        if (!referrer.referredUsers.includes(user.username)) { referrer.referredUsers.push(user.username); await referrer.save(); }
        res.json({ success: true, message: 'Code activated!' });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

// PRZYWRÓCONA ŚCIEŻKA (Statystyki Referrali)
app.get('/api/referral-stats/:username', async (req, res) => {
    try {
        const username = req.params.username; const period = req.query.period || '7days';
        let startDate = new Date(0); let endDate = new Date(); const now = new Date();
        if (period === 'today') { startDate = new Date(now.setHours(0, 0, 0, 0)); } 
        else if (period === 'yesterday') { const yesterdayStart = new Date(); yesterdayStart.setDate(yesterdayStart.getDate() - 1); startDate = new Date(yesterdayStart.setHours(0, 0, 0, 0)); const yesterdayEnd = new Date(); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1); yesterdayEnd.setHours(23, 59, 59, 999); endDate = yesterdayEnd; } 
        else if (period === '7days') { startDate = new Date(now.setDate(now.getDate() - 7)); } 
        else if (period === '30days') { startDate = new Date(now.setDate(now.getDate() - 30)); }

        const referredDocs = await User.find({ referredBy: new RegExp(`^${username}$`, 'i') });
        const referredUsernames = referredDocs.map(u => u.username);
        if (referredUsernames.length === 0) return res.json([]);

        const earnings = await Earning.aggregate([
            { $match: { username: { $in: referredUsernames }, createdAt: { $gte: startDate, $lte: endDate } } },
            { $group: { _id: "$username", totalEarned: { $sum: "$amount" } } }
        ]);
        const finalStats = referredUsernames.map(ru => {
            const found = earnings.find(e => e._id === ru);
            return { username: ru, earned: found ? found.totalEarned * 0.15 : 0 };
        });
        finalStats.sort((a, b) => b.earned - a.earned);
        res.json(finalStats); 
    } catch (error) { res.json([]); }
});

io.on('connection', (socket) => { socket.on('chatMessage', (data) => { io.emit('chatMessage', data); }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Serwer śmiga na porcie ${PORT}`); });

if (discordClient) {
    discordClient.once('ready', () => { 
        console.log(`🤖 Bot Discord (${discordClient.user.tag}) zoptymalizowany i połączony!`); 
        discordBot.init(discordClient, dbModels); 
    });
    discordClient.login(DISCORD_BOT_TOKEN).catch(console.error);
}