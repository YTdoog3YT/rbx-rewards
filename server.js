const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

// Udostępniamy frontend z folderu 'public'
app.use(express.static(path.join(__dirname, 'public')));

// PODŁĄCZENIE BAZY DANYCH (Twój dokładny, czysty link)
const MONGO_URI = 'mongodb+srv://contactcatlover_db_user:E8zvsX5pv1oMtKNE@robux.h3weh54.mongodb.net/?appName=Robux';

// Łączymy się z MongoDB
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Baza MongoDB podłączona pancernie!'))
    .catch(err => console.error('❌ Błąd bazy:', err));

// Struktura gracza w bazie (odpowiednik DataStore z Robloxa)
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

    // Najpierw odsyłamy OK, żeby CPX się nie burzyło
    res.status(200).send('OK'); 

    // Zapis do bezpiecznej bazy w chmurze
    if (status === '1' && userId && amount) {
        try {
            // Szukamy gracza w bazie
            let user = await User.findOne({ username: userId });
            
            // Jeśli to jego pierwsza ankieta, zakładamy profil w bazie
            if (!user) {
                user = new User({ username: userId, points: 0 });
            }
            
            // Dodajemy hajs i zapisujemy
            user.points += amount;
            await user.save();
            
            console.log(`[SUKCES] Dodano ${amount} pkt dla ${userId}. Nowy stan konta: ${user.points}`);
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

// Start serwera
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serwer śmiga i nasłuchuje na porcie ${PORT}`);
});
