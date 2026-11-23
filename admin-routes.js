// =================== PANEL ADMINA (osobna strona /admin) ===================
// Logowanie przez Discord, uprawnienia (właściciel / administracja) i wszystkie adresy /api/admin/...
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { AdminLog, logAdmin } = require('./admin-log');
const { notify } = require('./notifications');
const { shareFor, BASE_SHARE } = require('./owner-bonus');

// ustawienia zapisane w bazie (np. uprawnienia adminów zmieniane w panelu)
const AdminSettingSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });
const AdminSetting = mongoose.models.AdminSetting || mongoose.model('AdminSetting', AdminSettingSchema);

const OWNER_DISCORD_ID = '398911896893521921';      // właściciel: może wszystko
const ADMIN_ROLE_ID = '1548633150870261791';        // rola administracji na serwerze Discord
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;     // zalogowanie trwa 12 godzin

// Uprawnienia do wyboru: 'payouts' (wypłaty), 'balance' (saldo graczy), 'promo' (kody promocyjne), 'verify' (weryfikacja graczy),
// 'block' (blokada wypłat gracza). Każdy admin WIDZI wszystko; KLIKAĆ może tylko to, co ma na swojej liście.
// Listy poniżej to ustawienia startowe - właściciel zmienia je w panelu (sekcja "Uprawnienia adminów"), zapis idzie do bazy.

// Konkretni admini po ID Discorda (każdy ze swoimi uprawnieniami). Wchodzą do panelu nawet bez roli na serwerze.
const ADMINS = {
    '1211371515048894486': { name: 'Aleks', permissions: [] },
    '710548443252391936': { name: 'Kruger', permissions: [] },
};

// Pozostali z rolą administracji na serwerze (nie wpisani wyżej) dostają to:
const ADMIN_PERMISSIONS = [];
const ALL_PERMISSIONS = ['payouts', 'balance', 'promo', 'verify', 'block'];
const PERMISSION_LABELS = { payouts: 'Wypłaty', balance: 'Saldo graczy', promo: 'Kody promo', verify: 'Weryfikacja', block: 'Blokada wypłat' };

