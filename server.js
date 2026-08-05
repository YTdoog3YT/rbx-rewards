const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('database.db');
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Tworzenie tabel w bazie SQLite (jeśli jeszcze nie istnieją)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    points_earned INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Logowanie / Pobieranie stanu konta gracza
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Brak nicku' });

    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
        const stmt = db.prepare('INSERT INTO users (username, points) VALUES (?, ?)');
        stmt.run(username, 0);
        user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    }

    res.json(user);
});

// Dodawanie punktów po obejrzeniu reklamy i zapis do historii
app.post('/api/add-points', (req, res) => {
    const { username, pointsToAdd, actionName } = req.body;

    if (!username || !pointsToAdd) {
        return res.status(400).json({ error: 'Błędne dane' });
    }

    const updateStmt = db.prepare('UPDATE users SET points = points + ? WHERE username = ?');
    const result = updateStmt.run(pointsToAdd, username);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Nie znaleziono gracza' });
    }

    const historyStmt = db.prepare('INSERT INTO history (username, action, points_earned) VALUES (?, ?, ?)');
    historyStmt.run(username, actionName || 'Obejrzenie reklamy', pointsToAdd);

    const updatedUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    res.json({ success: true, points: updatedUser.points });
});

// Pobieranie ostatnich 10 akcji dla wybranego gracza
app.get('/api/history/:username', (req, res) => {
    const { username } = req.params;
    const history = db.prepare('SELECT * FROM history WHERE username = ? ORDER BY timestamp DESC LIMIT 10').all(username);
    res.json(history);
});

app.listen(PORT, () => {
    console.log(`Serwer wystartował na porcie ${PORT}`);
});
