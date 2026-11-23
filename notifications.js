// =================== POWIADOMIENIA NA STRONIE (dzwonek) ===================
// Typy: ticket_reply, announcement, payout_done, payout_rejected, bundle_done, bundle_rejected
// Tekst powiadomienia składa się w przeglądarce, w języku wybranym na stronie (public/notifications.js).
const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
    userKey: String,                        // nick małymi literami, albo '*' = dla wszystkich (ogłoszenia)
    type: String,
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
});
NotificationSchema.index({ userKey: 1, createdAt: -1 });
const Notification = mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);

const keyOf = username => String(username || '').trim().toLowerCase();

async function notify(username, type, data = {}) {
    const userKey = keyOf(username);
    if (!userKey) return null;
    try { return await new Notification({ userKey, type, data }).save(); }
    catch (e) { console.error('[powiadomienia] zapis:', e.message); return null; }
}

async function notifyAll(type, data = {}) {
    try { return await new Notification({ userKey: '*', type, data }).save(); }
    catch (e) { console.error('[powiadomienia] zapis (wszyscy):', e.message); return null; }
}

// czy gracz ma jeszcze nieprzeczytane powiadomienie o tym tickecie (żeby nie spamować przy każdej wiadomości)
async function hasUnreadTicketNotice(User, username, ticketId) {
    const user = await User.findOne({ username: new RegExp(`^${String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('notifSeenAt').lean();
    const seen = user && user.notifSeenAt ? new Date(user.notifSeenAt) : new Date(0);
    return !!(await Notification.exists({ userKey: keyOf(username), type: 'ticket_reply', 'data.ticketId': String(ticketId), createdAt: { $gt: seen } }));
}

function registerNotificationRoutes(app, { User, findUserCI }) {
    // lista (ostatnie 30) + liczba nieprzeczytanych; adres chroniony sesją (server.js podmienia nick na zalogowanego)
    app.get('/api/notifications/:username', async (req, res) => {
        try {
            const user = await findUserCI(String(req.params.username || ''));
            if (!user) return res.json({ items: [], unread: 0 });
            let seen = user.notifSeenAt;
            if (!seen) { // pierwszy raz: stare ogłoszenia nie liczą się jako nowe
                seen = new Date();
                await User.updateOne({ _id: user._id }, { $set: { notifSeenAt: seen } });
            }
            const keys = [keyOf(user.username), '*'];
            const [items, unread] = await Promise.all([
                Notification.find({ userKey: { $in: keys } }).sort({ createdAt: -1 }).limit(30).lean(),
                Notification.countDocuments({ userKey: { $in: keys }, createdAt: { $gt: seen } })
            ]);
            res.json({
                unread,
                seenAt: seen,
                items: items.map(n => ({ id: String(n._id), type: n.type, data: n.data || {}, createdAt: n.createdAt }))
            });
        } catch (e) { console.error('[powiadomienia] lista:', e.message); res.status(500).json({ items: [], unread: 0 }); }
    });

    // oznacz wszystko jako przeczytane (po otwarciu dzwonka)
    app.post('/api/notifications/seen', async (req, res) => {
        try {
            const user = await findUserCI(String(req.body.username || ''));
            if (!user) return res.json({ success: false });
            await User.updateOne({ _id: user._id }, { $set: { notifSeenAt: new Date() } });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ success: false }); }
    });
}

module.exports = { Notification, notify, notifyAll, hasUnreadTicketNotice, registerNotificationRoutes };
