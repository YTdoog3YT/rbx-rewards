const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');

// -----------------------------------------------------
// 🤖 KONFIGURACJA BOTA DISCORD
// -----------------------------------------------------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ADMIN_DISCORD_ID = "398911896893521921";

console.log("🔥 Czy serwer widzi token?", DISCORD_BOT_TOKEN ? "TAK, JEST!" : "NIE, PUSTO!");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = 'mongodb+srv://contactcatlover_db_user:E8zvsX5pv1oMtKNE@robux.h3weh54.mongodb.net/?appName=Robux';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Baza MongoDB podłączona pancernie!'))
    .catch(err => console.error('❌ Błąd bazy:', err));

// SCHEMATY
const UserSchema = new mongoose.Schema({
    username: String,
    points: { type: Number, default: 0 },
    lastDailyReward: { type: Date, default: null },
    referredBy: { type: String, default: null },
    streak: { type: Number, default: 0 },
    referredUsers: { type: [String], default: [] }
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

// NALICZANIE 15% DLA POLECAJĄCEGO
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

// ENDPOINTY REKLAM I PUNKTÓW
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
    } catch (error) { 
        res.json({ points: 0, lastDailyReward: null, referredBy: null, streak: 0, referredUsers: [] }); 
    }
});

app.get('/api/latest-earners', async (req, res) => {
    try { res.json(await Earning.find().sort({ createdAt: -1 }).limit(5)); } catch (error) { res.json([]); }
});