module.exports = function registerAdminRoutes(app, d) {
    const { User, Earning, Payout, PromoCode, Bundle, Ticket, getDiscordClient, discordBot, escapeRegex, getPolandMidnight, findUserCI, cleanName,
        onlineUsersMap, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, REDIRECT_URI, ADMIN_PROMO_CHANNEL_ID, discordLinkCallback } = d;

    const tokens = new Map(); // token -> { expires, role, discordId, name }
    setInterval(() => { const now = Date.now(); for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k); }, 30 * 60 * 1000).unref();

    function getAuth(token) {
        const a = token ? tokens.get(String(token)) : null;
        if (!a) return null;
        if (a.expires < Date.now()) { tokens.delete(String(token)); return null; }
        return a;
    }
    // uprawnienia zmienione w panelu (z bazy); klucz = ID Discorda albo 'role' (pozostali z rolą)
    let permOverrides = {};
    AdminSetting.findOne({ key: 'perms' }).lean()
        .then(s => { if (s && s.value && typeof s.value === 'object') permOverrides = s.value; })
        .catch(e => console.error('[admin] wczytanie uprawnień:', e.message));

    const permsFor = a => {
        if (a.role === 'owner') return ALL_PERMISSIONS;
        const entry = ADMINS[a.discordId];
        let list;
        if (entry) list = Array.isArray(permOverrides[a.discordId]) ? permOverrides[a.discordId] : entry.permissions;
        else list = Array.isArray(permOverrides.role) ? permOverrides.role : ADMIN_PERMISSIONS;
        return list.filter(p => ALL_PERMISSIONS.includes(p));
    };
    const actor = req => ({ discordId: req.admin.discordId, name: req.admin.name, where: 'panel' });

    function isAdmin(req, res, next) {
        const a = getAuth(req.headers.authorization);
        if (!a) return res.status(403).json({ error: 'Brak dostępu!' });
        req.admin = a;
        next();
    }
    const requirePerm = perm => (req, res, next) => {
        if (permsFor(req.admin).includes(perm)) return next();
        return res.status(403).json({ error: 'Brak uprawnień do tej akcji.' });
    };

    async function hasAdminRole(discordId) {
        const client = getDiscordClient();
        if (!client || !client.isReady || !client.isReady()) return false;
        try {
            const guild = client.guilds.cache.get(discordBot.GUILD_ID) || await client.guilds.fetch(discordBot.GUILD_ID);
            const member = await guild.members.fetch({ user: String(discordId), force: true });
            return member.roles.cache.has(ADMIN_ROLE_ID);
        } catch (e) { return false; }
    }

    // --- strona panelu ---
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

    // --- logowanie przez Discord ---
    app.get('/api/admin/login', (req, res) => {
        const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
        res.redirect(authUrl);
    });

    app.get('/api/admin/callback', async (req, res) => {
        // z parametrem state = gracz łączy Discord w zakładce Support
        if (req.query.state) return discordLinkCallback(req, res, String(req.query.state));
        const code = req.query.code;
        if (!code) return res.redirect('/admin?error=NoCode');
        try {
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: String(code), redirect_uri: REDIRECT_URI })
            });
            const tokenData = await tokenResponse.json();
            if (!tokenData.access_token) return res.redirect('/admin?error=AuthFailed');
            const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tokenData.access_token}` } });
            const du = await userResponse.json();
            if (!du || !du.id) return res.redirect('/admin?error=AuthFailed');

            let role = null;
            if (String(du.id) === OWNER_DISCORD_ID) role = 'owner';
            else if (ADMINS[String(du.id)]) role = 'admin';
            else if (await hasAdminRole(du.id)) role = 'admin';
            if (!role) return res.redirect('/admin?error=Unauthorized');

            const token = crypto.randomBytes(32).toString('hex');
            tokens.set(token, { expires: Date.now() + ADMIN_TOKEN_TTL_MS, role, discordId: String(du.id), name: String(du.global_name || du.username || '') });
            return res.redirect(`/admin?token=${token}`);
        } catch (error) { console.error('[admin] logowanie:', error.message); return res.redirect('/admin?error=ServerError'); }
    });

    app.post('/api/admin/verify', (req, res) => {
        const a = getAuth(req.body && req.body.token);
        if (!a) return res.json({ success: false });
        res.json({ success: true, role: a.role, name: a.name, permissions: permsFor(a), allPermissions: ALL_PERMISSIONS });
    });

    app.post('/api/admin/logout', (req, res) => {
        const t = req.body && req.body.token;
        if (t) tokens.delete(String(t));
        res.json({ success: true });
    });

    // --- PODGLĄD (każdy admin) ---
    app.get('/api/admin/stats', isAdmin, async (req, res) => {
        try {
            const polandMidnight = getPolandMidnight();
            const dailyPointsAggr = await Earning.aggregate([
                { $match: { createdAt: { $gte: polandMidnight }, source: { $nin: ['Admin', 'Promo', 'BundleDeposit', 'BundleRefund', 'BundleRejected', 'BundleDone'] } } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]);
            const dailyRobux = dailyPointsAggr.length > 0 ? dailyPointsAggr[0].total : 0;
            // Do przeliczenia zysku: suma R$ z dzisiaj dla każdego źródła
            const bySourceAggr = await Earning.aggregate([
                { $match: { createdAt: { $gte: polandMidnight } } },
                { $group: { _id: '$source', total: { $sum: '$amount' } } }
            ]);
            const src = name => { const g = bySourceAggr.find(x => x._id === name); return g ? g.total : 0; };
            // przychód: tylko to, za co płacą partnerzy (ankiety/offerwalle minus cofnięte)
            const revenueRobux = src('Survey') + src('Reversal');
            // bonus od właściciela dla wybranych graczy (minus cofnięte)
            const ownerBonusRobux = src('OwnerBonus') + src('OwnerBonusReversal');
            // koszt: wszystkie R$ rozdane graczom (bez korekt admina i przesunięć na pakiety)
            const NOT_COST = ['Admin', 'BundleDeposit', 'BundleRefund', 'BundleRejected', 'BundleDone'];
            const costRobux = bySourceAggr.filter(g => !NOT_COST.includes(g._id)).reduce((s, g) => s + (g.total || 0), 0);
            // pakiety zrealizowane dzisiaj (status 'done'), w R$
            let bundlesDoneRobux = 0, bundlesDoneCount = 0;
            if (Bundle) {
                const bAggr = await Bundle.aggregate([
                    { $match: { status: 'done', doneAt: { $gte: polandMidnight } } },
                    { $group: { _id: null, totalC: { $sum: '$priceC' }, count: { $sum: 1 } } }
                ]);
                if (bAggr.length) { bundlesDoneRobux = (bAggr[0].totalC || 0) / 100; bundlesDoneCount = bAggr[0].count || 0; }
            }
            const pendingPayoutsAggr = await Payout.aggregate([
                { $match: { status: 'Pending Manual' } },
                { $group: { _id: null, total: { $sum: "$pointsWithdrawn" } } }
            ]);
            const pendingRobux = pendingPayoutsAggr.length > 0 ? pendingPayoutsAggr[0].total : 0;
            const uniqueOnline = new Set(onlineUsersMap.values()).size;
            res.json({ online: uniqueOnline, dailyRobux: dailyRobux, pendingRobux: pendingRobux, revenueRobux, costRobux, ownerBonusRobux, bundlesDoneRobux, bundlesDoneCount });
        } catch (err) { res.status(500).json({ error: 'Błąd statystyk' }); }
    });

    app.get('/api/admin/online', isAdmin, (req, res) => {
        res.json(Array.from(new Set(onlineUsersMap.values())).sort((a, b) => a.localeCompare(b)));
    });

    app.get('/api/admin/users/search', isAdmin, async (req, res) => {
        try {
            const q = (req.query.q || '').trim();
            if (q.length < 1) return res.json([]);
            const users = await User.find({ username: new RegExp(`^${escapeRegex(q)}`, 'i') }).select('username').sort({ username: 1 }).limit(20);
            res.json(users.map(u => u.username).sort((a, b) => a.localeCompare(b)));
        } catch (e) { res.status(500).json([]); }
    });

    app.get('/api/admin/user-details/:username', isAdmin, async (req, res) => {
        try {
            const regex = new RegExp(`^${escapeRegex(req.params.username.trim())}$`, 'i');
            const user = await User.findOne({ username: regex });
            if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza' });
            const pending = await Payout.find({ username: regex, status: 'Pending Manual' }).sort({ createdAt: -1 });
            const pendingSum = pending.reduce((sum, p) => sum + (p.pointsWithdrawn || 0), 0);
            // wartość salda: ile strona dostała od partnerów za te R$ (szacunek: saldo przy wypłacie / część gracza)
            const bal = Math.max(0, user.points || 0);
            const share = shareFor(user.username);
            const userUsd = bal * 0.025;
            const value = { worthUsd: userUsd / share };
            if (req.admin.role === 'owner') { // ile dostanie gracz i Twój zysk widzi tylko właściciel
                value.userUsd = userUsd;
                value.profitUsd = userUsd / share - userUsd;
                value.bonusShare = share > BASE_SHARE ? share : null;
            }
            res.json({ username: user.username, points: user.points, pendingSum: pendingSum, pendingRequests: pending, payoutBlocked: !!user.payoutBlocked, revtag: user.linkedPayPal || '', value });
        } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
    });

    app.get('/api/admin/pending-payouts', isAdmin, async (req, res) => {
        try { res.json(await Payout.find({ status: 'Pending Manual' }).sort({ createdAt: -1 })); }
        catch (e) { res.status(500).json([]); }
    });

    app.get('/api/admin/promo-codes', isAdmin, async (req, res) => {
        try {
            const codes = await PromoCode.find({}).sort({ _id: -1 });
            res.json(codes.filter(c => c.currentUses < c.maxUses));
        } catch (e) { res.status(500).json([]); }
    });

    app.get('/api/admin/bundle-users', isAdmin, async (req, res) => {
        try {
            const users = await User.find({ discordName: { $exists: true, $nin: ['', null] } })
                .select('username verified robloxName gaijinId discordName').sort({ verified: 1, username: 1 }).limit(200).lean();
            res.json(users);
        } catch (e) { res.status(500).json([]); }
    });

    // --- AKCJE (właściciel zawsze; admini tylko z ADMIN_PERMISSIONS) ---
    app.post('/api/admin/manage-balance', isAdmin, requirePerm('balance'), async (req, res) => {
        const { username, amount, action } = req.body;
        try {
            let user = await User.findOne({ username: new RegExp(`^${escapeRegex((username || '').trim())}$`, 'i') });
            if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza!' });
            let amt = parseFloat(amount);
            if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Nieprawidłowa kwota!' });
            if (action === 'add') {
                user.points += amt;
                await new Earning({ username: user.username, amount: amt, source: 'Admin', details: 'Dodano ręcznie' }).save();
            } else if (action === 'subtract') {
                user.points = Math.max(0, user.points - amt);
                await new Earning({ username: user.username, amount: -amt, source: 'Admin', details: 'Odebrano ręcznie' }).save();
            } else return res.status(400).json({ error: 'Nieznana akcja.' });
            await user.save();
            await logAdmin(actor(req), action === 'add' ? 'Dodano R$' : 'Odebrano R$', `${user.username}: ${amt} R$`);
            res.json({ success: true, newBalance: user.points });
        } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
    });

    app.post('/api/admin/resolve-payout', isAdmin, requirePerm('payouts'), async (req, res) => {
        const { payoutId, action } = req.body;
        if (action !== 'complete' && action !== 'reject') return res.status(400).json({ error: 'Nieznana akcja.' });
        try {
            // atomowo: wypłatę oczekującą może przetworzyć tylko jedno kliknięcie
            const payout = await Payout.findOneAndUpdate(
                { _id: payoutId, status: 'Pending Manual' },
                { $set: { status: action === 'complete' ? 'Completed' : 'Rejected' } },
                { new: true }
            );
            if (!payout) return res.status(400).json({ error: 'Ta wypłata została już przetworzona albo nie istnieje.' });
            if (action === 'reject') {
                const refunded = await User.findOneAndUpdate({ username: new RegExp(`^${escapeRegex(payout.username)}$`, 'i') }, { $inc: { points: payout.pointsWithdrawn } });
                if (!refunded) {
                    await Payout.updateOne({ _id: payout._id }, { $set: { status: 'Pending Manual' } }).catch(() => {});
                    return res.status(500).json({ error: 'Nie udało się zwrócić R$ graczowi, wypłata wróciła do oczekujących.' });
                }
            }
            await notify(payout.username, action === 'complete' ? 'payout_done' : 'payout_rejected', { points: payout.pointsWithdrawn, usd: payout.usdAmount });
            await logAdmin(actor(req), action === 'complete' ? 'Zatwierdzono wypłatę' : 'Odrzucono wypłatę', `${payout.username}: ${payout.pointsWithdrawn} R$ ($${payout.usdAmount})`);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Błąd' }); }
    });

    app.post('/api/admin/create-code', isAdmin, requirePerm('promo'), async (req, res) => {
        const { code, reward, maxUses } = req.body;
        if (!code || !reward || !maxUses) return res.status(400).json({ error: 'Uzupełnij wszystkie pola!' });
        try {
            await new PromoCode({ code: String(code).toUpperCase(), reward, maxUses, usedBy: [] }).save();
            await logAdmin(actor(req), 'Dodano kod promo', `${String(code).toUpperCase()}: ${reward} R$ × ${maxUses}`);
            const client = getDiscordClient();
            if (client && ADMIN_PROMO_CHANNEL_ID) {
                const channel = client.channels.cache.get(ADMIN_PROMO_CHANNEL_ID);
                if (channel) channel.send(`🎉 **Nowy Kod Promocyjny!** 🎉\n\n🎟️ Kod: \`${String(code).toUpperCase()}\`\n💰 Wartość: **${reward} R$**\n👥 Limit użyć: **${maxUses}**\n\nSzybko wbijajcie na stronę i odbierajcie!`);
            }
            res.json({ success: true });
        } catch (error) { res.status(500).json({ error: 'Błąd dodawania kodu. Kod już istnieje?' }); }
    });

    app.post('/api/admin/delete-code', isAdmin, requirePerm('promo'), async (req, res) => {
        try {
            const removed = await PromoCode.findByIdAndDelete(req.body.codeId);
            if (removed) await logAdmin(actor(req), 'Usunięto kod promo', removed.code);
            res.json({ success: true });
        }
        catch (e) { res.status(500).json({ error: 'Błąd usuwania kodu' }); }
    });

    app.post('/api/admin/set-verified', isAdmin, requirePerm('verify'), async (req, res) => {
        try {
            const user = await findUserCI(cleanName(req.body.username));
            if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza.' });
            const verified = req.body.verified === true;
            await User.updateOne({ _id: user._id }, { $set: { verified } });
            await logAdmin(actor(req), verified ? 'Zweryfikowano gracza' : 'Cofnięto weryfikację', user.username);
            res.json({ success: true, username: user.username, verified });
        } catch (e) { res.status(500).json({ error: 'Błąd serwera.' }); }
    });

    // =================== STATYSTYKI ROZSZERZONE (podgląd: każdy admin) ===================
    const DAY_MS = 24 * 60 * 60 * 1000;
    const NOT_COST = ['Admin', 'BundleDeposit', 'BundleRefund', 'BundleRejected', 'BundleDone'];
    const warsawDay = dt => new Date(dt).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
    // okres: today | yesterday | 7 | 30  ->  { from, to }
    function periodRange(p) {
        const today = getPolandMidnight();
        if (p === 'yesterday') return { from: new Date(today.getTime() - DAY_MS), to: today };
        if (p === '7') return { from: new Date(today.getTime() - 6 * DAY_MS), to: null };
        if (p === '30') return { from: new Date(today.getTime() - 29 * DAY_MS), to: null };
        return { from: today, to: null };
    }
    const rangeMatch = r => (r.to ? { $gte: r.from, $lt: r.to } : { $gte: r.from });

    // wykres: przychód / koszt / zysk dzień po dniu (7 albo 30 dni)
    app.get('/api/admin/history', isAdmin, async (req, res) => {
        try {
            const days = req.query.days === '30' ? 30 : 7;
            const from = new Date(getPolandMidnight().getTime() - (days - 1) * DAY_MS);
            const aggr = await Earning.aggregate([
                { $match: { createdAt: { $gte: from } } },
                { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Europe/Warsaw' } }, source: '$source' }, total: { $sum: '$amount' } } }
            ]);
            const map = {};
            for (const g of aggr) {
                const k = g._id.day; const m = map[k] || (map[k] = { revenueRobux: 0, costRobux: 0, ownerBonusRobux: 0 });
                if (g._id.source === 'Survey' || g._id.source === 'Reversal') m.revenueRobux += g.total;
                if (g._id.source === 'OwnerBonus' || g._id.source === 'OwnerBonusReversal') m.ownerBonusRobux += g.total;
                if (!NOT_COST.includes(g._id.source)) m.costRobux += g.total;
            }
            const out = [];
            const now = Date.now();
            for (let i = days - 1; i >= 0; i--) {
                const k = warsawDay(now - i * DAY_MS);
                if (out.length && out[out.length - 1].day === k) continue;
                const m = map[k] || { revenueRobux: 0, costRobux: 0, ownerBonusRobux: 0 };
                const revenueUsd = m.revenueRobux / 15, costUsd = m.costRobux * 0.025;
                out.push({ day: k, revenueUsd, costUsd, profitUsd: revenueUsd - costUsd, ownerBonusUsd: m.ownerBonusRobux * 0.025 });
            }
            res.json(out);
        } catch (e) { console.error('[admin] historia:', e.message); res.status(500).json({ error: 'Błąd statystyk' }); }
    });

    // przychód osobno dla każdego partnera (CPX / TheoremReach / TimeWall)
    app.get('/api/admin/partners', isAdmin, async (req, res) => {
        try {
            const r = periodRange(String(req.query.period || 'today'));
            const aggr = await Earning.aggregate([
                { $match: { createdAt: rangeMatch(r), source: { $in: ['Survey', 'Reversal'] } } },
                { $group: { _id: { source: '$source', prefix: { $arrayElemAt: [{ $split: [{ $ifNull: ['$txId', ''] }, ':'] }, 0] } }, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]);
            const NAMES = { cpx: 'CPX Research', 'cpx-rev': 'CPX Research', tr: 'TheoremReach', tw: 'TimeWall', 'tw-cb': 'TimeWall' };
            const out = {};
            for (const g of aggr) {
                const name = NAMES[g._id.prefix] || 'Inne';
                const p = out[name] || (out[name] = { partner: name, earnedRobux: 0, reversedRobux: 0, completes: 0, reversals: 0 });
                if (g._id.source === 'Survey') { p.earnedRobux += g.total; p.completes += g.count; }
                else { p.reversedRobux += -g.total; p.reversals += g.count; }
            }
            const list = ['CPX Research', 'TheoremReach', 'TimeWall', 'Inne'].map(n => out[n] || { partner: n, earnedRobux: 0, reversedRobux: 0, completes: 0, reversals: 0 })
                .filter(p => p.partner !== 'Inne' || p.completes || p.reversals)
                .map(p => ({ ...p, netRobux: p.earnedRobux - p.reversedRobux, revenueUsd: (p.earnedRobux - p.reversedRobux) / 15 }));
            res.json(list);
        } catch (e) { console.error('[admin] partnerzy:', e.message); res.status(500).json({ error: 'Błąd statystyk' }); }
    });

    // cofnięte ankiety: kto i ile (R$ i USD)
    app.get('/api/admin/reversals', isAdmin, async (req, res) => {
        try {
            const r = periodRange(String(req.query.period || 'today'));
            const aggr = await Earning.aggregate([
                { $match: { createdAt: rangeMatch(r), source: { $in: ['Reversal', 'OwnerBonusReversal'] } } },
                { $group: { _id: '$username', total: { $sum: '$amount' }, count: { $sum: { $cond: [{ $eq: ['$source', 'Reversal'] }, 1, 0] } }, partners: { $addToSet: '$details' }, last: { $max: '$createdAt' } } },
                { $sort: { total: 1 } }, { $limit: 200 }
            ]);
            const users = await User.find({ username: { $in: aggr.map(a => a._id) } }).select('username points payoutBlocked').lean();
            const byName = Object.fromEntries(users.map(u => [u.username, u]));
            res.json(aggr.map(a => {
                const robux = -a.total;
                const u = byName[a._id] || {};
                return { username: a._id, count: a.count, robux, usd: robux * 0.025, partners: a.partners.filter(Boolean), last: a.last, balance: u.points || 0, payoutBlocked: !!u.payoutBlocked };
            }));
        } catch (e) { console.error('[admin] cofnięcia:', e.message); res.status(500).json({ error: 'Błąd statystyk' }); }
    });

    // ten sam Revtag na kilku kontach
    app.get('/api/admin/revtag-dupes', isAdmin, async (req, res) => {
        try {
            const [fromUsers, fromPayouts] = await Promise.all([
                User.aggregate([{ $match: { linkedPayPal: { $type: 'string', $ne: '' } } }, { $group: { _id: { $toLower: '$linkedPayPal' }, users: { $addToSet: '$username' } } }]),
                Payout.aggregate([{ $match: { payoutAddress: { $type: 'string', $ne: '' } } }, { $group: { _id: { $toLower: '$payoutAddress' }, users: { $addToSet: '$username' } } }])
            ]);
            const map = {};
            for (const g of [...fromUsers, ...fromPayouts]) {
                const m = map[g._id] || (map[g._id] = {});
                for (const u of g.users) if (u) m[String(u).toLowerCase()] = u;
            }
            const groups = Object.entries(map).filter(([, m]) => Object.keys(m).length > 1);
            const names = groups.flatMap(([, m]) => Object.values(m));
            const users = await User.find({ username: { $in: names } }).select('username points payoutBlocked').lean();
            const byName = Object.fromEntries(users.map(u => [u.username.toLowerCase(), u]));
            res.json(groups.map(([revtag, m]) => ({
                revtag,
                users: Object.values(m).map(n => { const u = byName[n.toLowerCase()] || {}; return { username: u.username || n, points: u.points || 0, payoutBlocked: !!u.payoutBlocked }; })
            })).sort((a, b) => b.users.length - a.users.length));
        } catch (e) { console.error('[admin] revtagi:', e.message); res.status(500).json({ error: 'Błąd' }); }
    });

    // aktywne tickety (tylko podgląd: kto i opis)
    app.get('/api/admin/tickets', isAdmin, async (req, res) => {
        try {
            const list = await Ticket.find({ status: 'open' }).sort({ createdAt: -1 }).limit(100).select('number dayKey username discordName message createdAt').lean();
            res.json(list.map(t => ({ number: t.number, dayKey: t.dayKey || '', username: t.username, discordName: t.discordName || '', message: t.message || '', createdAt: t.createdAt })));
        } catch (e) { res.status(500).json([]); }
    });

    // dziennik akcji adminów (widzi każdy admin)
    app.get('/api/admin/logs', isAdmin, async (req, res) => {
        try { res.json(await AdminLog.find({}).sort({ createdAt: -1 }).limit(100).lean()); }
        catch (e) { res.status(500).json([]); }
    });

    // =================== UPRAWNIENIA ADMINÓW (tylko właściciel) ===================
    const ownerOnly = (req, res, next) => (req.admin && req.admin.role === 'owner') ? next() : res.status(403).json({ error: 'Tylko właściciel.' });

    app.get('/api/admin/perms', isAdmin, ownerOnly, (req, res) => {
        res.json({
            all: ALL_PERMISSIONS, labels: PERMISSION_LABELS,
            admins: Object.entries(ADMINS).map(([id, a]) => ({ discordId: id, name: a.name, permissions: permsFor({ role: 'admin', discordId: id }) })),
            roleDefault: permsFor({ role: 'admin', discordId: '' })
        });
    });

    app.post('/api/admin/perms', isAdmin, ownerOnly, async (req, res) => {
        try {
            const target = String(req.body.discordId || '');
            if (target !== 'role' && !ADMINS[target]) return res.status(400).json({ error: 'Nieznany admin.' });
            const perms = (Array.isArray(req.body.permissions) ? req.body.permissions : []).map(String).filter(p => ALL_PERMISSIONS.includes(p));
            const next = { ...permOverrides, [target]: [...new Set(perms)] };
            await AdminSetting.updateOne({ key: 'perms' }, { $set: { value: next } }, { upsert: true });
            permOverrides = next;
            const who = target === 'role' ? 'Pozostali z rolą' : ADMINS[target].name;
            await logAdmin(actor(req), 'Zmieniono uprawnienia', `${who}: ${perms.length ? perms.map(p => PERMISSION_LABELS[p] || p).join(', ') : 'brak'}`);
            res.json({ success: true });
        } catch (e) { console.error('[admin] uprawnienia:', e.message); res.status(500).json({ error: 'Błąd zapisu.' }); }
    });

    // =================== BLOKADA WYPŁAT ===================
    app.post('/api/admin/set-payout-block', isAdmin, requirePerm('block'), async (req, res) => {
        try {
            const user = await findUserCI(cleanName(req.body.username));
            if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza.' });
            const blocked = req.body.blocked === true;
            await User.updateOne({ _id: user._id }, { $set: { payoutBlocked: blocked } });
            await logAdmin(actor(req), blocked ? 'Zablokowano wypłaty' : 'Odblokowano wypłaty', user.username);
            res.json({ success: true, username: user.username, payoutBlocked: blocked });
        } catch (e) { res.status(500).json({ error: 'Błąd serwera.' }); }
    });
};

