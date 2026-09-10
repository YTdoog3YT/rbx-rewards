const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');
const { Server } = require('socket.io');

// -----------------------------------------------------
// 🤖 KONFIGURACJA BOTA DISCORD
// -----------------------------------------------------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ADMIN_DISCORD_ID = "398911896893521921";

console.log("🔥 Czy serwer widzi token?", DISCORD_BOT_TOKEN ? "TAK, JEST!" : "NIE, PUSTO!");

let discordClient = null;
if (DISCORD_BOT_TOKEN) {
    discordClient = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });
}

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } }); 

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = 'mongodb+srv://contactcatlover_db_user:E8zvsX5pv1oMtKNE@robux.h3weh54.mongodb.net/?appName=Robux';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Baza MongoDB podłączona pancernie!'))
    .catch(err => console.error('❌ Błąd bazy:', err));

const UserSchema = new mongoose.Schema({
    username: String,
    points: { type: Number, default: 0 },
    lastDailyReward: { type: Date, default: null },
    referredBy: { type: String, default: null },
    streak: { type: Number, default: 0 },
    referredUsers: { type: [String], default: [] },
    bonusClicksToday: { type: Number, default: 0 },
    lastBonusClickDate: { type: Date, default: null },
    redeemedPromoCodes: { 
        type: [{ code: String, reward: Number, date: { type: Date, default: Date.now } }], 
        default: [] 
    }
});
const User = mongoose.model('User', UserSchema);

const EarningSchema = new mongoose.Schema({
    username: String,
    amount: Number,
    createdAt: { type: Date, default: Date.now }
});
const Earning = mongoose.model('Earning', EarningSchema);

const PayoutSchema = new mongoose.Schema({
    username: String,
    paypalEmail: String,
    pointsWithdrawn: Number,
    usdAmount: Number,
    status: { type: String, default: 'Pending' },
    createdAt: { type: Date, default: Date.now }
});
const Payout = mongoose.model('Payout', PayoutSchema);

const PromoCodeSchema = new mongoose.Schema({
    code: { type: String, unique: true, uppercase: true },
    reward: Number,
    maxUses: Number,
    currentUses: { type: Number, default: 0 },
    usedBy: [String] 
});
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);

async function processReferralBonus(username, amountEarned) {
    try {
        const user = await User.findOne({ username: username });
        if (user && user.referredBy) {
            const bonus = parseFloat((amountEarned * 0.15).toFixed(2));
            const referrer = await User.findOne({ username: user.referredBy });
            if (referrer) {
                referrer.points += bonus;
                await referrer.save();
            }
        }
    } catch (err) { console.error("Błąd 15%:", err); }
}

app.get('/postback', async (req, res) => {
    const userId = req.query.user_id; const amount = parseFloat(req.query.amount_local); const status = req.query.status;
    res.status(200).send('OK'); 
    if ((status === '1' || status === '2') && userId && amount) {
        try {
            let user = await User.findOne({ username: userId });
            if (!user) user = new User({ username: userId, points: 0 });
            user.points += amount; await user.save();
            await new Earning({ username: userId, amount: amount }).save();
            await processReferralBonus(userId, amount);
        } catch (error) {}
    }
});

app.get('/api/points/:username', async (req, res) => {
    try {
        const username = req.params.username;
        const user = await User.findOne({ username: username });
        const referredDocs = await User.find({ referredBy: new RegExp(`^${username}$`, 'i') });
        const allReferredUsernames = referredDocs.map(u => u.username);
        res.json({ 
            points: user ? user.points : 0, 
            lastDailyReward: user ? user.lastDailyReward : null, 
            referredBy: user ? user.referredBy : null, 
            streak: user ? (user.streak || 0) : 0,
            referredUsers: allReferredUsernames
        });
    } catch (error) { res.json({ points: 0, lastDailyReward: null, referredBy: null, streak: 0, referredUsers: [] }); }
});

app.get('/api/latest-earners', async (req, res) => {
    try { res.json(await Earning.find().sort({ createdAt: -1 }).limit(5)); } catch (error) { res.json([]); }
});

app.get('/api/latest-payouts', async (req, res) => {
    try { res.json(await Payout.find().sort({ createdAt: -1 }).limit(5)); } catch (error) { res.json([]); }
});

