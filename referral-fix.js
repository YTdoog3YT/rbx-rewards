// =================== JEDNORAZOWE WYRÓWNANIE BONUSÓW Z POLECEŃ ===================
// Przez błąd zapisu część bonusów 15% nie trafiła do polecających. Tu liczymy, ile każdy powinien był dostać
// (15% od ankiet/offerwalli każdej poleconej osoby, minus cofnięte) i ile faktycznie dostał. Różnicę można
// dopisać jednym kliknięciem w panelu admina (tylko właściciel). Ponowne kliknięcie nic nie dubluje.
const mongoose = require('mongoose');

// ile z wyrównania przypada na konkretną poleconą osobę (do listy "Players you invited")
const ReferralFixPartSchema = new mongoose.Schema({ referrer: String, referred: String, amount: Number, createdAt: { type: Date, default: Date.now } });
ReferralFixPartSchema.index({ referrer: 1 });
const ReferralFixPart = mongoose.models.ReferralFixPart || mongoose.model('ReferralFixPart', ReferralFixPartSchema);

const MIN_MISSING = 0.05; // drobne różnice z zaokrągleń pomijamy
const r2 = n => Math.round(n * 100) / 100;

async function computeMissing({ User, Earning }) {
    const referred = await User.find({ referredBy: { $type: 'string', $ne: '' } }).select('username referredBy').lean();
    if (!referred.length) return [];

    // polecający (bez względu na wielkość liter)
    const refNames = [...new Set(referred.map(u => String(u.referredBy).toLowerCase()))];
    const refUsers = await User.find({ $expr: { $in: [{ $toLower: '$username' }, refNames] } }).select('username').lean();
    const refByLower = new Map(refUsers.map(u => [u.username.toLowerCase(), u.username]));

    // należne: 15% od każdej ankiety (zaokrąglone jak przy normalnym dopisywaniu), cofnięte odejmują
    const lowerNames = referred.map(u => u.username.toLowerCase());
    const due = await Earning.aggregate([
        { $match: { source: { $in: ['Survey', 'Reversal'] }, $expr: { $in: [{ $toLower: '$username' }, lowerNames] } } },
        { $group: { _id: { $toLower: '$username' }, total: { $sum: { $round: [{ $multiply: ['$amount', 0.15] }, 2] } } } }
    ]);
    const dueBy = new Map(due.map(x => [x._id, x.total]));

    // faktycznie dostane: bonusy z poleceń (minus cofnięte) + wcześniejsze wyrównania
    const got = await Earning.aggregate([
        { $match: { source: { $in: ['Referral', 'ReferralReversal'] } } },
        { $group: { _id: { r: { $toLower: '$username' }, d: { $toLower: '$details' } }, total: { $sum: '$amount' } } }
    ]);
    const gotBy = new Map(got.map(x => [x._id.r + '|' + x._id.d, x.total]));
    const parts = await ReferralFixPart.aggregate([{ $group: { _id: { r: { $toLower: '$referrer' }, d: { $toLower: '$referred' } }, total: { $sum: '$amount' } } }]);
    for (const p of parts) { const k = p._id.r + '|' + p._id.d; gotBy.set(k, (gotBy.get(k) || 0) + p.total); }

    const byReferrer = new Map();
    for (const u of referred) {
        const refName = refByLower.get(String(u.referredBy).toLowerCase());
        if (!refName) continue;
        const k = refName.toLowerCase() + '|' + u.username.toLowerCase();
        const missing = r2((dueBy.get(u.username.toLowerCase()) || 0) - (gotBy.get(k) || 0));
        if (missing < MIN_MISSING) continue;
        const e = byReferrer.get(refName) || { referrer: refName, total: 0, people: [] };
        e.people.push({ username: u.username, missing });
        e.total = r2(e.total + missing);
        byReferrer.set(refName, e);
    }
    return [...byReferrer.values()].sort((a, b) => b.total - a.total);
}

let applying = false;
async function applyMissing({ User, Earning }) {
    if (applying) throw new Error('Wyrównanie już trwa.');
    applying = true;
    try {
        const list = await computeMissing({ User, Earning });
        const done = [];
        for (const e of list) {
            try {
                await ReferralFixPart.insertMany(e.people.map(p => ({ referrer: e.referrer, referred: p.username, amount: p.missing })));
                await User.updateOne({ username: e.referrer }, { $inc: { points: e.total } });
                await new Earning({ username: e.referrer, amount: e.total, source: 'ReferralFix', details: 'Przepraszamy za błąd' }).save();
                done.push(e);
            } catch (err) { console.error(`[polecenia] wyrównanie dla ${e.referrer} (${e.total} R$) nie wyszło:`, err.message); }
        }
        return done;
    } finally { applying = false; }
}

// suma wyrównań per polecona osoba dla danego polecającego (do listy poleconych)
async function fixPartsFor(referrer) {
    const rows = await ReferralFixPart.aggregate([
        { $match: { referrer } },
        { $group: { _id: { $toLower: '$referred' }, total: { $sum: '$amount' } } }
    ]);
    return new Map(rows.map(x => [x._id, x.total]));
}

module.exports = { computeMissing, applyMissing, fixPartsFor };
