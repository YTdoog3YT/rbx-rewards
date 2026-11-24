const errorAlerts = require('./error-alerts'); // błędy z console.error lecą też na kanał Discord (error-alerts.js)
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');
const { Server } = require('socket.io');

const discordBot = require('./discord-bot');
const botAdmin = require('./bot-2.js');
const botTwitch = require('./bot-twitch.js');

const ADMIN_DISCORD_ID = "398911896893521921";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1546268855708684318"; 
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "https://rbx-rewards.pl/api/admin/callback";
const ADMIN_PROMO_CHANNEL_ID = "1556029618077704192";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

let discordClient = null;
if (DISCORD_BOT_TOKEN) {
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
}

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } }); 

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPolandMidnight() {
    const now = new Date();
    const polandTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
    const diffMs = polandTime.getTime() - now.getTime();
    polandTime.setHours(0, 0, 0, 0);
    return new Date(polandTime.getTime() - diffMs);
}

// Wystawienie pliku app-ads.txt dla botów Google
app.get('/app-ads.txt', (req, res) => {
  res.sendFile(path.join(__dirname, 'app-ads.txt'));
});

// --- GRACZE ONLINE (socket; podgląd w panelu admina) ---
const onlineUsersMap = new Map();

app.get('/ping', (req, res) => { res.status(200).send('OK'); });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ Brak zmiennej MONGO_URI'); process.exit(1); }
mongoose.connect(MONGO_URI).then(() => console.log('✅ Baza MongoDB gotowa!')).catch(err => console.error(err));

// --- SCHEMATY BAZY DANYCH ---
const GoalSchema = new mongoose.Schema({
    id: { type: String, required: true }, title: String, target: Number, current: { type: Number, default: 0 },
    status: { type: String, default: 'active' }, imageUrl: { type: String, default: '' }, createdAt: { type: Date, default: Date.now }
});

const UserSchema = new mongoose.Schema({
    username: String, points: { type: Number, default: 0 }, referredBy: { type: String, default: null }, referredUsers: { type: [String], default: [] },
    redeemedPromoCodes: { type: [{ code: String, reward: Number, date: { type: Date, default: Date.now } }], default: [] },
    inbox: { type: [{ message: String, date: { type: Date, default: Date.now }, read: { type: Boolean, default: false } }], default: [] },
    linkedPayPal: { type: String, default: null }, xp: { type: Number, default: 0 }, claimedLevels: { type: [Number], default: [] },
    dailyEarned: { type: Number, default: 0 }, lastEarnedDate: { type: String, default: "" }, lastWheelSpin: { type: Date, default: null },
    wheelStreak: { type: Number, default: 0 }, goals: [GoalSchema],
    verified: { type: Boolean, default: false }, robloxName: { type: String, default: '' }, gaijinId: { type: String, default: '' }, discordName: { type: String, default: '' },
    pinHash: { type: String, default: null }, pinAttempts: { type: Number, default: 0 }, pinLockedUntil: { type: Date, default: null },
    discordLinkedId: { type: String, default: null }, discordLinkedName: { type: String, default: '' }, discordLinkedAt: { type: Date, default: null },
    notifSeenAt: { type: Date, default: null }, // kiedy gracz ostatnio otworzył dzwonek z powiadomieniami
    payoutBlocked: { type: Boolean, default: false }, // blokada wypłat ustawiana w panelu admina
    accountBlocked: { type: Boolean, default: false }, blockedUntil: { type: Date, default: null } // blokada całego konta (null = na zawsze)
});
// jedno konto Discord = jedno konto na stronie
UserSchema.index({ discordLinkedId: 1 }, { unique: true, partialFilterExpression: { discordLinkedId: { $type: 'string' } } });
const User = mongoose.model('User', UserSchema);

const EarningSchema = new mongoose.Schema({ username: String, amount: Number, source: { type: String, default: 'Survey' }, details: { type: String, default: '' }, txId: String, createdAt: { type: Date, default: Date.now } });
EarningSchema.index({ source: 1, txId: 1 }, { unique: true, partialFilterExpression: { txId: { $type: 'string' } } });
const Earning = mongoose.model('Earning', EarningSchema);

const PayoutSchema = new mongoose.Schema({ 
    username: String, payoutMethod: { type: String, default: 'Revolut' }, payoutAddress: String, paypalEmail: String, 
    pointsWithdrawn: Number, usdAmount: Number, status: { type: String, default: 'Pending Manual' }, createdAt: { type: Date, default: Date.now } 
});
const Payout = mongoose.model('Payout', PayoutSchema);

const PromoCodeSchema = new mongoose.Schema({ code: { type: String, unique: true, uppercase: true }, reward: Number, maxUses: Number, currentUses: { type: Number, default: 0 }, usedBy: [String] });
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);

const BundleSchema = new mongoose.Schema({
    username: String, category: String, offerId: String, title: String,
    priceC: Number, depositedC: { type: Number, default: 0 },
    customUsd: { type: Number, default: 0 }, approxRobux: { type: Number, default: 0 },
    gameId: String, discord: String,
    status: { type: String, default: 'filling' },
    createdAt: { type: Date, default: Date.now }, paidAt: Date, doneAt: Date
});
const Bundle = mongoose.model('Bundle', BundleSchema);

// --- TICKETY (SUPPORT NA DISCORDZIE) ---
const TicketSchema = new mongoose.Schema({
    username: String, discordId: String, discordName: String, message: String,
    dayKey: String, number: Number, channelId: { type: String, default: null }, channelName: { type: String, default: '' },
    status: { type: String, default: 'open' }, // open | resolved | deleted | failed
    blockAppeal: { type: Boolean, default: false }, // ticket zablokowanego gracza (przyciski Odblokuj / Zostaw blokadę)
    resolvedBy: { type: String, default: '' }, resolvedAt: { type: Date, default: null }, deleteAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});
TicketSchema.index({ username: 1, status: 1 });
TicketSchema.index({ status: 1, deleteAt: 1 });
const Ticket = mongoose.model('Ticket', TicketSchema);
const CounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', CounterSchema);

const dbModels = { User, Earning, Payout, PromoCode, Bundle, Ticket, Counter };

function allocateGoalProgress(user, amountToAllocate) {
    let remaining = amountToAllocate;
    let activeGoals = user.goals.filter(g => g.status === 'active').sort((a, b) => a.createdAt - b.createdAt);
    for (let goal of activeGoals) {
        if (remaining <= 0) break;
        let needed = goal.target - goal.current;
        if (remaining >= needed) { goal.current = goal.target; goal.status = 'completed'; remaining -= needed; } 
        else { goal.current += remaining; remaining = 0; }
    }
}

// 15% dla polecającego. Punkty dopisujemy samym $inc (bez zapisu całego konta, który mógł się po cichu wywalać),
// a każdy problem trafia do console.error -> logi Rendera + kanał błędów na Discordzie.
async function processReferralBonus(username, amountEarned) {
    let ctx = `${username}, ${amountEarned} R$`;
    try {
        const user = await User.findOne({ username: username }).select('referredBy').lean();
        if (!user || !user.referredBy) return;
        const bonus = parseFloat((amountEarned * 0.15).toFixed(2));
        if (!(bonus > 0)) return;
        ctx = `${username} → ${user.referredBy}, ${bonus} R$`;
        const referrer = await findUserCI(user.referredBy);
        if (!referrer) { console.error(`[polecenia] nie znaleziono polecającego (${ctx}) - 15% nie dopisane`); return; }
        await User.updateOne({ _id: referrer._id }, { $inc: { points: bonus } });
        await new Earning({ username: referrer.username, amount: bonus, source: 'Referral', details: username }).save();
        try { // postęp celów polecającego (osobno, żeby błąd celów nie blokował punktów)
            allocateGoalProgress(referrer, bonus);
            await User.updateOne({ _id: referrer._id }, { $set: { goals: referrer.goals } });
        } catch (e) { console.error(`[polecenia] punkty dopisane, ale nie zapisał się postęp celów (${ctx}):`, e.message); }
    } catch (err) { console.error(`[polecenia] nie dopisano 15% z polecenia (${ctx}):`, err.message); }
}

async function addXPAndDailyEarned(user, amount) {
    const today = new Date().toISOString().split('T')[0];
    if (user.lastEarnedDate !== today) { user.dailyEarned = 0; user.lastEarnedDate = today; }
    user.dailyEarned += amount; user.xp += amount * 100;
}

// =================== LOGOWANIE PIN-em I SESJE ===================
const { hashPin, verifyPin, isValidPin, generatePin } = require('./pin-utils');
const SessionSchema = new mongoose.Schema({ tokenHash: { type: String, unique: true }, username: String, expiresAt: Date });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB sam usuwa wygasłe sesje
const Session = mongoose.model('Session', SessionSchema);
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // sesja ważna 6 godzin
const sessionCache = new Map();             // krótka pamięć podręczna, żeby nie pytać bazy przy każdym zapytaniu
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const NICK_RE = /^[A-Za-z0-9_]{3,20}$/;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

