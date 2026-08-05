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

// Tworzymy nowe tabele oparte o stałe ID z Robloxa (roblox_id)
db.exec(`
  CREATE TABLE IF NOT EXISTS users_v2 (
    roblox_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS history_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roblox_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    points_earned INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 1. Logowanie z weryfikacją konta w Roblox API
app.post('/api/login', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Brak nicku' });

    try {
        // A) Sprawdzamy, czy konto istnieje i pobieramy jego ID
        const robloxRes = await fetch('https://users.roblox.com/v1/usernames/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
        });
        
        const robloxData = await robloxRes.json();

        // Jeśli tablica data jest pusta = konto nie istnieje
        if (!robloxData.data || robloxData.data.length === 0) {
            return res.status(404).json({ error: 'Takie konto w Roblox nie istnieje!' });
        }

        const robloxId = robloxData.data[0].id;
        const realUsername = robloxData.data[0].name; // Prawdziwy, aktualny nick z gry

        // B) Pobieramy avatar (główkę) postaci
        const avatarRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=true`);
        const avatarData = await avatarRes.json();
        const avatarUrl = avatarData.data[0].imageUrl;

        // C) Obsługa bazy danych (zapis lub aktualizacja nicku)
        let user = db.prepare('SELECT * FROM users_v2 WHERE roblox_id = ?').get(robloxId);

        if (!user) {
            // Nowy gracz
            db.prepare('INSERT INTO users_v2 (roblox_id, username, points) VALUES (?, ?, ?)').run(robloxId, realUsername, 0);
            user = { roblox_id: robloxId, username: realUsername, points: 0 };
        } else if (user.username !== realUsername) {
            // Gracz istnieje, ale zmienił nick w grze! Aktualizujemy.
            db.prepare('UPDATE users_v2 SET username = ? WHERE roblox_id = ?').run(realUsername, robloxId);
            user.username = realUsername;
        }

        // Zwracamy na stronę wszystkie dane + zdjęcie awatara
        res.json({ ...user, avatarUrl });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Błąd serwera podczas łączenia z Robloxem.' });
    }
});

// 2. Dodawanie punktów
app.post('/api/add-points', (req, res) => {
    const { robloxId, pointsToAdd, actionName } = req.body;

    if (!robloxId || !pointsToAdd) return res.status(400).json({ error: 'Błędne dane' });

    const updateStmt = db.prepare('UPDATE users_v2 SET points = points + ? WHERE roblox_id = ?');
    const result = updateStmt.run(pointsToAdd, robloxId);

    if (result.changes === 0) return res.status(404).json({ error: 'Nie znaleziono gracza' });

    // Zapisujemy do historii pod stałym ID
    const historyStmt = db.prepare('INSERT INTO history_v2 (roblox_id, action, points_earned) VALUES (?, ?, ?)');
    historyStmt.run(robloxId, actionName || 'Obejrzenie reklamy', pointsToAdd);

    const updatedUser = db.prepare('SELECT * FROM users_v2 WHERE roblox_id = ?').get(robloxId);
    res.json({ success: true, points: updatedUser.points });
});

// 3. Pobieranie historii
app.get('/api/history/:robloxId', (req, res) => {
    const { robloxId } = req.params;
    const history = db.prepare('SELECT * FROM history_v2 WHERE roblox_id = ? ORDER BY timestamp DESC LIMIT 10').all(robloxId);
    res.json(history);
});

app.listen(PORT, () => {
    console.log(`Serwer wystartował na porcie ${PORT}`);
});