app.post('/api/withdraw', async (req, res) => {
    const { username, paypalEmail, points } = req.body;
    if (!username || !paypalEmail || !points || points <= 0) return res.status(400).json({ error: 'Invalid data.' });
    try {
        const user = await User.findOne({ username: username });
        if (!user || user.points < points) return res.status(400).json({ error: 'Not enough points!' });
        user.points -= points; await user.save();
        const usdAmount = points * 0.0001;
        await new Payout({ username, paypalEmail, pointsWithdrawn: points, usdAmount }).save();
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
    const pointsToAward = parseFloat(((data.amountMilliCents / 1000) * 50).toFixed(2));
    try {
        let user = await User.findOne({ username: data.userId });
        if (!user) user = new User({ username: data.userId, points: 0 });
        user.points += pointsToAward; await user.save();
        await new Earning({ username: data.userId, amount: pointsToAward }).save();
        await processReferralBonus(data.userId, pointsToAward);
    } catch (error) {}
});

app.post('/api/daily-reward', async (req, res) => {
    const { username } = req.body; if (!username) return res.status(400).json({ error: 'Missing username.' });
    try {
        let user = await User.findOne({ username: username });
        if (!user) user = new User({ username: username, points: 0, streak: 0 });
        const now = new Date(); let currentStreak = user.streak || 0;
        if (user.lastDailyReward) {
            const timeDiff = now - user.lastDailyReward;
            if (timeDiff < 86400000) return res.status(400).json({ error: `Wait 24h!` });
            else if (timeDiff <= 172800000) currentStreak += 1;
            else currentStreak = 1;
        } else { currentStreak = 1; }
        const rewardPoints = 10; user.points += rewardPoints; user.lastDailyReward = now; user.streak = currentStreak;
        await user.save();
        await new Earning({ username: username, amount: rewardPoints }).save();
        await processReferralBonus(username, rewardPoints);
        res.json({ success: true, newBalance: user.points, message: `Received ${rewardPoints} points!` });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

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
        
        user.referredBy = referrer.username; 
        await user.save();

        if (!referrer.referredUsers.includes(user.username)) {
            referrer.referredUsers.push(user.username);
            await referrer.save();
        }

        res.json({ success: true, message: 'Code activated!' });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

// 🔥 TUTAJ WJECHAŁA NAPRAWA DLA index.html
app.get('/api/referral-stats/:username', async (req, res) => {
    try {
        const username = req.params.username;
        const referredDocs = await User.find({ referredBy: new RegExp(`^${username}$`, 'i') });
        
        const stats = referredDocs.map(user => {
            return {
                username: user.username,
                earned: user.points * 0.15 
            };
        });

        res.json(stats); 
    } catch (error) {
        console.error("Błąd pobierania poleconych:", error);
        res.json([]);
    }
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
        await user.save();

        promo.currentUses += 1;
        promo.usedBy.push(username);
        await promo.save();

        await new Earning({ username, amount: promo.reward }).save();
        await processReferralBonus(username, promo.reward);

        res.json({ success: true, newBalance: user.points, message: `Odebrano ${promo.reward} punktów z kodu!` });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Serwer śmiga na porcie ${PORT}`); });

// -----------------------------------------------------
// LOGIKA BOTA DISCORD (TWORZENIE, LISTA I USUWANIE KODÓW)
// -----------------------------------------------------
if (DISCORD_BOT_TOKEN) {
    const { Client, GatewayIntentBits } = require('discord.js');
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        if (message.content.startsWith('!kod') || message.content.startsWith('!kody') || message.content.startsWith('!usunkod')) {
            if (message.author.id !== ADMIN_DISCORD_ID) {
                return message.reply('❌ Brak uprawnień! Tylko Właściciel może zarządzać kodami.');
            }
        }

        if (message.content.startsWith('!kod ')) {
            const args = message.content.split(' ');
            if (args.length !== 4) return message.reply('⚠️ Poprawne użycie: `!kod <NAZWA> <PUNKTY> <MAX_OSÓB>`');

            const codeName = args[1].toUpperCase();
            const reward = parseFloat(args[2]);
            const maxUses = parseInt(args[3]);

            if (isNaN(reward) || isNaN(maxUses)) return message.reply('❌ Punkty i max użyć muszą być liczbą!');

            try {
                const existing = await PromoCode.findOne({ code: codeName });
                if (existing) return message.reply('❌ Taki kod już istnieje w bazie!');

                const newPromo = new PromoCode({ code: codeName, reward: reward, maxUses: maxUses });
                await newPromo.save();

                message.reply(`✅ **Kod utworzony pomyślnie!**\n🎫 Nazwa kodu: **${codeName}**\n💰 Wartość: **${reward} pkt**\n👥 Limit osób: **${maxUses}**`);
            } catch (err) {
                message.reply('❌ Wystąpił błąd podczas zapisywania kodu w bazie MongoDB.');
            }
        }

        if (message.content === '!kody') {
            try {
                const activeCodes = await PromoCode.find({ 
                    $expr: { $lt: ["$currentUses", "$maxUses"] } 
                });

                if (activeCodes.length === 0) {
                    return message.reply('📭 Brak aktywnych kodów w bazie danych.');
                }

                let responseText = '📋 **Lista aktywnych kodów promocyjnych:**\n';
                activeCodes.forEach(p => {
                    responseText += `🎫 **${p.code}** ➔ 💰 **${p.reward} pkt** ➔ 👥 Użycia: **${p.currentUses} / ${p.maxUses}**\n`;
                });

                message.reply(responseText);
            } catch (err) {
                message.reply('❌ Wystąpił błąd podczas pobierania listy kodów.');
            }
        }

        if (message.content.startsWith('!usunkod ')) {
            const args = message.content.split(' ');
            if (args.length !== 2) return message.reply('⚠️ Poprawne użycie: `!usunkod <NAZWA_KODU>`');

            const codeName = args[1].toUpperCase();

            try {
                const deleted = await PromoCode.findOneAndDelete({ code: codeName });
                if (!deleted) {
                    return message.reply(`❌ Nie znaleziono aktywnego kodu o nazwie **${codeName}**.`);
                }

                message.reply(`🗑️ Kod **${codeName}** został pomyślnie usunięty z bazy!`);
            } catch (err) {
                message.reply('❌ Wystąpił błąd podczas usuwania kodu.');
            }
        }
    });

    client.once('ready', () => {
        console.log(`🤖 Bot Discord (${client.user.tag}) połączony i zarządza kodami!`);
    });

    client.login(DISCORD_BOT_TOKEN).catch(console.error);
}