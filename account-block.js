// =================== BLOKADA CAŁEGO KONTA ===================
// Zablokowany gracz widzi na stronie tylko ekran blokady: czas blokady, saldo R$ i przycisk "Utwórz ticket".
// R$ z ankiet dalej mu wpadają (postbacki działają normalnie).

// czy blokada jest teraz aktywna (blockedUntil = null -> na zawsze)
function isAccountBlocked(u) {
    if (!u || !u.accountBlocked) return false;
    return !u.blockedUntil || new Date(u.blockedUntil).getTime() > Date.now();
}

// koniec blokady: value + unit (seconds | minutes | hours | days | months | years); null = na zawsze
function blockUntilFrom(value, unit) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 100000) return undefined;
    const d = new Date();
    switch (unit) {
        case 'seconds': d.setSeconds(d.getSeconds() + n); break;
        case 'minutes': d.setMinutes(d.getMinutes() + n); break;
        case 'hours': d.setHours(d.getHours() + n); break;
        case 'days': d.setDate(d.getDate() + n); break;
        case 'months': d.setMonth(d.getMonth() + n); break;
        case 'years': d.setFullYear(d.getFullYear() + n); break;
        default: return undefined;
    }
    return d;
}

// adresy, z których zablokowany gracz może korzystać (reszta dostaje 403 BLOCKED)
const BLOCKED_ALLOWED_GET = new Set(['points', 'support-status', 'block-status']);
const BLOCKED_ALLOWED_POST = new Set(['/api/support-ticket', '/api/discord/link-start']);

function registerBlockRoutes(app, { User, Ticket, findUserCI, discordGuildId }) {
    // stan blokady dla ekranu blokady (adres chroniony sesją)
    app.get('/api/block-status/:username', async (req, res) => {
        try {
            const user = await findUserCI(String(req.params.username || ''));
            if (!user) return res.json({ blocked: false });
            const blocked = isAccountBlocked(user);
            if (!blocked) return res.json({ blocked: false });
            const t = await Ticket.findOne({ username: user.username, status: 'open', channelId: { $ne: null } }).sort({ createdAt: -1 }).lean();
            res.json({
                blocked: true,
                until: user.blockedUntil || null,
                points: user.points || 0,
                linked: !!user.discordLinkedId,
                discordName: user.discordLinkedName || '',
                openTicket: t ? { name: t.channelName, url: `https://discord.com/channels/${discordGuildId()}/${t.channelId}` } : null
            });
        } catch (e) { console.error('[blokada] status:', e.message); res.status(500).json({ blocked: false }); }
    });
}

module.exports = { isAccountBlocked, blockUntilFrom, registerBlockRoutes, BLOCKED_ALLOWED_GET, BLOCKED_ALLOWED_POST };
