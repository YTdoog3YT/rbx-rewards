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
    referredUsers: { type: [String], default: [] },
    bonusClicksToday: { type: Number, default: 0 },
    lastBonusClickDate: { type: Date, default: null },
    // 🔥 NOWE: Tablica trzymająca historię użytych kodów
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

// 🔥 PRZELICZNIK WYPŁAT (80 Robuxów = 2.00 USD -> 1 Robux = 0.025 USD)
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
        res.json({ success: true, newBalance: user.points, usd: usdAmount });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

// 🔥 JITSCAPE USTAWIONE NA 15 ROBUXÓW ZA 1 DOLARA
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

// 🔥 DAILY REWARD UCIĘTY NA 0.1 ROBUXA (JAK NA CLAIMRBX)
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
        
        const rewardPoints = 0.1; // Ucięte z 0.5 na 0.1 R$
        
        user.points += rewardPoints; user.lastDailyReward = now; user.streak = currentStreak;
        await user.save();
        await new Earning({ username: username, amount: rewardPoints }).save();
        await processReferralBonus(username, rewardPoints);
        res.json({ success: true, newBalance: user.points, message: `Received ${rewardPoints} Robux!` });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

// 🔥 BONUS CLICKS NA 0.1 ROBUXA / MAX 3x DZIENNIE
app.post('/api/bonus-click', async (req, res) => {
    const { username } = req.body; 
    if (!username) return res.status(400).json({ error: 'Missing username.' });
    try {
        let user = await User.findOne({ username: username });
        if (!user) user = new User({ username: username, points: 0, streak: 0 });
        
        const now = new Date();
        let isSameDay = false;
        
        if (user.lastBonusClickDate) {
            const lastDate = new Date(user.lastBonusClickDate);
            if (lastDate.getFullYear() === now.getFullYear() &&
                lastDate.getMonth() === now.getMonth() &&
                lastDate.getDate() === now.getDate()) {
                isSameDay = true;
            }
        }

        if (isSameDay) {
            if (user.bonusClicksToday >= 3) {
                return res.status(400).json({ error: 'Limit reached! Come back tomorrow.' });
            }
            user.bonusClicksToday += 1;
        } else {
            user.bonusClicksToday = 1;
        }
        
        user.lastBonusClickDate = now;
        
        const rewardPoints = 0.1; 
        
        user.points += rewardPoints; 
        await user.save();
        
        await new Earning({ username: username, amount: rewardPoints }).save();
        await processReferralBonus(username, rewardPoints);
        
        res.json({ success: true, newBalance: user.points, message: `Received ${rewardPoints} Robux from Bonus Click!` });
    } catch (error) { 
        res.status(500).json({ error: 'Server error.' }); 
    }
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

app.get('/api/referral-stats/:username', async (req, res) => {
    try {
        const username = req.params.username;
        const period = req.query.period || '7days';

        let startDate = new Date(0);
        let endDate = new Date();
        const now = new Date();

        if (period === 'today') {
            startDate = new Date(now.setHours(0, 0, 0, 0));
        } else if (period === 'yesterday') {
            const yesterdayStart = new Date();
            yesterdayStart.setDate(yesterdayStart.getDate() - 1);
            startDate = new Date(yesterdayStart.setHours(0, 0, 0, 0));
            
            const yesterdayEnd = new Date();
            yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
            yesterdayEnd.setHours(23, 59, 59, 999);
            endDate = yesterdayEnd;
        } else if (period === '7days') {
            startDate = new Date(now.setDate(now.getDate() - 7));
        } else if (period === '30days') {
            startDate = new Date(now.setDate(now.getDate() - 30));
        }

        const referredDocs = await User.find({ referredBy: new RegExp(`^${username}$`, 'i') });
        const referredUsernames = referredDocs.map(u => u.username);

        if (referredUsernames.length === 0) {
            return res.json([]);
        }

        const earnings = await Earning.aggregate([
            { 
                $match: { 
                    username: { $in: referredUsernames },
                    createdAt: { $gte: startDate, $lte: endDate }
                } 
            },
            { $group: { _id: "$username", totalEarned: { $sum: "$amount" } } }
        ]);

        const finalStats = referredUsernames.map(ru => {
            const found = earnings.find(e => e._id === ru);
            return {
                username: ru,
                earned: found ? found.totalEarned * 0.15 : 0
            };
        });

        finalStats.sort((a, b) => b.earned - a.earned);

        res.json(finalStats); 
    } catch (error) {
        console.error("Błąd pobierania poleconych:", error);
        res.json([]);
    }
});

// 🔥 ZAKTUALIZOWANE ODBIERANIE KODÓW (Zapisuje do bazy historię)
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
        
        // Zapis do historii użytkownika
        if (!user.redeemedPromoCodes) user.redeemedPromoCodes = [];
        user.redeemedPromoCodes.push({ code: promo.code, reward: promo.reward, date: new Date() });

        await user.save();

        promo.currentUses += 1;
        promo.usedBy.push(username);
        await promo.save();

        await new Earning({ username, amount: promo.reward }).save();
        await processReferralBonus(username, promo.reward);

        res.json({ success: true, newBalance: user.points, message: `Odebrano ${promo.reward} Robuxów z kodu!` });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera.' });
    }
});

