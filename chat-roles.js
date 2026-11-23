// =================== ODZNAKI NA CZACIE ===================
// nick ze strony (wielkość liter bez znaczenia) : odznaka. Pozostali gracze mają sam nick.
// Odznakę nadaje serwer, więc nikt nie podszyje się pod CEO/ADMIN wpisując cudzy nick.
const CHAT_ROLES = {
    'xdoog3': 'ceo',
    'unikt_game': 'admin',
    'krugeroos': 'admin',
};

const chatRoleFor = username => CHAT_ROLES[String(username || '').toLowerCase()] || null;

module.exports = { chatRoleFor, CHAT_ROLES };
