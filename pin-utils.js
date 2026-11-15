const crypto = require('crypto');

// zbyt proste PIN-y, których nie przyjmujemy
const WEAK = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999',
    '123456', '654321', '123123', '121212', '112233', '010203', '000001', '123321', '696969', '111222']);

function scryptAsync(pin, salt, len) {
    return new Promise((resolve, reject) => crypto.scrypt(String(pin), salt, len, (err, key) => (err ? reject(err) : resolve(key))));
}

// zapis w bazie: scrypt$<sól>$<skrót> (PIN-u nie da się odczytać z bazy)
async function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(pin, salt, 32);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPin(pin, stored) {
    try {
        const [alg, saltHex, hashHex] = String(stored || '').split('$');
        if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
        const expected = Buffer.from(hashHex, 'hex');
        const got = await scryptAsync(pin, Buffer.from(saltHex, 'hex'), expected.length);
        return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    } catch (e) { return false; }
}

function isValidPin(pin) {
    const p = String(pin);
    return /^\d{6}$/.test(p) && !WEAK.has(p);
}

function generatePin() {
    let p;
    do { p = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (WEAK.has(p));
    return p;
}

module.exports = { hashPin, verifyPin, isValidPin, generatePin };