// 🔥 SYSTEM TICKETÓW
app.post('/api/support-ticket', async (req, res) => {
    try {
        const { username, message } = req.body;
        if (!username || !message) return res.status(400).json({ error: 'Brak wymaganych danych w formularzu.' });
        
        if (discordClient && discordClient.isReady()) {
            const targetChannel = discordClient.channels.cache.find(c => c.name === 'support-tickets');
            if (targetChannel && targetChannel.isTextBased()) {
                await targetChannel.send(`🚨 **NOWY TICKET ZGŁOSZENIOWY** 🚨\n👤 **Od Gracza:** \`${username}\`\n📝 **Wiadomość:**\n> ${message}`);
                return res.json({ success: true, message: 'Ticket pomyślnie wysłany do Administracji!' });
            } else {
                return res.status(500).json({ error: 'Błąd konfiguracji: Bot Discord nie widzi kanału "support-tickets".' });
            }
        }
        return res.status(500).json({ error: 'Bot Discord jest obecnie offline.' });
    } catch (error) {
        return res.status(500).json({ error: 'Wewnętrzny błąd serwera. Spróbuj ponownie później.' });
    }
});

// 🔥 PRZELICZNIK WYPŁAT (Z KURSEM WALUT NA ŻYWO)
app.post('/api/withdraw', async (req, res) => {
    const { username, paypalEmail, points } = req.body;
    if (!username || !paypalEmail || !points || points <= 0) return res.status(400).json({ error: 'Invalid data.' });
    try {
        const user = await User.findOne({ username: username });
        if (!user || user.points < points) return res.status(400).json({ error: 'Not enough Robux!' });
        
        user.points -= points; 
        await user.save();
        const usdAmount = parseFloat((points * 0.025).toFixed(2)); 
        await new Payout({ username, paypalEmail, pointsWithdrawn: points, usdAmount }).save();

        if (discordClient && discordClient.isReady()) {
            try {
                // Pobieranie aktualnego kursu dolara i szacowanie stawki PayPal
                let plnText = "";
                try {
                    const rateRes = await fetch('https://open.er-api.com/v6/latest/USD');
                    const rateData = await rateRes.json();
                    if (rateData && rateData.rates && rateData.rates.PLN) {
                        const marketRate = rateData.rates.PLN;
                        const paypalEstimatedRate = marketRate * 0.965; // Odejmowanie ~3.5% złodziejskiej prowizji PayPala
                        const plnAmount = (usdAmount * paypalEstimatedRate).toFixed(2);
                        plnText = ` - ~${plnAmount} zł`;
                    }
                } catch (apiErr) {
                    console.log("Brak połączenia z API walutowym, wysyłam same dolary na Discorda.");
                }

                const targetChannel = discordClient.channels.cache.find(c => c.name === 'robux');
                if (targetChannel && targetChannel.isTextBased()) {
                    await targetChannel.send(`💸 **NOWA WYPŁATA ZLECONA!**\n👤 Gracz: **${username}**\n💰 Kwota: **${points} R$** ($${usdAmount}${plnText})\n📧 E-mail (PayPal): **${paypalEmail}**`);
                }
            } catch (err) { console.error("Błąd powiadomienia Discord (Wypłata):", err); }
        }
        res.json({ success: true, newBalance: user.points, usd: usdAmount });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
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
        await new Earning({ username: data.userId, amount: pointsToAward }).save();
        await processReferralBonus(data.userId, pointsToAward);
    } catch (error) {}
});

app.post('/api/daily-reward', async (req, res) => { /* wyłączone */ });
app.post('/api/bonus-click', async (req, res) => { /* wyłączone */ });