async function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    await Session.create({ tokenHash: hashToken(token), username, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    return token;
}
async function getSession(req) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return null;
    const token = h.slice(7).trim();
    if (!token) return null;
    const tokenHash = hashToken(token);
    const now = Date.now();
    const c = sessionCache.get(tokenHash);
    if (c && c.expires > now && c.checkedAt > now - 60 * 1000) return { tokenHash, username: c.username };
    const s = await Session.findOne({ tokenHash }).lean();
    if (!s || new Date(s.expiresAt).getTime() <= now) { sessionCache.delete(tokenHash); return null; }
    sessionCache.set(tokenHash, { username: s.username, expires: new Date(s.expiresAt).getTime(), checkedAt: now });
    return { tokenHash, username: s.username };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of sessionCache) if (v.expires < now || v.checkedAt < now - 60 * 1000) sessionCache.delete(k); }, 10 * 60 * 1000).unref();

const accountBlock = require('./account-block');
const { chatRoleFor } = require('./chat-roles');
const PROTECTED_GET_RE = /^\/api\/(points|user-stats|goals|earning-history|inbox|promo-history|referral-stats|referral-list|bundles|support-status|notifications|block-status)\/([^/?]+)/;
const PROTECTED_POST = new Set(['/api/withdraw', '/api/goals/add', '/api/goals/cancel', '/api/goals/clear', '/api/claim-level', '/api/spin-wheel',
    '/api/redeem-promo', '/api/redeem-code', '/api/support-ticket', '/api/bundles/create', '/api/bundles/deposit', '/api/bundles/withdraw',
    '/api/discord/link-start', '/api/notifications/seen']);

app.use(async (req, res, next) => {
    try {
        const p = req.path;
        if (!p.startsWith('/api/')) return next();
        const m = req.method === 'GET' ? p.match(PROTECTED_GET_RE) : null;
        const isProtected = (m && !(m[1] === 'bundles' && m[2] === 'offers')) || (req.method === 'POST' && PROTECTED_POST.has(p));
        if (!isProtected) return next();
        const s = await getSession(req);
        if (!s) return res.status(401).json({ error: 'Sesja wygasła. Zaloguj się ponownie.', code: 'SESSION' });
        // zablokowane konto: tylko saldo, ekran blokady i ticket (account-block.js)
        const allowedWhenBlocked = m ? accountBlock.BLOCKED_ALLOWED_GET.has(m[1]) : accountBlock.BLOCKED_ALLOWED_POST.has(p);
        if (!allowedWhenBlocked) {
            const bu = await User.findOne({ username: s.username }).select('accountBlocked blockedUntil').lean();
            if (accountBlock.isAccountBlocked(bu)) return res.status(403).json({ error: 'Twoje konto jest zablokowane.', code: 'BLOCKED' });
        }
        if (m) req.url = req.url.replace(PROTECTED_GET_RE, (all, name) => `/api/${name}/${encodeURIComponent(s.username)}`);
        else { req.body = req.body || {}; req.body.username = s.username; }
        next();
    } catch (e) {
        console.error('[auth] sesja:', e.message);
        return res.status(500).json({ error: 'Błąd serwera.' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const pin = String(req.body.pin || '').trim();
        if (!NICK_RE.test(username)) return res.status(400).json({ error: 'Nick: 3–20 znaków, tylko litery, cyfry i _ (jak w Robloxie).' });
        if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN musi mieć dokładnie 6 cyfr i nie może być zbyt prosty (np. 123456).' });
        const pinHash = await hashPin(pin);
        const taken = { error: 'Ten nick jest już zajęty. Jeśli to Twoje konto, zaloguj się. Jeśli nie znasz PIN-u, napisz do administracji na Discordzie.' };

        const existing = await findUserCI(username);
        if (existing) {
            const hasStuff = (existing.points || 0) !== 0 || (existing.xp || 0) > 0;
            if (existing.pinHash || hasStuff) return res.status(409).json(taken);
            const claimed = await User.findOneAndUpdate({ _id: existing._id, pinHash: null }, { $set: { pinHash } }, { new: true });
            if (!claimed) return res.status(409).json(taken);
            return res.json({ success: true, token: await createSession(claimed.username), username: claimed.username });
        }
        const user = await new User({ username, points: 0, pinHash }).save();
        const all = await User.find({ username: new RegExp(`^${escapeRegex(username)}$`, 'i') }).select('_id').sort({ _id: 1 }).lean();
        if (all.length > 1 && String(all[0]._id) !== String(user._id)) { await User.deleteOne({ _id: user._id }); return res.status(409).json(taken); }
        return res.json({ success: true, token: await createSession(user.username), username: user.username });
    } catch (e) { console.error('[auth] rejestracja:', e.message); return res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const FAIL = { error: 'Nieprawidłowy nick lub PIN.' };
    try {
        const username = String(req.body.username || '').trim().slice(0, 64);
        const pin = String(req.body.pin || '').trim();
        if (!username || !/^\d{6}$/.test(pin)) { await sleepMs(300); return res.status(401).json(FAIL); }
        const user = await findUserCI(username);
        if (!user || !user.pinHash) { await sleepMs(300); return res.status(401).json(FAIL); }

        const now = new Date();
        if (user.pinLockedUntil && user.pinLockedUntil > now) {
            const min = Math.ceil((user.pinLockedUntil - now) / 60000);
            return res.status(429).json({ error: `Zbyt wiele błędnych prób. Konto jest zablokowane jeszcze ok. ${min} min.` });
        }
        if (user.pinLockedUntil) await User.updateOne({ _id: user._id }, { $set: { pinAttempts: 0, pinLockedUntil: null } });

        const claimed = await User.findOneAndUpdate(
            { _id: user._id, $or: [{ pinAttempts: { $lt: PIN_MAX_ATTEMPTS } }, { pinAttempts: { $exists: false } }] },
            { $inc: { pinAttempts: 1 } }, { new: true }
        );
        if (!claimed) {
            await User.updateOne({ _id: user._id }, { $set: { pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) } });
            return res.status(429).json({ error: 'Zbyt wiele błędnych prób. Konto zablokowane на 15 minut.' });
        }

        const ok = await verifyPin(pin, claimed.pinHash);
        if (!ok) {
            if (claimed.pinAttempts >= PIN_MAX_ATTEMPTS) await User.updateOne({ _id: user._id }, { $set: { pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) } });
            await sleepMs(300);
            return res.status(401).json({ error: `Nieprawidłowy nick lub PIN. Pozostało prób: ${Math.max(0, PIN_MAX_ATTEMPTS - claimed.pinAttempts)}.` });
        }
        await User.updateOne({ _id: user._id }, { $set: { pinAttempts: 0, pinLockedUntil: null } });
        return res.json({ success: true, token: await createSession(user.username), username: user.username });
    } catch (e) { console.error('[auth] logowanie:', e.message); return res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/auth/logout', async (req, res) => {
    try {
        const s = await getSession(req);
        if (s) { sessionCache.delete(s.tokenHash); await Session.deleteOne({ tokenHash: s.tokenHash }); }
    } catch (e) {}
    res.json({ success: true });
});

async function assignRandomPinsToOldAccounts() {
    try {
        const users = await User.find({ pinHash: null, $or: [{ points: { $ne: 0 } }, { xp: { $gt: 0 } }] }).select('_id').lean();
        for (const u of users) await User.updateOne({ _id: u._id, pinHash: null }, { $set: { pinHash: await hashPin(generatePin()) } });
        if (users.length) console.log(`[auth] ${users.length} istniejących kont dostało losowy PIN`);
    } catch (e) { console.error('[auth] migracja PIN-ów:', e.message); }
}
if (mongoose.connection.readyState === 1) assignRandomPinsToOldAccounts();
else mongoose.connection.once('open', assignRandomPinsToOldAccounts);

const POSTBACK_KEY = process.env.POSTBACK_KEY || '';
const POSTBACK_ENFORCE = process.env.POSTBACK_ENFORCE === 'true';
const MAX_SURVEY_REWARD = 500;

function postbackAllowed(givenKey, label) {
    const a = Buffer.from(String(givenKey || ''));
    const b = Buffer.from(POSTBACK_KEY);
    if (b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    console.warn(`[postback] ${label}: brak lub zły klucz`);
    return !POSTBACK_ENFORCE;
}

function findUserCI(name) {
    return User.findOne({ username: new RegExp(`^${escapeRegex(name)}$`, 'i') });
}

const { ownerBonusFor, reverseOwnerBonus } = require('./owner-bonus');

async function creditSurvey(userId, amount, txId, allowOwnerBonus = true) {
    let user = await findUserCI(userId);
    const name = user ? user.username : userId;
    const earning = new Earning({ username: name, amount, source: 'Survey', txId });
    try { await earning.save(); }
    catch (e) { if (e && e.code === 11000) return 'duplicate'; throw e; }
    const ownerBonus = allowOwnerBonus ? ownerBonusFor(name, amount) : 0; // dopłata dla wybranych graczy (owner-bonus.js), nie za screenouty
    try {
        if (!user) user = new User({ username: name, points: 0 });
        user.points += amount + ownerBonus;
        await addXPAndDailyEarned(user, amount + ownerBonus);
        allocateGoalProgress(user, amount + ownerBonus);
        await user.save();
    } catch (e) {
        await Earning.deleteOne({ _id: earning._id }).catch(() => {});
        throw e;
    }
    if (ownerBonus > 0) {
        await new Earning({ username: name, amount: ownerBonus, source: 'OwnerBonus', details: '', txId: 'ob:' + txId }).save()
            .catch(e => console.error('[owner-bonus] zapis historii:', e.message));
    }
    await processReferralBonus(name, amount);
    return 'ok';
}

async function reverseSurvey(userId, txId, fallbackAmount) {
    const user = await findUserCI(userId);
    if (!user) return 'no_user';
    const original = await Earning.findOne({ source: 'Survey', txId: 'cpx:' + txId });
    const amount = original ? original.amount : fallbackAmount;
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SURVEY_REWARD) return 'bad_amount';

    try { await new Earning({ username: user.username, amount: -amount, source: 'Reversal', details: 'CPX Research', txId: 'cpx-rev:' + txId }).save(); }
    catch (e) { if (e && e.code === 11000) return 'duplicate'; throw e; }

    await User.updateOne({ _id: user._id }, { $inc: { points: -amount } });
    await reverseOwnerBonus(Earning, User, user, 'cpx:' + txId);

    if (user.referredBy) {
        const bonus = parseFloat((amount * 0.15).toFixed(2));
        if (bonus > 0) {
            const referrer = await User.findOneAndUpdate({ username: user.referredBy }, { $inc: { points: -bonus } });
            if (referrer) await new Earning({ username: referrer.username, amount: -bonus, source: 'ReferralReversal', details: user.username }).save();
        }
    }
    return 'ok';
}

app.get('/postback', async (req, res) => {
    const userId = String(req.query.user_id || '').trim();
    const amount = parseFloat(req.query.amount_local);
    const status = String(req.query.status || '');
    const txId = String(req.query.trans_id || '').trim();

    if (!postbackAllowed(req.query.key, 'CPX')) return res.status(403).send('Forbidden');
    res.status(200).send('OK');

    if (!userId || !txId) return console.warn('[postback] CPX: brak user_id lub trans_id');
    try {
        if (status === '1') {
            if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SURVEY_REWARD) return console.warn('[postback] CPX: zła kwota');
            // bonus od właściciela tylko za ukończoną ankietę (type=complete), nie za screenout (out) ani bonus CPX
            const cpxType = String(req.query.type || '').trim().toLowerCase();
            await creditSurvey(userId, amount, 'cpx:' + txId, cpxType === 'complete');
        } else if (status === '2') {
            await reverseSurvey(userId, txId, amount);
        }
    } catch (e) { console.error('[postback] CPX błąd:', e.message); }
});

app.all('/api/theoremreach-postback/:key?', async (req, res) => {
    const q = { ...(req.body || {}), ...req.query };
    const uid = String(q.user_id || q.uid || '').trim();
    const reward = parseFloat(q.reward);
    const txId = String(q.tx_id || '').trim();
    const isReversal = String(q.reversal) === 'true';

    if (!postbackAllowed(req.params.key, 'TheoremReach')) return res.status(403).send('0');
    if (String(q.debug) === 'true') return res.status(200).send('1');
    if (!uid || !Number.isFinite(reward)) return res.status(400).send('0');
    if (isReversal || reward <= 0) return res.status(200).send('1');
    if (reward > MAX_SURVEY_REWARD || !txId) return res.status(400).send('0');
    // bonus od właściciela nie za screenout
    const trScreenout = String(q.screenout || '').toLowerCase() === 'true';
    try { await creditSurvey(uid, reward, 'tr:' + txId, !trScreenout); return res.status(200).send('1'); }
    catch (e) { console.error('[postback] TR błąd:', e.message); return res.status(500).send('0'); }
});

app.get('/api/goals/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.json([]); res.json(user.goals); } catch (e) { res.json([]); }
});

