const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// Udostępniamy pliki HTML (nasz frontend) z folderu 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Ścieżka do naszej prostej bazy danych
const DB_FILE = './db.json';

// Funkcja do odczytywania bazy danych
function readDB() {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE));
}

// Funkcja do zapisywania bazy danych
function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. ENDPOINT DLA CPX RESEARCH (Odbiór Robuxów i przejście testu)
// Link do wklejenia w panelu: https://rbx-rewards.onrender.com/postback?status={status}&trans_id={trans_id}&user_id={user_id}&amount_local={amount_local}&hash={hash}
app.get('/postback', (req, res) => {
    const userId = req.query.user_id;
    const amount = parseFloat(req.query.amount_local);
    const status = req.query.status;

    console.log(`[POSTBACK CPX] Otrzymano sygnał: User=${userId}, Kwota=${amount}, Status=${status}`);

    // NAJWAŻNIEJSZE: Zawsze najpierw odsyłamy 200 OK, żeby CPX zaliczył test i zapisał link w panelu bez błędów!
    res.status(200).send('OK'); 

    // Dopiero po udanej odpowiedzi sprawdzamy, czy to prawdziwa ankieta (status 1 oznacza sukces)
    if (status === '1' && userId && amount) {
        let db = readDB();
        
        // Jeśli gracz nie istnieje w bazie, daj mu na start 0
        if (!db[userId]) db[userId] = 0;
        
        // Dodajemy zarobione punkty do konta
        db[userId] += amount; 
        writeDB(db);
        
        console.log(`[SUKCES] Dodano ${amount} pkt dla ${userId}. Nowy stan konta: ${db[userId]}`);
    } else {
        console.log(`[INFO] Zignorowano dodanie punktów. To był tylko test CPX albo ankieta odrzucona (Status: ${status}).`);
    }
});

// 2. ENDPOINT DLA STRONY (Zwraca aktualny stan konta dla index.html)
app.get('/api/points/:username', (req, res) => {
    const db = readDB();
    const username = req.params.username;
    // Zwracamy punkty lub 0, jeśli gracza jeszcze nie ma w bazie
    const points = db[username] || 0;
    res.json({ points: points });
});

// Uruchamianie serwera
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serwer śmiga i nasłuchuje na porcie ${PORT}`);
});
