const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// Udostępniamy pliki HTML z folderu 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Mała baza danych w pliku JSON
const DB_FILE = './db.json';

function readDB() {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. ENDPOINT DLA CPX RESEARCH (Odbiór Robuxów)
// Wywołanie wygląda tak: /postback?user_id=Brajan123&amount_local=19.60&status=1
app.get('/postback', (req, res) => {
    const userId = req.query.user_id;       // Nick gracza
    const amount = parseFloat(req.query.amount_local); // Zarobione Robuxy
    const status = req.query.status;        // 1 = ankieta zrobiona prawidłowo

    console.log(`[POSTBACK CPX] Otrzymano sygnał: User=${userId}, Kwota=${amount}, Status=${status}`);

    if (status === '1' && userId && amount) {
        let db = readDB();
        
        // Jeśli gracz nie istnieje w bazie, daj mu na start 0
        if (!db[userId]) db[userId] = 0;
        
        // Dodajemy Robuxy do konta
        db[userId] += amount; 
        writeDB(db);
        
        console.log(`[SUKCES] Dodano ${amount} pkt dla ${userId}. Nowy stan konta: ${db[userId]}`);
        
        // Odpowiadamy serwerom CPX, że wszystko dotarło
        res.status(200).send('OK'); 
    } else {
        res.status(400).send('Ignored or Failed Status');
    }
});

// 2. ENDPOINT DLA STRONY (Zwraca aktualny stan konta)
app.get('/api/points/:username', (req, res) => {
    const db = readDB();
    const username = req.params.username;
    const points = db[username] || 0;
    res.json({ points: points });
});

// Uruchamianie serwera
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serwer działa i nasłuchuje na porcie ${PORT}`);
});