app.post('/api/goals/add', async (req, res) => {
    const { username, title, target } = req.body;
    try {
        const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak usera' });
        const activeCount = user.goals.filter(g => g.status === 'active').length; if (activeCount >= 5) return res.status(400).json({ error: 'Limit 5 aktywnych celów osiągnięty!' });
        user.goals.push({ id: crypto.randomBytes(8).toString('hex'), title: title || 'Mój Cel', target: parseFloat(target), current: 0, status: 'active', imageUrl: '' });
        await user.save(); res.json({ success: true, goals: user.goals });
    } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/goals/cancel', async (req, res) => {
    const { username, goalId } = req.body;
    try {
        const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak usera' });
        const goalIndex = user.goals.findIndex(g => g.id === goalId); if (goalIndex === -1) return res.status(404).json({ error: 'Nie znaleziono celu' });
        let goal = user.goals[goalIndex]; if (goal.status !== 'active') return res.status(400).json({ error: 'Cel już zakończony' });
        goal.status = 'canceled'; const rollover = goal.current; goal.current = 0; if (rollover > 0) allocateGoalProgress(user, rollover); await user.save(); res.json({ success: true, goals: user.goals });
    } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

app.post('/api/goals/clear', async (req, res) => {
    const { username } = req.body;
    try { const safe = escapeRegex(username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.status(404).json({ error: 'Brak usera' }); user.goals = user.goals.filter(g => g.status === 'active'); await user.save(); res.json({ success: true, goals: user.goals }); } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
});

function maskEmail(e) {
    const s = String(e || '');
    if (!s) return '';
    const at = s.indexOf('@');
    if (at < 1) return s.slice(0, 3) + '***';
    return s.slice(0, Math.min(2, at)) + '***' + s.slice(at);
}

app.get('/api/points/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); let user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) { user = new User({ username: req.params.username.trim(), points: 0 }); await user.save(); } res.json({ points: user.points, referredBy: user.referredBy, linkedPayPal: maskEmail(user.linkedPayPal && String(user.linkedPayPal).startsWith('@') ? user.linkedPayPal : ''), verified: !!user.verified });; } catch (error) { res.json({ points: 0 }); }
});

app.get('/api/user-stats/:username', async (req, res) => {
    try {
        const safe = escapeRegex(req.params.username);
        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.json({ xp: 0, dailyEarned: 0, claimedLevels: [], lastWheelSpin: null, wheelStreak: 0 });
        const startOfDay = getPolandMidnight();
        const dailyEarnedAggr = await Earning.aggregate([{ $match: { username: new RegExp(`^${safe}$`, 'i'), createdAt: { $gte: startOfDay }, source: { $in: ['Survey', 'AdMob Video'] } } }, { $group: { _id: "$source", total: { $sum: "$amount" } } }]);
        const sumFor = src => { const g = dailyEarnedAggr.find(x => x._id === src); return g ? g.total : 0; };
        const actualDailyEarned = sumFor('Survey');
        const adsEarnedToday = sumFor('AdMob Video');
        let currentStreak = user.wheelStreak || 0;
        if (user.lastWheelSpin) { const diffHours = (new Date() - new Date(user.lastWheelSpin)) / (1000 * 60 * 60); if (diffHours > 48 && currentStreak !== 0) { currentStreak = 0; user.wheelStreak = 0; await user.save(); } }
        res.json({ xp: user.xp || 0, dailyEarned: actualDailyEarned, adsEarned: adsEarnedToday, claimedLevels: user.claimedLevels || [], lastWheelSpin: user.lastWheelSpin, wheelStreak: currentStreak });
    } catch (error) { res.json({ xp: 0, dailyEarned: 0, claimedLevels: [], lastWheelSpin: null, wheelStreak: 0 }); }
});

const LEVEL_THRESHOLDS = { 1: { xp: 1000, reward: 3 }, 2: { xp: 5000, reward: 8 }, 3: { xp: 15000, reward: 20 }, 4: { xp: 40000, reward: 50 }, 5: { xp: 100000, reward: 100 } };

app.post('/api/claim-level', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const level = Number(req.body.level);
    try {
        const user = await findUserCI(username);
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });
        const lvlData = LEVEL_THRESHOLDS[level];
        if (!Number.isInteger(level) || !lvlData) return res.status(400).json({ error: 'Nie możesz odebrać tego poziomu.' });

        const updated = await User.findOneAndUpdate(
            { _id: user._id, claimedLevels: { $ne: level }, xp: { $gte: lvlData.xp } },
            { $push: { claimedLevels: level }, $inc: { points: lvlData.reward } },
            { new: true }
        );
        if (!updated) return res.status(400).json({ error: 'Nie możesz odebrać tego poziomu.' });
        allocateGoalProgress(updated, lvlData.reward); await updated.save();
        await new Earning({ username: updated.username, amount: lvlData.reward, source: 'LevelUp', details: `Level ${level}` }).save();
        res.json({ success: true, reward: lvlData.reward, newBalance: updated.points });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/spin-wheel', async (req, res) => {
    const username = String(req.body.username || '').trim();
    try {
        const user = await findUserCI(username);
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });

        const startOfDay = getPolandMidnight();
        const dailyEarnedAggr = await Earning.aggregate([{ $match: { username: new RegExp(`^${escapeRegex(user.username)}$`, 'i'), createdAt: { $gte: startOfDay }, source: { $in: ['Survey'] } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const actualDailyEarned = dailyEarnedAggr.length > 0 ? dailyEarnedAggr[0].total : 0;
        if (actualDailyEarned < 4.5) return res.status(400).json({ error: 'Zarób dzisiaj minimum 4.50 R$ (Oferty/Ankiety), aby zakręcić kołem!' });

        const now = new Date();
        let streak = 1;
        if (user.lastWheelSpin) {
            const diffHours = (now - new Date(user.lastWheelSpin)) / (1000 * 60 * 60);
            if (diffHours < 24) return res.status(400).json({ error: 'Koło jest jeszcze zablokowane (trwa 24h blokady)!' });
            streak = diffHours <= 48 ? (user.wheelStreak || 0) + 1 : 1;
        }

        const rand = Math.random() * 100; let reward = 0.1;
        if (rand <= 1) reward = 2.5; else if (rand <= 5) reward = 1.0; else if (rand <= 20) reward = 0.5; else if (rand <= 55) reward = 0.2;

        const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const updated = await User.findOneAndUpdate(
            { _id: user._id, $or: [{ lastWheelSpin: null }, { lastWheelSpin: { $lte: cutoff } }] },
            { $set: { lastWheelSpin: now, wheelStreak: streak }, $inc: { points: reward } },
            { new: true }
        );
        if (!updated) return res.status(400).json({ error: 'Koło jest jeszcze zablokowane (trwa 24h blokady)!' });
        allocateGoalProgress(updated, reward); await updated.save();
        await new Earning({ username: updated.username, amount: reward, source: 'Wheel', details: `Streak: ${streak}` }).save();
        res.json({ success: true, reward, newBalance: updated.points, streak });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.get('/api/latest-earners', async (req, res) => { try { res.json(await Earning.find({ source: { $in: ['Survey', 'Promo', 'LevelUp', 'Spinner', 'Wheel', 'AdMob Video'] } }).sort({ createdAt: -1 }).limit(5)); } catch (e) { res.json([]); } });
app.get('/api/latest-payouts', async (req, res) => { try { res.json(await Payout.find({ status: 'Completed' }).select('username pointsWithdrawn createdAt').sort({ createdAt: -1 }).limit(5)); } catch (e) { res.json([]); } });
app.get('/api/leaderboard', async (req, res) => {
    try {
        const period = req.query.period || '7days'; const now = new Date(); let matchStage = { source: { $nin: ['Promo', 'Admin', 'BundleDeposit', 'BundleRefund', 'BundleRejected', 'BundleDone'] } };
        if (period !== 'alltime') { let startDate = new Date(); if (period === 'today') startDate = getPolandMidnight(); else if (period === '7days') startDate.setDate(now.getDate() - 7); else if (period === '30days') startDate.setDate(now.getDate() - 30); else if (period === 'year') startDate.setFullYear(now.getFullYear() - 1); matchStage.createdAt = { $gte: startDate }; }
        const leaderboard = await Earning.aggregate([{ $match: matchStage }, { $group: { _id: "$username", earned: { $sum: "$amount" } } }, { $sort: { earned: -1 } }, { $limit: 100 }, { $project: { _id: 0, username: "$_id", earned: 1 } }]); res.json(leaderboard);
    } catch (error) { res.status(500).json({ error: "Błąd podczas ładowania rankingu." }); }
});

app.get('/api/inbox/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); if (!user) return res.json([]); const unread = user.inbox.filter(msg => !msg.read); if (unread.length > 0) { user.inbox.forEach(msg => msg.read = true); await user.save(); } res.json(unread); } catch (error) { res.json([]); }
});

// =================== DISCORD: POŁĄCZENIE KONTA I TICKETY ===================
const DISCORD_LINK_TTL_MS = 10 * 60 * 1000;
const discordLinkStates = new Map(); // state -> { username, expires }
setInterval(() => { const now = Date.now(); for (const [k, v] of discordLinkStates) if (v.expires < now) discordLinkStates.delete(k); }, 10 * 60 * 1000).unref();

const TICKET_MAX_OPEN = 2;
const TICKET_MIN_LEN = 10;
const TICKET_MAX_LEN = 1500;
const ticketLocks = new Set();
const polandDayKey = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }); // np. 2026-11-20

// 1) gracz klika "Połącz z Discordem" -> dostaje adres logowania Discord
app.post('/api/discord/link-start', async (req, res) => {
    try {
        const user = await findUserCI(String(req.body.username || '').trim());
        if (!user) return res.status(404).json({ error: 'Nie znaleziono konta.' });
        if (user.discordLinkedId) return res.status(400).json({ error: 'Twoje konto ma już połączony Discord.', code: 'ALREADY' });
        const state = crypto.randomBytes(24).toString('hex');
        discordLinkStates.set(state, { username: user.username, expires: Date.now() + DISCORD_LINK_TTL_MS });
        const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify&state=${state}`;
        res.json({ url });
    } catch (e) { console.error('[discord-link] start:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

// 2) Discord wraca na /api/admin/callback z parametrem state -> zapisujemy Discord na koncie
async function discordLinkCallback(req, res, state) {
    const back = r => res.redirect('/?discord=' + r);
    const st = discordLinkStates.get(state);
    discordLinkStates.delete(state);
    if (!st || st.expires < Date.now()) return back('expired');
    if (req.query.error || !req.query.code) return back('cancel');
    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: REDIRECT_URI })
        });
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return back('error');
        const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tokenData.access_token}` } });
        const du = await userResponse.json();
        if (!du || !du.id) return back('error');

        const member = await discordBot.isGuildMember(du.id);
        if (member === null) return back('error');
        if (!member) return back('notmember');

        const updated = await User.findOneAndUpdate(
            { username: st.username, discordLinkedId: null },
            { $set: { discordLinkedId: String(du.id), discordLinkedName: String(du.username || ''), discordLinkedAt: new Date() } },
            { new: true }
        );
        if (!updated) return back('already');
        return back('ok');
    } catch (e) {
        if (e && e.code === 11000) return back('taken');
        console.error('[discord-link] callback:', e.message);
        return back('error');
    }
}

