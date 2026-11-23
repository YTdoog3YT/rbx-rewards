// =================== BONUS OD WŁAŚCICIELA (wybrani gracze zarabiają więcej) ===================
// Za ankiety i offerwalle (CPX, TheoremReach, TimeWall) gracz dostaje normalnie 15 R$ za 1 $,
// czyli 37,5% tego, co zarabia strona (15 R$ × 0,025 $). Gracze z listy poniżej dostają większą część.
// Dopłata pokazuje się im w historii osobno jako "Bonus od właściciela" (bez procentów).
// Bonus z polecenia (15%) liczy się od zwykłej kwoty, bez tej dopłaty.

const BASE_SHARE = 0.375; // 37,5% - tyle dostaje zwykły gracz

// nick ze strony (wielkość liter bez znaczenia) : jaka część zarobku strony trafia do gracza
const OWNER_BONUS_USERS = {
    'unikt_game': 0.60,
    'rusekmaczity1': 0.60,
};

// Ile R$ dopłaty należy się graczowi do kwoty "amount" (0, jeśli nie ma bonusu)
function ownerBonusFor(username, amount) {
    const share = OWNER_BONUS_USERS[String(username || '').toLowerCase()];
    if (!share || !(share > BASE_SHARE) || !(amount > 0)) return 0;
    return Math.round(amount * (share / BASE_SHARE - 1) * 100) / 100;
}

// Cofnięcie dopłaty, gdy partner cofnie ankietę (originalTxId = txId tamtej ankiety, np. 'cpx:123')
async function reverseOwnerBonus(Earning, User, user, originalTxId) {
    if (!originalTxId) return;
    try {
        const bonus = await Earning.findOne({ source: 'OwnerBonus', txId: 'ob:' + originalTxId });
        if (!bonus || !(bonus.amount > 0)) return;
        try { await new Earning({ username: user.username, amount: -bonus.amount, source: 'OwnerBonusReversal', details: '', txId: 'ob-rev:' + originalTxId }).save(); }
        catch (e) { if (e && e.code === 11000) return; throw e; }
        await User.updateOne({ _id: user._id }, { $inc: { points: -bonus.amount } });
    } catch (e) { console.error('[owner-bonus] cofanie:', e.message); }
}

// jaka część zarobku strony trafia do tego gracza (0.375 dla zwykłych)
function shareFor(username) {
    const s = OWNER_BONUS_USERS[String(username || '').toLowerCase()];
    return s && s > BASE_SHARE ? s : BASE_SHARE;
}

module.exports = { ownerBonusFor, reverseOwnerBonus, shareFor, OWNER_BONUS_USERS, BASE_SHARE };
