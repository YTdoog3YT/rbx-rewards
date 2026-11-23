// =================== PANEL ADMINA (osobna strona /admin) ===================
// Logowanie przez Discord, uprawnienia (właściciel / administracja) i wszystkie adresy /api/admin/...
const path = require('path');
const crypto = require('crypto');

const OWNER_DISCORD_ID = '398911896893521921';      // właściciel: może wszystko
const ADMIN_ROLE_ID = '1548633150870261791';        // rola administracji na serwerze Discord
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;     // zalogowanie trwa 12 godzin

// Co mogą KLIKAĆ admini (rola administracji). Widzą wszystko, ale akcje tylko z tej listy.
// Do wyboru: 'payouts' (wypłaty), 'balance' (saldo graczy), 'promo' (kody promocyjne), 'verify' (weryfikacja graczy)
const ADMIN_PERMISSIONS = [];
const ALL_PERMISSIONS = ['payouts', 'balance', 'promo', 'verify'];

module.exports = function registerAdminRoutes(app, d) {
    const { User, Earning, Payout, PromoCode, getDiscordClient, discordBot, escapeRegex, getPolandMidnight, findUserCI, cleanName,
        onlineUsersMap, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, REDIRECT_URI, ADMIN_PROMO_CHANNEL_ID, discordLinkCallback } = d;

    const tokens = new Map(); // token -> { expires, role, discordId, name }
    setInterval(() => { const now = Date.now(); for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k); }, 30 * 60 * 1000).unref();

    function getAuth(token) {
        const a = token ? tokens.get(String(token)) : null;
        if (!a) return null;
        if (a.expires < Date.now()) { tokens.delete(String(token)); return null; }
        return a;
    }
    const permsFor = a => (a.role === 'owner' ? ALL_PERMISSIONS : ADMIN_PERMISSIONS);

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
        res.json({ success: true, role: a.role, name: a.name, permissions: permsFor(a) });
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
            const pendingPayoutsAggr = await Payout.aggregate([
                { $match: { status: 'Pending Manual' } },
                { $group: { _id: null, total: { $sum: "$pointsWithdrawn" } } }
            ]);
            const pendingRobux = pendingPayoutsAggr.length > 0 ? pendingPayoutsAggr[0].total : 0;
            const uniqueOnline = new Set(onlineUsersMap.values()).size;
            res.json({ online: uniqueOnline, dailyRobux: dailyRobux, pendingRobux: pendingRobux });
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
            res.json({ username: user.username, points: user.points, pendingSum: pendingSum, pendingRequests: pending });
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
        try { await PromoCode.findByIdAndDelete(req.body.codeId); res.json({ success: true }); }
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
};
