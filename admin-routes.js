// =================== PANEL ADMINA (osobna strona /admin) ===================
// Logowanie przez Discord, uprawnienia (właściciel / administracja) i wszystkie adresy /api/admin/...
const path = require('path');
const crypto = require('crypto');
const { notify, Notification } = require('./notifications');
const { isAccountBlocked, blockUntilFrom } = require('./account-block');
const { shareFor, BASE_SHARE } = require('./owner-bonus');


const OWNER_DISCORD_ID = '398911896893521921';      // właściciel: może wszystko
const ADMIN_ROLE_ID = '1548633150870261791';        // rola administracji na serwerze Discord
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;     // zalogowanie trwa 12 godzin

// Uprawnienia do wyboru: 'payouts' (wypłaty), 'balance' (saldo graczy), 'promo' (kody promocyjne), 'verify' (weryfikacja graczy),
// 'block' (blokada wypłat gracza). Każdy admin WIDZI wszystko; KLIKAĆ może tylko to, co ma na swojej liście.
// Uprawnienia zmieniasz tylko tutaj, w kodzie (np. permissions: ['payouts', 'block']).

// Konkretni admini po ID Discorda (każdy ze swoimi uprawnieniami). Wchodzą do panelu nawet bez roli na serwerze.
const ADMINS = {
    '1211371515048894486': { name: 'Aleks', permissions: [] },
    '710548443252391936': { name: 'Kruger', permissions: [] },
};

// Pozostali z rolą administracji na serwerze (nie wpisani wyżej) dostają to:
const ADMIN_PERMISSIONS = [];
const ALL_PERMISSIONS = ['payouts', 'balance', 'promo', 'verify', 'block'];

