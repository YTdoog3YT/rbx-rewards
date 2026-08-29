const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

// POZWALA SERWEROWI CZYTAĆ DANE Z FORMULARZY (Wypłaty)
app.use(express.json());

// Udostępniamy frontend z folderu 'public'
app.use(express.static(path.join(__dirname, 'public')));

// PODŁĄCZENIE BAZY DANYCH
const MONGO_URI = 'mongodb+srv://contactcatlover_db_user:E8zvsX5pv1oMtKNE@robux.h3weh54.mongodb.net/?appName=Robux';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Baza MongoDB podłączona pancernie!'))
    .catch(err => console.error('❌ Błąd bazy:', err));

// SCHEMAT 1: Całkowite punkty gracza
const UserSchema = new mongoose.Schema({
    username: String,
    points: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// SCHEMAT 2: Historia pojedynczych zarobków (Dla paska na żywo)
const EarningSchema = new mongoose.Schema({
    username: String,
    amount: Number,
    createdAt: { type: Date, default: Date.now }
});
const Earning = mongoose.model('Earning', EarningSchema);

// SCHEMAT 3: Prośby o wypłatę (Payouts)
const PayoutSchema = new mongoose.Schema({
    username: String,
    paypalEmail: String,
    pointsWithdrawn: Number,
    usdAmount: Number,
    status: { type: String, default: 'Pending' },
    createdAt: { type: Date, default: Date.now }
});
const Payout = mongoose.model('Payout', PayoutSchema);

// 1. ENDPOINT DLA CPX RESEARCH
app.get('/postback', async (req, res) => {
    const userId = req.query.user_id;
    const amount = parseFloat(req.query.amount_local);
    const status = req.query.status;

    res.status(200).send('OK'); 

    if ((status === '1' || status === '2') && userId && amount) {
        try {
            let user = await User.findOne({ username: userId });
            
            if (!user) {
                user = new User({ username: userId, points: 0 });
            }
            
            user.points += amount;
            await user.save();
            
            const newEarning = new Earning({ username: userId, amount: amount });
            await newEarning.save();
            
            console.log(`[SUKCES] Dodano ${amount} pkt dla ${userId}. Stan: ${user.points}`);
        } catch (error) {
            console.error(`[BŁĄD] Nie udało się zapisać punktów:`, error);
        }
    }
});

// 2. ENDPOINT DLA STRONY Z PUNKTAMI
app.get('/api/points/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        res.json({ points: user ? user.points : 0 });
    } catch (error) {
        res.json({ points: 0 });
    }
});

// 3. ENDPOINT DLA PASKA (Top 5 NAJNOWSZYCH ZAROBKÓW)
app.get('/api/latest-earners', async (req, res) => {
    try {
        const latestEarnings = await Earning.find().sort({ createdAt: -1 }).limit(5);
        res.json(latestEarnings);
    } catch (error) {
        res.json([]);
    }
});

// 4. ENDPOINT DLA WYPŁAT (Zabezpieczony przed oszustwami)
app.post('/api/withdraw', async (req, res) => {
    const { username, paypalEmail, points } = req.body;

    if (!username || !paypalEmail || !points || points <= 0) {
        return res.status(400).json({ error: 'Invalid data provided.' });
    }

    try {
        const user = await User.findOne({ username: username });
        
        if (!user || user.points < points) {
            return res.status(400).json({ error: 'You do not have enough points!' });
        }

        // Zabieramy punkty graczowi
        user.points -= points;
        await user.save();

        // 100 punktów = 0.01$ (czyli 1 pkt = 0.0001$)
        const usdAmount = points * 0.0001;

        // Zapisujemy wypłatę w bazie
        const payoutRequest = new Payout({
            username: username,
            paypalEmail: paypalEmail,
            pointsWithdrawn: points,
            usdAmount: usdAmount
        });
        await payoutRequest.save();

        // ==========================================
        // POWIADOMIENIA DISCORD WEBHOOK NA ŻYWO
        // ==========================================
        const discordWebhookUrl = "https://discord.com/api/webhooks/1543215298826473554/oFfYZEMrC_AWsyP06xFXMets-DBv82U76tXk5I5vIQhN8gAFXVp3UOrthamCCx4K8pI_";
        
        fetch(discordWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `🚨 **NOWA PROŚBA O WYPŁATĘ!** 🚨\n**Gracz:** ${username}\n**Email PayPal:** ${paypalEmail}\n**Kwota:** $${usdAmount.toFixed(4)} (${points} punktów)`
            })
        }).catch(err => console.error("Błąd wysyłania powiadomienia na Discorda:", err));

        // Zwracamy odpowiedź do frontendu
        res.json({ success: true, newBalance: user.points, usd: usdAmount });
    } catch (error) {
        console.error('Błąd wypłaty:', error);
        res.status(500).json({ error: 'Server error during withdrawal.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serwer śmiga i nasłuchuje na porcie ${PORT}`);
});