// 3) stan zakładki Support: czy Discord połączony + tickety gracza
app.get('/api/support-status/:username', async (req, res) => {
    try {
        const user = await findUserCI(req.params.username);
        if (!user) return res.json({ linked: false, discordName: '', tickets: [], maxOpen: TICKET_MAX_OPEN, guildId: discordBot.GUILD_ID });
        const tickets = await Ticket.find({ username: user.username, status: { $in: ['open', 'resolved'] }, channelId: { $ne: null } }).sort({ createdAt: -1 }).limit(10).lean();
        res.json({
            linked: !!user.discordLinkedId,
            discordName: user.discordLinkedName || '',
            maxOpen: TICKET_MAX_OPEN,
            guildId: discordBot.GUILD_ID,
            tickets: tickets.map(t => ({ name: t.channelName, channelId: t.channelId, status: t.status, createdAt: t.createdAt, deleteAt: t.deleteAt }))
        });
    } catch (e) { console.error('[tickety] status:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

// 4) nowy ticket -> prywatny kanał na Discordzie
async function createSupportTicket(req, res) {
    const username = String(req.body.username || '').trim();
    const message = String(req.body.message || '').trim();
    if (message.length < TICKET_MIN_LEN) return res.status(400).json({ error: `Opisz problem dokładniej (min. ${TICKET_MIN_LEN} znaków).`, code: 'SHORT' });
    if (message.length > TICKET_MAX_LEN) return res.status(400).json({ error: `Wiadomość jest za długa (max ${TICKET_MAX_LEN} znaków).`, code: 'LONG' });
    const lockKey = username.toLowerCase();
    if (ticketLocks.has(lockKey)) return res.status(429).json({ error: 'Poczekaj chwilę, poprzedni ticket jeszcze się tworzy.', code: 'BUSY' });
    ticketLocks.add(lockKey);
    try {
        const user = await findUserCI(username);
        if (!user) return res.status(404).json({ error: 'Nie znaleziono konta.' });
        if (!user.discordLinkedId) return res.status(400).json({ error: 'Najpierw połącz konto z Discordem.', code: 'NO_DISCORD' });
        const open = await Ticket.countDocuments({ username: user.username, status: 'open' });
        const blocked = accountBlock.isAccountBlocked(user); // zablokowany gracz: tylko 1 nierozwiązany ticket
        if (blocked && open >= 1) return res.status(400).json({ error: 'Masz już nierozwiązany ticket. Poczekaj na odpowiedź administracji.', code: 'LIMIT' });
        if (open >= TICKET_MAX_OPEN) return res.status(400).json({ error: `Masz już ${open} nierozwiązane tickety. Poczekaj, aż administracja je rozwiąże.`, code: 'LIMIT' });

        const member = await discordBot.isGuildMember(user.discordLinkedId);
        if (member === null) return res.status(503).json({ error: 'Bot Discord jest teraz niedostępny. Spróbuj za kilka minut.', code: 'BOT_DOWN' });
        if (!member) return res.status(400).json({ error: 'Nie ma Cię na naszym serwerze Discord. Dołącz i spróbuj ponownie.', code: 'NOT_MEMBER' });

        const dayKey = polandDayKey();
        const counter = await Counter.findOneAndUpdate({ _id: 'ticket-' + dayKey }, { $inc: { seq: 1 } }, { new: true, upsert: true });
        const ticket = await new Ticket({ username: user.username, discordId: user.discordLinkedId, discordName: user.discordLinkedName, message, dayKey, number: counter.seq, blockAppeal: blocked }).save();

        let channel;
        try { channel = await discordBot.createTicketChannel(ticket); }
        catch (e) {
            console.error('[tickety] tworzenie kanału:', e.message);
            await Ticket.updateOne({ _id: ticket._id }, { $set: { status: 'failed' } }).catch(() => {});
            return res.status(500).json({ error: 'Nie udało się utworzyć ticketu na Discordzie. Spróbuj za chwilę.', code: 'CREATE_FAILED' });
        }
        await Ticket.updateOne({ _id: ticket._id }, { $set: { channelId: channel.id, channelName: channel.name } });
        return res.json({ success: true, message: 'Ticket utworzony!', channelName: channel.name, channelUrl: `https://discord.com/channels/${discordBot.GUILD_ID}/${channel.id}` });
    } catch (e) {
        console.error('[tickety] nowy ticket:', e.message);
        return res.status(500).json({ error: 'Błąd serwera.' });
    } finally {
        ticketLocks.delete(lockKey);
    }
}
app.post('/api/support-ticket', createSupportTicket);

const MIN_PAYOUT = 1;

function normalizeRevtag(v) {
    const s = String(v || '').trim().replace(/^@+/, '').toLowerCase();
    return /^[a-z0-9]{3,16}$/.test(s) ? '@' + s : null;
}

app.post('/api/withdraw', async (req, res) => {
    const useLinked = req.body.useLinked === true;
    const revtag = normalizeRevtag(req.body.payoutAddress);
    const username = String(req.body.username || '').trim();
    const pts = Math.round(Number(req.body.points) * 100) / 100;

    if (!username) return res.status(400).json({ error: 'Brak nazwy użytkownika.' });
    if (!Number.isFinite(pts) || pts < MIN_PAYOUT) return res.status(400).json({ error: `Minimalna wypłata to ${MIN_PAYOUT} R$.` });
    if (!useLinked && !revtag) return res.status(400).json({ error: 'Nieprawidłowy Revtag. Ma 3–16 znaków: małe litery i cyfry (np. @twojrevtag).' });

    try {
        const safe = escapeRegex(username);
        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') });
        if (!user) return res.status(400).json({ error: 'Nie masz tylu R$!' });
        if (user.payoutBlocked) return res.status(403).json({ error: 'Wypłaty na tym koncie są zablokowane. Napisz do administracji przez Support.' });

        const linked = user.linkedPayPal && String(user.linkedPayPal).startsWith('@') ? String(user.linkedPayPal).toLowerCase() : null;

        let payAddress = revtag;
        if (useLinked) {
            if (!linked) return res.status(400).json({ error: 'Brak przypisanego Revtag. Wpisz go w oknie wypłaty.' });
            payAddress = linked;
        } else if (linked && linked !== revtag) {
            return res.status(400).json({ error: 'To konto ma już przypisany inny Revtag. Zmiana tylko przez Support.' });
        }

        const updated = await User.findOneAndUpdate(
            { _id: user._id, points: { $gte: pts }, payoutBlocked: { $ne: true } },
            { $inc: { points: -pts }, $set: { linkedPayPal: linked || payAddress } },
            { new: true }
        );
        if (!updated) return res.status(400).json({ error: 'Nie masz tylu R$!' });

        const usdAmount = parseFloat((pts * 0.025).toFixed(2));
        const newPayout = await new Payout({
            username: updated.username, payoutMethod: 'Revolut', payoutAddress: payAddress,
            paypalEmail: payAddress, pointsWithdrawn: pts, usdAmount, status: 'Pending Manual'
        }).save();
        discordBot.sendPayoutAlert(newPayout);
        res.json({ success: true, newBalance: updated.points, usd: usdAmount });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

// --- KODY PROMOCYJNE I POLECENIA ---

app.post('/api/redeem-promo', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const promoCode = String(req.body.promoCode || '').trim();
    if (!username || !promoCode) return res.status(400).json({ error: 'Brak danych.' });
    try {
        let user = await findUserCI(username);
        if (!user) user = await new User({ username, points: 0 }).save();
        
        const promo = await PromoCode.findOne({ code: promoCode.toUpperCase() });
        if (!promo || promo.currentUses >= promo.maxUses || promo.usedBy.includes(user.username.toLowerCase())) {
            return res.status(400).json({ error: 'Kod nieprawidłowy, zużyty lub już go odebrałeś!' });
        }

        promo.currentUses += 1;
        promo.usedBy.push(user.username.toLowerCase());
        await promo.save();

        const updated = await User.findOneAndUpdate(
            { _id: user._id },
            { $inc: { points: promo.reward }, $push: { redeemedPromoCodes: { code: promo.code, reward: promo.reward, date: new Date() } } },
            { new: true }
        );
        
        allocateGoalProgress(updated, promo.reward); await updated.save();
        await new Earning({ username: updated.username, amount: promo.reward, source: 'Promo', details: promo.code }).save();
        res.json({ success: true, newBalance: updated.points, message: `Odebrano ${promo.reward} R$!` });
    } catch (error) { res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.get('/api/promo-history/:username', async (req, res) => { 
    try { 
        const safe = escapeRegex(req.params.username); 
        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') }); 
        if (!user) return res.json([]); 
        const history = user.redeemedPromoCodes || []; 
        history.sort((a, b) => new Date(b.date) - new Date(a.date)); 
        res.json(history); 
    } catch (error) { res.status(500).json({ error: "Error" }); } 
});

app.post('/api/redeem-code', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const code = String(req.body.code || '').trim();
    if (!username || !code) return res.status(400).json({ error: 'Missing data.' });
    if (username.toLowerCase() === code.toLowerCase()) return res.status(400).json({ error: "Can't refer yourself!" });
    try {
        let user = await findUserCI(username);
        if (!user) user = await new User({ username, points: 0 }).save();
        if (user.referredBy) return res.status(400).json({ error: 'Already used referral code!' });
        const referrer = await findUserCI(code);
        if (!referrer) return res.status(404).json({ error: 'Referral not found.' });
        if (String(referrer._id) === String(user._id)) return res.status(400).json({ error: "Can't refer yourself!" });

        const set = await User.findOneAndUpdate({ _id: user._id, referredBy: null }, { $set: { referredBy: referrer.username } }, { new: true });
        if (!set) return res.status(400).json({ error: 'Already used referral code!' });
        await User.updateOne({ _id: referrer._id }, { $addToSet: { referredUsers: user.username } });
        res.json({ success: true, message: 'Code activated!' });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

// --- HISTORIA DLA STRONY ---
app.get('/api/earning-history/:username', async (req, res) => {
    try { const safe = escapeRegex(req.params.username); const regex = new RegExp(`^${safe}$`, 'i'); const earnings = await Earning.find({ username: regex }).lean(); const payouts = await Payout.find({ username: regex }).select('pointsWithdrawn usdAmount status createdAt').lean(); const combined = [...earnings.map(e => ({ ...e, recordType: 'earning' })), ...payouts.map(p => ({ ...p, recordType: 'payout' }))]; combined.sort((a, b) => b.createdAt - a.createdAt); res.json(combined.slice(0, 100)); } catch (error) { res.status(500).json({ error: "Error" }); }
});

// --- HISTORIA DLA MOBILE ---
app.get('/api/history/:username', async (req, res) => {
    try { 
        const safe = escapeRegex(req.params.username); 
        const regex = new RegExp(`^${safe}$`, 'i'); 
        const earnings = await Earning.find({ username: regex }).lean(); 
        const payouts = await Payout.find({ username: regex }).select('pointsWithdrawn usdAmount status createdAt').lean(); 
        const combined = [...earnings.map(e => ({ ...e, recordType: 'earning' })), ...payouts.map(p => ({ ...p, recordType: 'payout' }))]; 
        combined.sort((a, b) => b.createdAt - a.createdAt); 
        
        const historyMap = combined.slice(0, 100).map(item => {
            const dateStr = new Date(item.createdAt).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            let amt = item.recordType === 'payout' ? -(item.pointsWithdrawn || 0) : (item.amount || 0);
            return { date: dateStr, amount: Number(amt.toFixed(3)), source: item.source };
        });
        res.json({ history: historyMap }); 
    } catch (error) { res.status(500).json({ error: "Error" }); }
});

// --- LISTA ZAPROSZONYCH GRACZY (kto dołączył z mojego linku/kodu) ---
app.get('/api/referral-list/:username', async (req, res) => {
    try {
        const me = await findUserCI(req.params.username);
        if (!me) return res.json({ total: 0, users: [] });
        const invited = await User.find({ referredBy: me.username }).select('username').sort({ _id: -1 }).limit(500).lean();
        const sums = await Earning.aggregate([
            { $match: { username: me.username, source: { $in: ['Referral', 'ReferralReversal'] } } },
            { $group: { _id: { $toLower: '$details' }, total: { $sum: '$amount' } } }
        ]);
        const byNick = new Map(sums.map(x => [x._id, x.total]));
        const fixParts = await require('./referral-fix').fixPartsFor(me.username); // jednorazowe wyrównanie zaległych bonusów
        const users = invited.map(u => {
            const k = String(u.username).toLowerCase();
            return { username: u.username, joinedAt: u._id.getTimestamp(), earned: Math.round(((byNick.get(k) || 0) + (fixParts.get(k) || 0)) * 100) / 100 };
        });
        users.sort((a, b) => b.earned - a.earned);
        res.json({ total: invited.length, users });
    } catch (e) { console.error('[polecenia] lista:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

// --- NOWE ZAROBKI POLECONYCH (Z FILTRAMI I ODJĘCIEM) ---
app.get('/api/referral-stats/:username', async (req, res) => {
    try {
        const safe = escapeRegex(req.params.username); const period = req.query.period || '7days'; 
        let startDate = new Date(0); const now = new Date();
        
        if (period === 'today') { startDate = getPolandMidnight(); } 
        else if (period === 'yesterday') { startDate = getPolandMidnight(); startDate.setDate(startDate.getDate() - 1); }
        else if (period === '7days') { startDate = new Date(now.setDate(now.getDate() - 7)); } 
        else if (period === '30days') { startDate = new Date(now.setDate(now.getDate() - 30)); }
        
        let endDate = new Date();
        if (period === 'yesterday') { endDate = getPolandMidnight(); }

        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') });
        if (!user) return res.json({ iEarnedForReferrer: [], myReferralsEarnedForMe: [], totalMyCommission: 0, totalCommissionSent: 0 });

        const myReferralsEarnedForMe = await Earning.find({ username: user.username, source: 'Referral', createdAt: { $gte: startDate, $lte: endDate } }).sort({ createdAt: -1 }).lean();
        
        let totalCommission = 0;
        const myRefList = myReferralsEarnedForMe.map(e => {
            totalCommission += e.amount;
            return {
                date: new Date(e.createdAt).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
                username: e.details,
                commission: e.amount
            }
        });

        const iEarnedForReferrer = [];
        let totalSent = 0;
        
        // Zamiast symulować 15% z ankiet, sprawdzamy komu FAKTYCZNIE baza nabiła z Ciebie R$
        const actualCommissionsSent = await Earning.find({ 
            source: 'Referral', 
            details: new RegExp(`^${safe}$`, 'i'), 
            createdAt: { $gte: startDate, $lte: endDate } 
        }).sort({ createdAt: -1 }).lean();

        actualCommissionsSent.forEach(e => {
            totalSent += e.amount;
            iEarnedForReferrer.push({
                date: new Date(e.createdAt).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
                myEarning: parseFloat((e.amount / 0.15).toFixed(2)), 
                commissionSent: e.amount,
                recipient: e.username // Zapisujemy kto dostał od Ciebie prowizję
            });
        });

        res.json({
            totalMyCommission: parseFloat(totalCommission.toFixed(2)),
            totalCommissionSent: parseFloat(totalSent.toFixed(2)),
            myReferralsEarnedForMe: myRefList, // Usunięty limit top 10
            iEarnedForReferrer: iEarnedForReferrer // Usunięty limit top 10
        });

    } catch (error) { res.json({ iEarnedForReferrer: [], myReferralsEarnedForMe: [], totalMyCommission: 0, totalCommissionSent: 0 }); }
});

// =================== TIMEWALL ===================
const TIMEWALL_SECRET = process.env.TIMEWALL_SECRET || '';
const TIMEWALL_MAX_REWARD = 3000;   // maks. nagroda za jedną transakcję (R$)
const TIMEWALL_RS_PER_USD = 15;     // przelicznik z panelu TimeWall ($1.00 = 15 R$)

function timewallHashOk(userid, revenue, given) {
    if (!TIMEWALL_SECRET) return false;
    const expected = crypto.createHash('sha256').update(String(userid) + String(revenue) + TIMEWALL_SECRET).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(given || '').toLowerCase());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function reverseOfferwall(userId, originalTxId, fallbackAmount, reversalTxId, label) {
    const user = await findUserCI(userId);
    if (!user) return 'no_user';
    const original = originalTxId ? await Earning.findOne({ source: 'Survey', txId: originalTxId }) : null;
    const amount = original ? original.amount : fallbackAmount;
    if (!Number.isFinite(amount) || amount <= 0 || amount > TIMEWALL_MAX_REWARD) return 'bad_amount';

    try { await new Earning({ username: user.username, amount: -amount, source: 'Reversal', details: label, txId: reversalTxId }).save(); }
    catch (e) { if (e && e.code === 11000) return 'duplicate'; throw e; }

    await User.updateOne({ _id: user._id }, { $inc: { points: -amount } });
    await reverseOwnerBonus(Earning, User, user, originalTxId);

    if (user.referredBy) {
        const bonus = parseFloat((amount * 0.15).toFixed(2));
        if (bonus > 0) {
            const referrer = await User.findOneAndUpdate({ username: user.referredBy }, { $inc: { points: -bonus } });
            if (referrer) await new Earning({ username: referrer.username, amount: -bonus, source: 'ReferralReversal', details: user.username }).save();
        }
    }
    return 'ok';
}

app.get('/postback/timewall', async (req, res) => {
    if (!TIMEWALL_SECRET) { console.error('[timewall] brak zmiennej TIMEWALL_SECRET'); return res.status(500).send('ERR'); }

    const useridRaw = String(req.query.userid || '');
    const revenueRaw = String(req.query.revenue || '');
    const userid = useridRaw.trim();
    const txid = String(req.query.txid || '').trim();
    const type = String(req.query.type || '').trim().toLowerCase();
    const originalTxid = String(req.query.original_txid || '').trim();
    const revenue = parseFloat(revenueRaw);
    const currency = parseFloat(req.query.currency);

    if (!userid || !txid || revenueRaw === '') return res.status(400).send('ERR');
    if (!timewallHashOk(useridRaw, revenueRaw, req.query.hash)) { console.warn('[timewall] zły podpis (hash)'); return res.status(403).send('ERR'); }

    if (type === 'hold' || type === 'hold_cancelled') return res.status(200).send('OK');
    if (!Number.isFinite(revenue) || !Number.isFinite(currency)) return res.status(400).send('ERR');

    const isChargeback = type === 'chargeback' || (type === '' && currency < 0);
    const isCredit = type === 'credit' || (type === '' && currency > 0);
    if (!isChargeback && !isCredit) { return res.status(200).send('OK'); }

    const expected = Math.abs(revenue) * TIMEWALL_RS_PER_USD;
    const amount = Math.round(Math.abs(currency) * 100) / 100;
    if (Math.abs(Math.abs(currency) - expected) > Math.max(0.02, expected * 0.02)) {
        return res.status(400).send('ERR');
    }
    if (!(amount > 0) || amount > TIMEWALL_MAX_REWARD) return res.status(400).send('ERR');

    try {
        if (isCredit) await creditSurvey(userid, amount, 'tw:' + txid);
        else await reverseOfferwall(userid, originalTxid ? 'tw:' + originalTxid : '', amount, 'tw-cb:' + txid, 'TimeWall');
        return res.status(200).send('OK');
    } catch (e) { return res.status(500).send('ERR'); }
});

// =================== WERYFIKACJA PODPISU ADMOB (SSV) ===================
let admobKeysCache = { keys: {}, fetchedAt: 0 };

async function loadAdmobKeys() {
    const res = await fetch('https://www.gstatic.com/admob/reward/verifier-keys.json');
    if (!res.ok) throw new Error('Nie udalo sie pobrac kluczy AdMob: ' + res.status);
    const data = await res.json();
    const keys = {};
    for (const k of (data.keys || [])) keys[String(k.keyId)] = k.pem;
    admobKeysCache = { keys, fetchedAt: Date.now() };
}

async function verifyAdmobSignature(originalUrl, fetchKeys = loadAdmobKeys) {
    const queryString = String(originalUrl).split('?')[1] || '';
    const sigIndex = queryString.indexOf('&signature=');
    if (sigIndex === -1) return { ok: false, reason: 'brak parametru signature' };

    const dataToVerify = queryString.substring(0, sigIndex);
    const params = new URLSearchParams(queryString.substring(sigIndex + 1));
    const signature = params.get('signature');
    const keyId = params.get('key_id');
    if (!signature || !keyId) return { ok: false, reason: 'brak signature lub key_id' };

    const cacheOld = Date.now() - admobKeysCache.fetchedAt > 24 * 60 * 60 * 1000;
    if (cacheOld || !admobKeysCache.keys[keyId]) await fetchKeys();
    const pem = admobKeysCache.keys[keyId];
    if (!pem) return { ok: false, reason: 'nieznany key_id ' + keyId };

    const sig = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    // Google podpisuje dokładnie to, co wysłał. Serwer pośredni (proxy) mógł zmienić kodowanie znaków
    // w adresie (np. %24 -> $), więc sprawdzamy też warianty z przywróconym kodowaniem.
    // Bez prawdziwego podpisu Google żaden wariant nie przejdzie.
    const candidates = [dataToVerify];
    try {
        const parts = dataToVerify.split('&').map(p => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; });
        const dec = s => decodeURIComponent(s.replace(/\+/g, ' '));
        const javaEnc = s => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        for (const enc of [encodeURIComponent, javaEnc, s => s]) {
            const v = parts.map(([k, val]) => k + '=' + enc(dec(val))).join('&');
            if (candidates.indexOf(v) === -1) candidates.push(v);
        }
    } catch (e) {}
    for (let i = 0; i < candidates.length; i++) {
        const verifier = crypto.createVerify('SHA256');
        verifier.update(candidates[i]);
        if (verifier.verify(pem, sig)) return { ok: true, variant: i };
    }
    return { ok: false, reason: 'podpis nie pasuje' };
}

// =================== ADMOB REWARDED VIDEO (SSV) ===================

const ADMOB_AVG_REVENUE_USD = 0.0005; 
const ADMOB_PLAYER_SHARE = 0.60;
const ROBUX_COST_USD = 0.025;
const CALCULATED_REWARD_RS = (ADMOB_AVG_REVENUE_USD * ADMOB_PLAYER_SHARE) / ROBUX_COST_USD;

app.get('/api/mobile-config', (req, res) => {
    res.json({
        minVersionCode: 9, // To zablokuje stare apki i wymusi pobranie wersji z reklamami
        playStoreUrl: 'market://details?id=com.rbxrewards.mobile'
    });
});

app.get('/api/admob-settings', (req, res) => {
    res.json({
        rewardAmount: parseFloat(CALCULATED_REWARD_RS.toFixed(3)),
        buttonText: `Obejrzyj wideo za ${CALCULATED_REWARD_RS.toFixed(3)} R$`
    });
});

const ADMOB_REWARDED_UNIT_ID = '9266337617'; // z ca-app-pub-6665069359963275/9266337617

app.get('/api/admob-reward', async (req, res) => {
    const { user_id, transaction_id, ad_unit } = req.query;

    // 1) podpis Google: bez niego każdy mógłby sam wywołać ten adres i dopisać sobie R$
    try {
        const check = await verifyAdmobSignature(req.originalUrl);
        if (!check.ok) {
            console.warn('[AdMob SSV] Odrzucono:', check.reason, '| adres:', req.originalUrl);
            return res.status(403).send('Invalid signature');
        }
        if (check.variant) console.log('[AdMob SSV] Podpis OK po przywróceniu kodowania (wariant ' + check.variant + ')');
    } catch (e) {
        console.error('[AdMob SSV] Błąd weryfikacji podpisu:', e.message);
        return res.status(500).send('Verification error'); // AdMob ponowi wywołanie
    }

    // 2) to musi być NASZA reklama (podpisane żądanie może wysłać też ktoś z własnym kontem AdMob)
    const unit = String(ad_unit || '');
    if (unit !== ADMOB_REWARDED_UNIT_ID && !unit.endsWith('/' + ADMOB_REWARDED_UNIT_ID)) {
        console.warn('[AdMob SSV] Odrzucono: cudza reklama', unit);
        return res.status(403).send('Wrong ad unit');
    }
    if (!user_id || !transaction_id) return res.status(400).send('Brak wymaganych parametrow');

    try {
        const user = await User.findOne({ username: new RegExp(`^${escapeRegex(String(user_id).trim())}$`, 'i') });
        if (!user) return res.status(200).send('User not found');

        const reward = parseFloat(CALCULATED_REWARD_RS.toFixed(3)); // tyle, ile pokazuje przycisk w aplikacji

        // najpierw zajmujemy transakcję (unikalny indeks), potem dopisujemy punkty: powtórka nie da ich drugi raz
        let saved;
        try {
            saved = await new Earning({ username: user.username, amount: reward, source: 'AdMob Video', details: 'Reklama wideo w aplikacji', txId: 'admob:' + transaction_id }).save();
        } catch (e) {
            if (e && e.code === 11000) return res.status(200).send('Already processed');
            throw e;
        }
        try {
            const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { points: reward } }, { new: true });
            await addXPAndDailyEarned(updated, reward);
            allocateGoalProgress(updated, reward);
            await updated.save();
        } catch (e) {
            await Earning.deleteOne({ _id: saved._id }).catch(() => {});
            throw e;
        }
        return res.status(200).send('OK');
    } catch (error) {
        console.error('[AdMob SSV] Błąd serwera:', error.message);
        return res.status(500).send('Server Error');
    }
});

// =================== PAKIETY (BUNDLES) ===================
const BUNDLE_CATEGORIES = { robux: 'Robux', wt: 'War Thunder', ss: 'Star Stable' };
const BUNDLE_OFFERS = {
    robux: [
        { id: 'rb50',  title: '50 Robux',  price: 80 },
        { id: 'rb100', title: '100 Robux', price: 150 },
        { id: 'rb175', title: '175 Robux', price: 195 },
        { id: 'rb200', title: '200 Robux', price: 225 }
    ],
    ss: [
        { id: 'ss500',   title: '500 Star Coins',   price: 665 },
        { id: 'ss1000',  title: '1000 Star Coins',  price: 1200 },
        { id: 'ss2000',  title: '2000 Star Coins',  price: 1625 },
        { id: 'ss5000',  title: '5000 Star Coins',  price: 2570 },
        { id: 'ss10000', title: '10000 Star Coins', price: 3850 }
    ],
    wt: [
        { id: 'wt150',   title: '150 GE',   price: 50 },
        { id: 'wt1000',  title: '1000 GE',  price: 325 },
        { id: 'wt2500',  title: '2500 GE',  price: 815 },
        { id: 'wt5000',  title: '5000 GE',  price: 1250 },
        { id: 'wt10000', title: '10000 GE', price: 2440 },
        { id: 'wt25000', title: '25000 GE', price: 5620 }
    ]
};
const BUNDLE_CUSTOM = { minUsd: 10, maxUsd: 500, rsPerUsd: 44, approxRobuxPerUsd: 65.4 };
const BUNDLE_MAX_OPEN = 2;
const BUNDLE_NAME_RE = /^[A-Za-z0-9_.\-]{2,32}$/;

const toC = v => Math.round(Number(v) * 100);
const fromC = c => c / 100;
const cleanName = v => String(v || '').trim();
const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const bundleLabel = b => `${BUNDLE_CATEGORIES[b.category]} – ${b.title}`;

function resolveBundleOffer(category, offerId, customUsd) {
    if (!BUNDLE_CATEGORIES[category]) return null;
    if (category === 'robux' && offerId === 'custom') {
        const usd = Number(customUsd);
        if (!Number.isInteger(usd) || usd < BUNDLE_CUSTOM.minUsd || usd > BUNDLE_CUSTOM.maxUsd) return null;
        return { id: 'custom', title: `Custom $${usd}`, price: usd * BUNDLE_CUSTOM.rsPerUsd, customUsd: usd, approxRobux: Math.floor(usd * BUNDLE_CUSTOM.approxRobuxPerUsd) };
    }
    const offer = BUNDLE_OFFERS[category].find(o => o.id === offerId);
    return offer ? { ...offer, customUsd: 0, approxRobux: 0 } : null;
}

function bundleView(b) {
    return {
        id: String(b._id), category: b.category, categoryLabel: BUNDLE_CATEGORIES[b.category], title: b.title,
        price: fromC(b.priceC), deposited: fromC(b.depositedC),
        percent: Math.min(100, Math.round(b.depositedC / b.priceC * 1000) / 10),
        status: b.status, approxRobux: b.approxRobux || 0, createdAt: b.createdAt, paidAt: b.paidAt || null
    };
}

app.get('/api/bundles/offers', (req, res) => {
    res.json({ categories: BUNDLE_CATEGORIES, offers: BUNDLE_OFFERS, custom: BUNDLE_CUSTOM, maxOpen: BUNDLE_MAX_OPEN });
});

app.get('/api/bundles/:username', async (req, res) => {
    try {
        const user = await findUserCI(cleanName(req.params.username));
        const empty = { verified: false, profile: { robloxName: '', gaijinId: '', discordName: '' }, bundles: [], current: null };
        if (!user) return res.json(empty);
        const all = await Bundle.find({ username: user.username }).sort({ createdAt: 1 }).lean();
        const filling = all.filter(b => b.status === 'filling');
        const paid = all.filter(b => b.status === 'paid');
        const closed = all.filter(b => b.status !== 'filling' && b.status !== 'paid').reverse().slice(0, 30);
        res.json({
            verified: !!user.verified,
            profile: { robloxName: user.robloxName || '', gaijinId: user.gaijinId || '', discordName: user.discordName || '' },
            bundles: [...filling, ...paid, ...closed].map(bundleView),
            current: filling.length ? bundleView(filling[0]) : null
        });
    } catch (e) { console.error('[bundles] list:', e.message); res.json({ verified: false, profile: {}, bundles: [], current: null }); }
});

app.post('/api/bundles/create', async (req, res) => {
    try {
        const category = String(req.body.category || '');
        const offer = resolveBundleOffer(category, String(req.body.offerId || ''), req.body.customUsd);
        if (!offer) return res.status(400).json({ error: 'Nieprawidłowy pakiet.' });

        const gameId = cleanName(req.body.gameId);
        const discord = cleanName(req.body.discord);
        if (category !== 'ss' && !BUNDLE_NAME_RE.test(gameId)) return res.status(400).json({ error: category === 'wt' ? 'Nieprawidłowe ID Gaijin.' : 'Nieprawidłowy nick Roblox.' });
        if (!BUNDLE_NAME_RE.test(discord)) return res.status(400).json({ error: 'Nieprawidłowa nazwa Discord.' });

        const user = await findUserCI(cleanName(req.body.username));
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });

        const gameField = category === 'wt' ? 'gaijinId' : (category === 'ss' ? null : 'robloxName');
        if (gameField && user[gameField] && !sameText(user[gameField], gameId)) return res.status(400).json({ error: `To konto ma na stałe przypisane: ${user[gameField]}. Zmiana tylko przez Support.` });
        if (user.discordName && !sameText(user.discordName, discord)) return res.status(400).json({ error: `To konto ma na stałe przypisany Discord: ${user.discordName}. Zmiana tylko przez Support.` });

        const open = await Bundle.countDocuments({ username: user.username, category, status: { $in: ['filling', 'paid'] } });
        if (open >= BUNDLE_MAX_OPEN) return res.status(400).json({ error: `Możesz mieć maksymalnie ${BUNDLE_MAX_OPEN} aktywne pakiety w tej kategorii.` });

        const set = {};
        if (gameField && !user[gameField]) set[gameField] = gameId;
        if (!user.discordName) set.discordName = discord;
        if (Object.keys(set).length) await User.updateOne({ _id: user._id }, { $set: set });

        const bundle = await new Bundle({
            username: user.username, category, offerId: offer.id, title: offer.title, priceC: toC(offer.price),
            customUsd: offer.customUsd, approxRobux: offer.approxRobux, gameId: gameField ? (user[gameField] || gameId) : '', discord: user.discordName || discord
        }).save();
        res.json({ success: true, bundle: bundleView(bundle) });
    } catch (e) { console.error('[bundles] create:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/bundles/deposit', async (req, res) => {
    try {
        const user = await findUserCI(cleanName(req.body.username));
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });
        const amountC = toC(req.body.amount);
        if (!Number.isInteger(amountC) || amountC <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
        if (!mongoose.Types.ObjectId.isValid(req.body.bundleId)) return res.status(400).json({ error: 'Nieprawidłowy pakiet.' });

        const bundle = await Bundle.findOne({ _id: req.body.bundleId, username: user.username });
        if (!bundle) return res.status(404).json({ error: 'Nie znaleziono pakietu.' });
        if (bundle.status !== 'filling') return res.status(400).json({ error: 'Ten pakiet jest już opłacony lub zamknięty.' });
        const remainingC = bundle.priceC - bundle.depositedC;
        if (amountC > remainingC) return res.status(400).json({ error: `Do pełnej kwoty pakietu brakuje ${fromC(remainingC).toFixed(2)} R$.` });

        const amount = fromC(amountC);
        const charged = await User.findOneAndUpdate({ _id: user._id, points: { $gte: amount } }, { $inc: { points: -amount } }, { new: true });
        if (!charged) return res.status(400).json({ error: 'Nie masz tylu R$!' });
        await new Earning({ username: user.username, amount: -amount, source: 'BundleDeposit', details: bundleLabel(bundle) }).save();

        const filled = await Bundle.findOneAndUpdate(
            { _id: bundle._id, status: 'filling', depositedC: { $lte: bundle.priceC - amountC } },
            { $inc: { depositedC: amountC } }, { new: true }
        );
        if (!filled) {
            await User.updateOne({ _id: user._id }, { $inc: { points: amount } });
            await new Earning({ username: user.username, amount: amount, source: 'BundleRefund', details: bundleLabel(bundle) }).save();
            return res.status(400).json({ error: 'Pakiet właśnie się zmienił, spróbuj ponownie.' });
        }

        let current = filled;
        if (filled.depositedC >= filled.priceC) {
            const paidBundle = await Bundle.findOneAndUpdate(
                { _id: bundle._id, status: 'filling', depositedC: { $gte: bundle.priceC } },
                { $set: { status: 'paid', paidAt: new Date() } }, { new: true }
            );
            if (paidBundle) {
                current = paidBundle;
                try { if (typeof discordBot.sendBundleAlert === 'function') await discordBot.sendBundleAlert(paidBundle, charged); }
                catch (err) { console.error('[bundles] alert Discord:', err.message); }
            }
        }
        res.json({ success: true, newBalance: charged.points, bundle: bundleView(current) });
    } catch (e) { console.error('[bundles] deposit:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

app.post('/api/bundles/withdraw', async (req, res) => {
    try {
        const user = await findUserCI(cleanName(req.body.username));
        if (!user) return res.status(404).json({ error: 'Brak użytkownika.' });
        if (!mongoose.Types.ObjectId.isValid(req.body.bundleId)) return res.status(400).json({ error: 'Nieprawidłowy pakiet.' });
        const bundle = await Bundle.findOne({ _id: req.body.bundleId, username: user.username });
        if (!bundle) return res.status(404).json({ error: 'Nie znaleziono pakietu.' });
        if (bundle.status !== 'filling') return res.status(400).json({ error: 'Z opłaconego pakietu nie można wycofać R$.' });

        let refundC = 0;
        if (req.body.cancel === true) {
            const old = await Bundle.findOneAndUpdate({ _id: bundle._id, status: 'filling' }, { $set: { status: 'canceled', doneAt: new Date() } });
            if (!old) return res.status(400).json({ error: 'Pakiet właśnie się zmienił, spróbuj ponownie.' });
            refundC = old.depositedC;
        } else {
            const amountC = toC(req.body.amount);
            if (!Number.isInteger(amountC) || amountC <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota.' });
            const dec = await Bundle.findOneAndUpdate({ _id: bundle._id, status: 'filling', depositedC: { $gte: amountC } }, { $inc: { depositedC: -amountC } });
            if (!dec) return res.status(400).json({ error: 'Tyle nie masz wpłacone w tym pakiecie.' });
            refundC = amountC;
        }

        let newBalance = user.points;
        if (refundC > 0) {
            const refund = fromC(refundC);
            const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { points: refund } }, { new: true });
            newBalance = updated.points;
            await new Earning({ username: user.username, amount: refund, source: 'BundleRefund', details: bundleLabel(bundle) }).save();
        }
        res.json({ success: true, refunded: fromC(refundC), newBalance });
    } catch (e) { console.error('[bundles] withdraw:', e.message); res.status(500).json({ error: 'Błąd serwera.' }); }
});

// =================== WEBSOCKETS (Zdarzenia) ===================
io.on('connection', (socket) => { 
    socket.on('user_joined', (username) => { if(username) onlineUsersMap.set(socket.id, username); });
    // czat: nick i odznakę (CEO / ADMIN z chat-roles.js) ustala serwer na podstawie sesji, nie tego, co wyśle przeglądarka
    let lastChatAt = 0;
    socket.on('chatMessage', async (data) => {
        try {
            let text = String((data && data.text) || '').trim();
            if (!text) return;
            const s = await getSession({ headers: { authorization: 'Bearer ' + String((data && data.token) || '') } });
            if (!s) return socket.emit('chatError', { code: 'SESSION' });
            const u = await User.findOne({ username: s.username }).select('username accountBlocked blockedUntil').lean();
            if (!u || accountBlock.isAccountBlocked(u)) return;
            const role = chatRoleFor(u.username);
            if (!role) { // zwykli gracze: max 300 znaków i 1 wiadomość na 1,5 s (CEO i ADMIN bez limitów)
                const now = Date.now();
                if (now - lastChatAt < 1500) return;
                lastChatAt = now;
                text = text.slice(0, 300);
            }
            io.emit('chatMessage', { username: u.username, text, role });
        } catch (e) { console.error('[czat]', e.message); }
    });
    socket.on('disconnect', () => { onlineUsersMap.delete(socket.id); });
});

app.get('/api/user-balance/:username', async (req, res) => {
    try {
        const safe = escapeRegex(req.params.username);
        const user = await User.findOne({ username: new RegExp(`^${safe}$`, 'i') });
        const currentBalance = user ? user.points : 0;
        res.json({ balance: currentBalance });
    } catch (error) {
        console.error('Błąd pobierania salda dla:', req.params.username, error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// --- PANEL ADMINA: strona /admin i adresy /api/admin/... są w pliku admin-routes.js ---
// --- POWIADOMIENIA (dzwonek): adresy /api/notifications/... są w pliku notifications.js ---
require('./notifications').registerNotificationRoutes(app, { User, findUserCI });
// --- BLOKADA KONTA: ekran blokady /api/block-status/... jest w pliku account-block.js ---
accountBlock.registerBlockRoutes(app, { User, Ticket, findUserCI, discordGuildId: () => discordBot.GUILD_ID });

require('./admin-routes')(app, {
    User, Earning, Payout, PromoCode, Bundle, Ticket, Session, discordBot, escapeRegex, getPolandMidnight, findUserCI, cleanName, onlineUsersMap,
    getDiscordClient: () => discordClient, discordLinkCallback,
    DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, REDIRECT_URI, ADMIN_PROMO_CHANNEL_ID
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Serwer śmiga na porcie ${PORT}`); });

if (discordClient) {
    discordClient.once('clientReady', () => { 
        console.log(`🤖 Bot Discord połączony!`); 
        discordBot.init(discordClient, dbModels); 
        errorAlerts.attachDiscord(discordClient);
    });
    discordClient.login(DISCORD_BOT_TOKEN).catch(console.error);
}
botAdmin.init();
botTwitch.init();