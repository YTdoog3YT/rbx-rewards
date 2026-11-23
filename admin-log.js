// =================== DZIENNIK AKCJI ADMINÓW ===================
// Zapisuje, kto (Discord) i co kliknął: w panelu /admin i przyciskami na Discordzie.
const mongoose = require('mongoose');

const AdminLogSchema = new mongoose.Schema({
    discordId: String, name: String, where: { type: String, default: 'panel' }, // panel | discord
    action: String, details: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});
AdminLogSchema.index({ createdAt: -1 });
const AdminLog = mongoose.models.AdminLog || mongoose.model('AdminLog', AdminLogSchema);

async function logAdmin({ discordId, name, where = 'panel' }, action, details = '') {
    try { await new AdminLog({ discordId: String(discordId || ''), name: String(name || ''), where, action, details: String(details).slice(0, 500) }).save(); }
    catch (e) { console.error('[dziennik] zapis:', e.message); }
}

module.exports = { AdminLog, logAdmin };