app.post('/api/redeem-code', async (req, res) => {
    const { username, code } = req.body;
    if (!username || !code) return res.status(400).json({ error: 'Missing data.' });
    if (username.toLowerCase() === code.toLowerCase()) return res.status(400).json({ error: "Can't refer yourself!" });
    try {
        let user = await User.findOne({ username });
        if (!user) user = new User({ username: username, points: 0 });
        if (user.referredBy) return res.status(400).json({ error: 'Already used referral code!' });
        let referrer = await User.findOne({ username: new RegExp(`^${code}$`, 'i') });
        if (!referrer) return res.status(404).json({ error: 'Referral not found.' });
        user.referredBy = referrer.username; await user.save();
        if (!referrer.referredUsers.includes(user.username)) { referrer.referredUsers.push(user.username); await referrer.save(); }
        res.json({ success: true, message: 'Code activated!' });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

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
        await new Earning({ username, amount: promo.reward }).save();
        await processReferralBonus(username, promo.reward);

        res.json({ success: true, newBalance: user.points, message: `Odebrano ${promo.reward} Robuxów z kodu!` });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.get('/api/promo-history/:username', async (req, res) => {
    try {
        const username = req.params.username; const user = await User.findOne({ username: username });
        if (!user) return res.status(404).json({ error: "User not found" });
        const history = user.redeemedPromoCodes || [];
        history.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(history);
    } catch (error) { res.status(500).json({ error: "Internal server error" }); }
});

io.on('connection', (socket) => {
    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Serwer śmiga na porcie ${PORT}`); });

if (discordClient) {
    discordClient.on('messageCreate', async message => {
        if (message.author.bot) return;
        const cmd = message.content.split(' ')[0].toLowerCase();
        const allowedCommands = ['!kod', '!kody', '!usunkod', '!resetdaily', '!komendy'];
        if (allowedCommands.includes(cmd)) {
            if (message.author.id !== ADMIN_DISCORD_ID) return message.reply('❌ Brak uprawnień! Tylko Właściciel może zarządzać tą stroną.');
        } else { return; }

        if (cmd === '!komendy') {
            const helpText = `
**🛠️ PANEL ADMINISTRATORA - DOSTĘPNE KOMENDY:**
🔹 \`!kod <NAZWA> <PUNKTY> <MAX_OSÓB>\`
🔹 \`!kody\`
🔹 \`!usunkod <NAZWA_KODU>\`
🔹 \`!resetdaily <NICK_ROBLOX>\`
🔹 \`!komendy\`
            `;
            return message.reply(helpText);
        }

        if (cmd === '!kod') {
            const args = message.content.split(' ');
            if (args.length !== 4) return message.reply('⚠️ Poprawne użycie: `!kod <NAZWA> <PUNKTY> <MAX_OSÓB>`');
            const codeName = args[1].toUpperCase(); const reward = parseFloat(args[2]); const maxUses = parseInt(args[3]);
            if (isNaN(reward) || isNaN(maxUses)) return message.reply('❌ Robuxy i max użyć muszą być liczbą!');
            try {
                let existing = await PromoCode.findOne({ code: codeName });
                if (existing) {
                    if (existing.currentUses >= existing.maxUses) {
                        existing.reward = reward; existing.maxUses = maxUses; existing.currentUses = 0; existing.usedBy = []; 
                        await existing.save();
                        return message.reply(`♻️ **Wyczerpany kod został odnowiony!**\n🎫 Nazwa kodu: **${codeName}**\n💰 Nowa wartość: **${reward} R$**\n👥 Nowy limit osób: **${maxUses}**`);
                    } else {
                        return message.reply(`❌ Ten kod wciąż jest aktywny (${existing.currentUses}/${existing.maxUses} użyć)! Jeśli koniecznie chcesz go nadpisać, usuń go najpierw komendą \`!usunkod ${codeName}\`.`);
                    }
                }
                const newPromo = new PromoCode({ code: codeName, reward: reward, maxUses: maxUses });
                await newPromo.save();
                message.reply(`✅ **Kod utworzony pomyślnie!**\n🎫 Nazwa kodu: **${codeName}**\n💰 Wartość: **${reward} R$**\n👥 Limit osób: **${maxUses}**`);
            } catch (err) { message.reply('❌ Wystąpił błąd podczas zapisywania kodu.'); }
        }

        if (cmd === '!kody') {
            try {
                const activeCodes = await PromoCode.find({ $expr: { $lt: ["$currentUses", "$maxUses"] } });
                if (activeCodes.length === 0) return message.reply('📭 Brak aktywnych kodów w bazie danych.');
                let responseText = '📋 **Lista aktywnych kodów promocyjnych:**\n';
                activeCodes.forEach(p => { responseText += `🎫 **${p.code}** ➔ 💰 **${p.reward} R$** ➔ 👥 Użycia: **${p.currentUses} / ${p.maxUses}**\n`; });
                message.reply(responseText);
            } catch (err) { message.reply('❌ Wystąpił błąd podczas pobierania listy kodów.'); }
        }

        if (cmd === '!usunkod') {
            const args = message.content.split(' ');
            if (args.length !== 2) return message.reply('⚠️ Poprawne użycie: `!usunkod <NAZWA_KODU>`');
            const codeName = args[1].toUpperCase();
            try {
                const deleted = await PromoCode.findOneAndDelete({ code: codeName });
                if (!deleted) return message.reply(`❌ Nie znaleziono aktywnego kodu o nazwie **${codeName}**.`);
                message.reply(`🗑️ Kod **${codeName}** został pomyślnie usunięty z bazy!`);
            } catch (err) { message.reply('❌ Wystąpił błąd podczas usuwania kodu.'); }
        }
    });

    discordClient.once('ready', () => { console.log(`🤖 Bot Discord (${discordClient.user.tag}) połączony i zarządza kodami!`); });
    discordClient.login(DISCORD_BOT_TOKEN).catch(console.error);
}