// 🔥 NOWY ENDPOINT: POBIERANIE HISTORII KODÓW DLA GRACZA
app.get('/api/promo-history/:username', async (req, res) => {
    try {
        const username = req.params.username;
        const user = await User.findOne({ username: username });
        
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const history = user.redeemedPromoCodes || [];
        
        // Sortujemy od najnowszych wpisów do najstarszych
        history.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        res.json(history);
    } catch (error) {
        console.error("Error fetching promo history:", error);
        res.status(500).json({ error: "Internal server error" });
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

        const cmd = message.content.split(' ')[0].toLowerCase();
        const allowedCommands = ['!kod', '!kody', '!usunkod', '!resetdaily', '!komendy'];

        if (allowedCommands.includes(cmd)) {
            if (message.author.id !== ADMIN_DISCORD_ID) {
                return message.reply('❌ Brak uprawnień! Tylko Właściciel może zarządzać tą stroną.');
            }
        } else {
            return;
        }

        if (cmd === '!komendy') {
            const helpText = `
**🛠️ PANEL ADMINISTRATORA - DOSTĘPNE KOMENDY:**

🔹 \`!kod <NAZWA> <PUNKTY> <MAX_OSÓB>\`
> **Opis:** Tworzy nowy kod promocyjny dla graczy.
> **Przykład:** \`!kod WAKACJE 10 50\` *(Tworzy kod "WAKACJE", który daje 10 R$, a użyć go może max 50 osób)*.

🔹 \`!kody\`
> **Opis:** Wyświetla listę wszystkich aktywnych kodów oraz informacje o ich użyciu.

🔹 \`!usunkod <NAZWA_KODU>\`
> **Opis:** Trwale usuwa kod promocyjny z bazy danych.
> **Przykład:** \`!usunkod WAKACJE\`

🔹 \`!resetdaily <NICK_ROBLOX>\`
> **Opis:** Zdejmuje blokadę Daily Reward dla gracza.
> **Przykład:** \`!resetdaily Brajanek123\`

🔹 \`!komendy\`
> **Opis:** Wyświetla tę listę pomocy.
            `;
            return message.reply(helpText);
        }

        if (cmd === '!kod') {
            const args = message.content.split(' ');
            if (args.length !== 4) return message.reply('⚠️ Poprawne użycie: `!kod <NAZWA> <PUNKTY> <MAX_OSÓB>`\n*Przykład: !kod LATOWIKA 5 100*');

            const codeName = args[1].toUpperCase();
            const reward = parseFloat(args[2]);
            const maxUses = parseInt(args[3]);

            if (isNaN(reward) || isNaN(maxUses)) return message.reply('❌ Robuxy i max użyć muszą być liczbą!');

            try {
                const existing = await PromoCode.findOne({ code: codeName });
                if (existing) return message.reply('❌ Taki kod już istnieje w bazie!');

                const newPromo = new PromoCode({ code: codeName, reward: reward, maxUses: maxUses });
                await newPromo.save();

                message.reply(`✅ **Kod utworzony pomyślnie!**\n🎫 Nazwa kodu: **${codeName}**\n💰 Wartość: **${reward} R$**\n👥 Limit osób: **${maxUses}**`);
            } catch (err) {
                message.reply('❌ Wystąpił błąd podczas zapisywania kodu w bazie MongoDB.');
            }
        }

        if (cmd === '!kody') {
            try {
                const activeCodes = await PromoCode.find({ 
                    $expr: { $lt: ["$currentUses", "$maxUses"] } 
                });

                if (activeCodes.length === 0) {
                    return message.reply('📭 Brak aktywnych kodów w bazie danych.');
                }

                let responseText = '📋 **Lista aktywnych kodów promocyjnych:**\n';
                activeCodes.forEach(p => {
                    responseText += `🎫 **${p.code}** ➔ 💰 **${p.reward} R$** ➔ 👥 Użycia: **${p.currentUses} / ${p.maxUses}**\n`;
                });

                message.reply(responseText);
            } catch (err) {
                message.reply('❌ Wystąpił błąd podczas pobierania listy kodów.');
            }
        }

        if (cmd === '!usunkod') {
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

        if (cmd === '!resetdaily') {
            const args = message.content.split(' ');
            const targetUser = args[1];
            if (!targetUser) return message.reply('⚠️ Poprawne użycie: `!resetdaily <NICK>`');

            try {
                const updatedUser = await User.findOneAndUpdate(
                    { username: new RegExp(`^${targetUser}$`, 'i') }, 
                    { $set: { lastDailyReward: null } }
                );
                
                if (updatedUser) {
                    message.reply(`✅ Czas dla gracza **${targetUser}** został zresetowany. Może on odebrać Daily Reward ponownie!`);
                } else {
                    message.reply(`❌ Nie znaleziono gracza **${targetUser}** w bazie danych.`);
                }
            } catch (err) {
                message.reply('❌ Wystąpił błąd podczas resetowania.');
            }
        }
    });

    client.once('ready', () => {
        console.log(`🤖 Bot Discord (${client.user.tag}) połączony i zarządza kodami!`);
    });

    client.login(DISCORD_BOT_TOKEN).catch(console.error);
}