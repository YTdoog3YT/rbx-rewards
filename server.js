const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

// Udostępniamy frontend z folderu 'public'
app.use(express.static(path.join(__dirname, 'public')));

// PODŁĄCZENIE BAZY DANYCH
const MONGO_URI = 'mongodb+srv://contactcatlover_db_user:E8zvsX5pv1oMtKNE@robux.h3weh54.mongodb.net/?appName=Robux';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Baza MongoDB podłączona pancernie!'))
    .catch(err => console.error('❌ Błąd bazy:', err));

const UserSchema = new mongoose.Schema({
    username: String,
    points: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// 1. ENDPOINT DLA CPX RESEARCH
app.get('/postback', async (req, res) => {
    const userId = req.query.user_id;
    const amount = parseFloat(req.query.amount_local);
    const status = req.query.status;

    res.status(200).send('OK'); 

    // Akceptujemy status '1' (Sukces) ORAZ status '2' (Screenout / Wywalenie)
    if ((status === '1' || status === '2') && userId && amount) {
        try {
            let user = await User.findOne({ username: userId });
            
            if (!user) {
                user = new User({ username: userId, points: 0 });
            }
            
            user.points += amount;
            await user.save();
            
            console.log(`[SUKCES] Dodano ${amount} pkt dla ${userId} (Status: ${status}). Nowy stan: ${user.points}`);
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

// 3. ENDPOINT DLA PASKA (Top 5 Graczy z bazy MongoDB)
app.get('/api/top-earners', async (req, res) => {
    try {
        const topUsers = await User.find({ points: { $gt: 0 } }).sort({ points: -1 }).limit(5);
        res.json(topUsers);
    } catch (error) {
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serwer śmiga i nasłuchuje na porcie ${PORT}`);
});
