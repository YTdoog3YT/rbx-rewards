const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Baza danych SQLite
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Błąd bazy danych:', err.message);
    else console.log('Baza danych gotowa!');
});

// Tabela użytkowników
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            points REAL DEFAULT 0.0
        )
    `);
});

// --- ENDPOINTY ---

// Logowanie / Rejestracja po nicku
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Podaj nick' });

    db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            res.json(row);
        } else {
            db.run('INSERT INTO users (username) VALUES (?)', [username], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID, username, points: 0.0 });
            });
        }
    });
});

// Pobieranie punktów
app.get('/api/user/:username', (req, res) => {
    db.get('SELECT * FROM users WHERE username = ?', [req.params.username], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Nie znaleziono' });
        res.json(row);
    });
});

// Webhook dla sieci reklamowej (Postback)
app.get('/api/postback', (req, res) => {
    const username = req.query.user_id;
    const earnedPoints = parseFloat(req.query.points);

    if (!username || isNaN(earnedPoints)) {
        return res.status(400).send('Błędne parametry');
    }

    db.run('UPDATE users SET points = points + ? WHERE username = ?', [earnedPoints, username], function (err) {
        if (err) return res.status(500).send('Błąd bazy');
        console.log(`[POSTBACK] Dodano ${earnedPoints} pkt dla: ${username}`);
        res.send('OK');
    });
});

app.listen(PORT, () => {
    console.log(`Serwer śmiga na http://localhost:${PORT}`);
});