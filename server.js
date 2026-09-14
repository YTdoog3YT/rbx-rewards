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
    referredBy: { type: String, default: null },
    referredUsers: { type: [String], default: [] },
    redeemedPromoCodes: { type: [{ code: String, reward: Number, date: { type: Date, default: Date.now } }], default: [] },
    // 🔥 Skrzynka odbiorcza dla Supportu
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

app.get('/postback', async (req, res) => { /* Stary kod CPX - zostaje bez zmian */ res.status(200).send('OK'); });
app.all('/api/theoremreach-postback', async (req, res) => { /* Stary kod TR */ res.status(200).send('1'); });
app.all('/api/jitscape-postback', async (req, res) => { /* Stary kod Jitscape */ res.status(200).send('OK'); });

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

// 🔥 NOWOŚĆ: Pobieranie powiadomień ze skrzynki odbiorczej
app.get('/api/inbox/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: new RegExp(`^${req.params.username}$`, 'i') });
        if (!user) return res.json([]);
        const unread = user.inbox.filter(msg => !msg.read);
        
        // Zaznaczamy jako przeczytane, żeby nie spamować po odświeżeniu strony
        if (unread.length > 0) {
            user.inbox.forEach(msg => msg.read = true);
            await user.save();
        }
        res.json(unread);
    } catch (error) { res.json([]); }
});

app.post('/api/support-ticket', async (req, res) => {
    try {
        const { username, contact, message } = req.body;
        if (!username || !message) return res.status(400).json({ error: 'Brak wymaganych danych.' });
        // Przekazanie do nowego bota
        discordBot.sendTicketAlert(username, contact, message);
        return res.json({ success: true, message: 'Ticket pomyślnie wysłany!' });
    } catch (error) { return res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/withdraw', async (req, res) => {
    const { username, paypalEmail, points } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || user.points < points) return res.status(400).json({ error: 'Nie masz tylu Robuxów!' });
        
        const usdAmount = parseFloat((points * 0.025).toFixed(2)); 
        user.points -= points; await user.save();
        
        const newPayout = await new Payout({ username, paypalEmail, pointsWithdrawn: points, usdAmount, status: 'Pending Manual' }).save();

        // Przekazanie wiadomości z guzikami do modułu bota!
        discordBot.sendPayoutAlert(newPayout);
        res.json({ success: true, newBalance: user.points, usd: usdAmount });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

// Zostawiam resztę API dla kodów promocyjnych...
app.post('/api/redeem-promo', async (req, res) => { /* kod na promo... to samo co było */ });
app.post('/api/redeem-code', async (req, res) => { /* kod poleceń... to samo co było */ });

io.on('connection', (socket) => { socket.on('chatMessage', (data) => { io.emit('chatMessage', data); }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Serwer śmiga na porcie ${PORT}`); });

// Odpalenie zewnętrznego bota po załadowaniu serwera
if (discordClient) {
    discordClient.once('ready', () => { 
        console.log(`🤖 Bot Discord (${discordClient.user.tag}) zoptymalizowany i połączony!`); 
        discordBot.init(discordClient, dbModels); 
    });
    discordClient.login(DISCORD_BOT_TOKEN).catch(console.error);
}