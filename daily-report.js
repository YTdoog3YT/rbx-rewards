// =================== DZIENNY RAPORT NA DISCORDA ===================
// Po północy (czasu polskiego) bot wysyła podsumowanie poprzedniego dnia na kanał raportów.
// Data ostatniego raportu jest w bazie, więc restart serwera nie wyśle go drugi raz.
// Gdy serwer śpi o północy (Render), raport pójdzie zaraz po jego obudzeniu.
const mongoose = require('mongoose');

const CHANNEL_ID = '1574874377068093481';
const NOT_COST = ['Admin', 'BundleDeposit', 'BundleRefund', 'BundleRejected', 'BundleDone'];

const ReportStateSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: String });
const ReportState = mongoose.models.ReportState || mongoose.model('ReportState', ReportStateSchema);

const ymdWarsaw = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }); // 2026-11-23
const plDate = ymd => ymd.split('-').reverse().join('.'); // 23.11.2026
function warsawStart(ymd) { // początek dnia (00:00 w Polsce) jako chwila UTC
    const [y, m, d] = ymd.split('-').map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d));
    const off = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' })) - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
    return new Date(guess.getTime() - off);
}
const usd = n => '$' + (Math.round((n || 0) * 100) / 100).toFixed(2);
const rs = n => (Math.round((n || 0) * 100) / 100).toFixed(2) + ' R$';

async function buildReport(models, ymd) {
    const { Earning, Payout, Bundle } = models;
    const from = warsawStart(ymd);
    const next = new Date(from.getTime() + 36 * 3600 * 1000); // na pewno następny dzień, potem jego 00:00
    const to = warsawStart(ymdWarsaw(next));
    const range = { $gte: from, $lt: to };

    const bySource = await Earning.aggregate([{ $match: { createdAt: range } }, { $group: { _id: '$source', total: { $sum: '$amount' } } }]);
    const src = n => { const g = bySource.find(x => x._id === n); return g ? g.total : 0; };
    const revenueUsd = (src('Survey') + src('Reversal')) / 15;
    const costUsd = bySource.filter(g => !NOT_COST.includes(g._id)).reduce((s, g) => s + g.total, 0) * 0.025;
    const wheelRs = src('Wheel') + src('Spinner');
    const refRs = src('Referral') + src('ReferralReversal') + src('ReferralFix');

    const partnersAggr = await Earning.aggregate([
        { $match: { createdAt: range, source: { $in: ['Survey', 'Reversal'] } } },
        { $group: { _id: { source: '$source', prefix: { $arrayElemAt: [{ $split: [{ $ifNull: ['$txId', ''] }, ':'] }, 0] } }, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const NAMES = { cpx: 'CPX Research', 'cpx-rev': 'CPX Research', tr: 'TheoremReach', tw: 'TimeWall', 'tw-cb': 'TimeWall' };
    const partners = {};
    for (const g of partnersAggr) {
        const name = NAMES[g._id.prefix]; if (!name) continue;
        const p = partners[name] || (partners[name] = { surveys: 0, robux: 0 });
        if (g._id.source === 'Survey') p.surveys += g.count;
        p.robux += g.total;
    }

    const payoutGroup = async match => { const a = await Payout.aggregate([{ $match: match }, { $group: { _id: null, n: { $sum: 1 }, usd: { $sum: '$usdAmount' } } }]); return a[0] || { n: 0, usd: 0 }; };
    const pDone = await payoutGroup({ status: 'Completed', resolvedAt: range });
    const pRej = await payoutGroup({ status: 'Rejected', resolvedAt: range });
    const pPend = await payoutGroup({ status: 'Pending Manual' });

    const bundleGroup = async match => { if (!Bundle) return { n: 0, usd: 0 }; const a = await Bundle.aggregate([{ $match: match }, { $group: { _id: null, n: { $sum: 1 }, c: { $sum: '$priceC' } } }]); return a[0] ? { n: a[0].n, usd: a[0].c / 100 * 0.025 } : { n: 0, usd: 0 }; };
    const bDone = await bundleGroup({ status: 'done', doneAt: range });
    const bRej = await bundleGroup({ status: 'rejected', doneAt: range });
    const bPend = await bundleGroup({ status: 'paid' });

    const partnerLines = ['CPX Research', 'TimeWall', 'TheoremReach']
        .filter(n => n !== 'TheoremReach' || partners[n])
        .map(n => { const p = partners[n] || { surveys: 0, robux: 0 }; return `• ${n}: **${p.surveys}** ankiet • **${usd(p.robux / 15)}**`; });

    return [
        `📊 **Raport dzienny – ${plDate(ymd)}**`,
        '',
        `💰 Przychód strony: **${usd(revenueUsd)}**`,
        `💸 Koszt (do wypłaty graczom): **${usd(costUsd)}**`,
        `👑 Czysty zysk: **${usd(revenueUsd - costUsd)}**`,
        '',
        `🎡 Gracze zarobili z koła: **${rs(wheelRs)}** (${usd(wheelRs * 0.025)})`,
        `👥 Gracze zarobili z poleceń: **${rs(refRs)}** (${usd(refRs * 0.025)})`,
        '',
        '🤝 **Partnerzy**',
        ...partnerLines,
        '',
        '💳 **Wypłaty**',
        `• Zrealizowane: **${pDone.n}** • ${usd(pDone.usd)}`,
        `• Odrzucone: **${pRej.n}** • ${usd(pRej.usd)}`,
        `• Oczekujące (teraz): **${pPend.n}** • ${usd(pPend.usd)}`,
        '',
        '📦 **Pakiety**',
        `• Zrealizowane: **${bDone.n}** • ${usd(bDone.usd)}`,
        `• Odrzucone: **${bRej.n}** • ${usd(bRej.usd)}`,
        `• Oczekujące (teraz): **${bPend.n}** • ${usd(bPend.usd)}`
    ].join('\n');
}

let busy = false;
async function tick(client, models) {
    if (busy || !client || !client.isReady || !client.isReady()) return;
    busy = true;
    try {
        const today = ymdWarsaw(Date.now());
        const reportDay = ymdWarsaw(warsawStart(today).getTime() - 12 * 3600 * 1000); // dzień przed dzisiejszym (w Polsce)
        const state = await ReportState.findOne({ key: 'lastDailyReport' }).lean();
        if (state && state.value >= reportDay) return;
        const text = await buildReport(models, reportDay);
        const ch = client.channels.cache.get(CHANNEL_ID) || await client.channels.fetch(CHANNEL_ID).catch(() => null);
        if (!ch) { console.error('[raport] nie mam dostępu do kanału raportów ' + CHANNEL_ID); return; }
        await ch.send({ content: text, allowedMentions: { parse: [] } });
        await ReportState.updateOne({ key: 'lastDailyReport' }, { $set: { value: reportDay } }, { upsert: true });
    } catch (e) { console.error('[raport] dzienny raport nie wyszedł:', e.message); }
    finally { busy = false; }
}

// wywołać, gdy bot Discord jest gotowy; sprawdza co minutę, czy już po północy i raport jeszcze nie poszedł
function startDailyReport(client, models) {
    setTimeout(() => tick(client, models), 15 * 1000);
    setInterval(() => tick(client, models), 60 * 1000).unref();
}

module.exports = { startDailyReport, buildReport };