module.exports = function registerAdminRoutes(app, d) {
    const { User, Earning, Payout, PromoCode, Bundle, Ticket, Session, getDiscordClient, discordBot, escapeRegex, getPolandMidnight, findUserCI, cleanName,
        onlineUsersMap, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, REDIRECT_URI, ADMIN_PROMO_CHANNEL_ID, discordLinkCallback } = d;

    const tokens = new Map(); // token -> { expires, role, discordId, name }
    setInterval(() => { const now = Date.now(); for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k); }, 30 * 60 * 1000).unref();

    function getAuth(token) {
        const a = token ? tokens.get(String(token)) : null;
        if (!a) return null;
        if (a.expires < Date.now()) { tokens.delete(String(token)); return null; }
        return a;
    }
    const permsFor = a => {
        if (a.role === 'owner') return ALL_PERMISSIONS;
        const entry = ADMINS[a.discordId];
        return (entry ? entry.permissions : ADMIN_PERMISSIONS).filter(p => ALL_PERMISSIONS.includes(p));
    };

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
            res.json({ username: user.username, points: user.points, pendingSum: pendingSum, pendingRequests: pending, payoutBlocked: !!user.payoutBlocked, revtag: user.linkedPayPal || '', value,
                accountBlocked: isAccountBlocked(user), blockedUntil: isAccountBlocked(user) ? (user.blockedUntil || null) : null });
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
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Błąd' }); }
    });

    app.post('/api/admin/create-code', isAdmin, requirePerm('promo'), async (req, res) => {
        const { code, reward, maxUses } = req.body;
        if (!code || !reward || !maxUses) return res.status(400).json({ error: 'Uzupełnij wszystkie pola!' });
        try {
            await new PromoCode({ code: String(code).toUpperCase(), reward, maxUses, usedBy: [] }).save();
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
            await PromoCode.findByIdAndDelete(req.body.codeId);
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
            const OLD = 'Starsze (sprzed 30.10, bez nazwy partnera)'; // wpisy zapisane, zanim strona zaczęła zapisywać ID transakcji
            const out = {};
            for (const g of aggr) {
                const name = NAMES[g._id.prefix] || OLD;
                const p = out[name] || (out[name] = { partner: name, earnedRobux: 0, reversedRobux: 0, completes: 0, reversals: 0 });
                if (g._id.source === 'Survey') { p.earnedRobux += g.total; p.completes += g.count; }
                else { p.reversedRobux += -g.total; p.reversals += g.count; }
            }
            const list = ['CPX Research', 'TheoremReach', 'TimeWall', OLD].map(n => out[n] || { partner: n, earnedRobux: 0, reversedRobux: 0, completes: 0, reversals: 0 })
                .filter(p => p.partner !== OLD || p.completes || p.reversals)
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


    // =================== BLOKADA CAŁEGO KONTA ===================
    // body: { username, blocked: true, forever: true } albo { username, blocked: true, value: 3, unit: 'days' } albo { username, blocked: false }
    app.post('/api/admin/set-account-block', isAdmin, requirePerm('block'), async (req, res) => {
        try {
            const user = await findUserCI(cleanName(req.body.username));
            if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza.' });
            if (req.body.blocked !== true) {
                await User.updateOne({ _id: user._id }, { $set: { accountBlocked: false, blockedUntil: null } });
                return res.json({ success: true, accountBlocked: false });
            }
            let until = null;
            if (req.body.forever !== true) {
                until = blockUntilFrom(req.body.value, String(req.body.unit || ''));
                if (!until) return res.status(400).json({ error: 'Podaj poprawny czas blokady (liczba od 1).' });
            }
            await User.updateOne({ _id: user._id }, { $set: { accountBlocked: true, blockedUntil: until } });
            res.json({ success: true, accountBlocked: true, blockedUntil: until });
        } catch (e) { res.status(500).json({ error: 'Błąd serwera.' }); }
    });

    // =================== USUNIĘCIE KONTA CAŁKOWICIE (tylko właściciel) ===================
    // kasuje gracza i wszystko o nim: historię, wypłaty, pakiety, tickety, powiadomienia, sesje (znika też z rankingów)
    app.post('/api/admin/delete-account', isAdmin, async (req, res) => {
        if (req.admin.role !== 'owner') return res.status(403).json({ error: 'Tylko właściciel.' });
        try {
            const user = await findUserCI(cleanName(req.body.username));
            if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza.' });
            if (String(req.body.confirm || '') !== user.username) return res.status(400).json({ error: 'Potwierdzenie się nie zgadza (wpisz dokładnie nick).' });
            const name = user.username;
            const exact = new RegExp(`^${escapeRegex(name)}$`, 'i');
            const [e, p, b, t, n, s] = await Promise.all([
                Earning.deleteMany({ username: exact }),
                Payout.deleteMany({ username: exact }),
                Bundle ? Bundle.deleteMany({ username: exact }) : { deletedCount: 0 },
                Ticket ? Ticket.deleteMany({ username: exact }) : { deletedCount: 0 },
                Notification.deleteMany({ userKey: name.toLowerCase() }),
                Session ? Session.deleteMany({ username: exact }) : { deletedCount: 0 }
            ]);
            // polecenia: usuń z list innych graczy, a jego poleceni nie mają już polecającego
            await User.updateMany({ referredUsers: name }, { $pull: { referredUsers: name } });
            await User.updateMany({ referredBy: name }, { $set: { referredBy: null } });
            await User.deleteOne({ _id: user._id });
            for (const [k, v] of onlineUsersMap) if (String(v).toLowerCase() === name.toLowerCase()) onlineUsersMap.delete(k);
            console.log(`[admin] usunięto konto ${name} (historia ${e.deletedCount}, wypłaty ${p.deletedCount}, pakiety ${b.deletedCount}, tickety ${t.deletedCount}, powiadomienia ${n.deletedCount}, sesje ${s.deletedCount})`);
            res.json({ success: true, username: name, deleted: { earnings: e.deletedCount, payouts: p.deletedCount, bundles: b.deletedCount, tickets: t.deletedCount } });
        } catch (err) { console.error('[admin] usuwanie konta:', err.message); res.status(500).json({ error: 'Błąd serwera.' }); }
    });

    // =================== BLOKADA WYPŁAT ===================
    app.post('/api/admin/set-payout-block', isAdmin, requirePerm('block'), async (req, res) => {
        try {
            const user = await findUserCI(cleanName(req.body.username));
            if (!user) return res.status(404).json({ error: 'Nie znaleziono gracza.' });
            const blocked = req.body.blocked === true;
            await User.updateOne({ _id: user._id }, { $set: { payoutBlocked: blocked } });
            res.json({ success: true, username: user.username, payoutBlocked: blocked });
        } catch (e) { res.status(500).json({ error: 'Błąd serwera.' }); }
    });
};

