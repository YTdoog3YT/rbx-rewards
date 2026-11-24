// =================== HISTORIA CZATU ===================
// Każda wiadomość z czatu jest zapisywana w bazie; po wejściu na stronę gracz dostaje ostatnie 50.
// Wiadomości starsze niż 30 dni MongoDB usuwa sam.
const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({ username: String, text: String, role: { type: String, default: null }, createdAt: { type: Date, default: Date.now } });
ChatMessageSchema.index({ createdAt: -1 });
ChatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
const ChatMessage = mongoose.models.ChatMessage || mongoose.model('ChatMessage', ChatMessageSchema);

const HISTORY_SIZE = 50;

async function saveChatMessage(msg) {
    try { await new ChatMessage(msg).save(); }
    catch (e) { console.error('[czat] zapis wiadomości:', e.message); }
}

async function lastChatMessages() {
    const rows = await ChatMessage.find({}).sort({ createdAt: -1 }).limit(HISTORY_SIZE).lean();
    return rows.reverse().map(m => ({ username: m.username, text: m.text, role: m.role || null, createdAt: m.createdAt }));
}

module.exports = { saveChatMessage, lastChatMessages };
