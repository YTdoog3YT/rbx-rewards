// =================== BŁĘDY NA DISCORDA ===================
// Każdy błąd zapisany przez console.error (postbacki, polecenia, wypłaty, tickety, pakiety, bot...) oraz nieobsłużone
// błędy procesu bot wysyła na kanał Discord. Ten sam błąd najwyżej raz na 10 minut, łącznie max 30 wiadomości na godzinę.
const CHANNEL_ID = '1574779899611316284';
const SAME_ERROR_EVERY_MS = 10 * 60 * 1000;
const MAX_PER_HOUR = 30;

const origError = console.error.bind(console);
let client = null;
const queue = [];
const lastSent = new Map();   // klucz błędu -> czas wysłania
const skipped = new Map();    // klucz błędu -> ile razy pominięto (powtórki)
let hourStart = Date.now(), sentThisHour = 0, flushing = false;

function toText(args) {
    return args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
    }).join(' ');
}
const keyOf = text => text.split('\n')[0].replace(/\d+/g, '#').slice(0, 120);

function report(text) {
    const now = Date.now();
    const k = keyOf(text);
    if ((lastSent.get(k) || 0) > now - SAME_ERROR_EVERY_MS) { skipped.set(k, (skipped.get(k) || 0) + 1); return; }
    lastSent.set(k, now);
    const rep = skipped.get(k) || 0; skipped.delete(k);
    queue.push({ text, rep, at: new Date() });
    if (queue.length > 50) queue.shift();
    flush();
}

async function flush() {
    if (flushing || !client || !client.isReady || !client.isReady()) return;
    flushing = true;
    try {
        const ch = client.channels.cache.get(CHANNEL_ID) || await client.channels.fetch(CHANNEL_ID).catch(() => null);
        if (!ch) { origError('[błędy→discord] nie mam dostępu do kanału ' + CHANNEL_ID); return; }
        while (queue.length) {
            if (Date.now() - hourStart > 60 * 60 * 1000) { hourStart = Date.now(); sentThisHour = 0; }
            if (sentThisHour >= MAX_PER_HOUR) { queue.length = 0; break; }
            const { text, rep, at } = queue.shift();
            const when = at.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const extra = rep ? `\n(ten sam błąd powtórzył się jeszcze ${rep}× w ostatnich minutach)` : '';
            const body = text.replace(/```/g, "'''").slice(0, 1700);
            await ch.send({ content: `⚠️ **Błąd na stronie** • ${when}${extra}\n\`\`\`\n${body}\n\`\`\``, allowedMentions: { parse: [] } });
            sentThisHour++;
        }
    } catch (e) { origError('[błędy→discord] wysyłka nie wyszła:', e.message); }
    finally { flushing = false; }
}

// to nie są błędy (ostrzeżenia Node o przestarzałych funkcjach, komunikaty dotenv) - tylko do logów, nie na Discorda
const NOT_ERRORS = [/DeprecationWarning/, /ExperimentalWarning/, /injected env/, /\[dotenv/];

// podmiana console.error: dalej pisze do logów Rendera, a dodatkowo wysyła na Discorda
console.error = (...args) => {
    origError(...args);
    try {
        const text = toText(args);
        if (NOT_ERRORS.some(re => re.test(text))) return;
        report(text);
    } catch (e) {}
};

process.on('unhandledRejection', reason => console.error('[proces] nieobsłużony błąd (promise):', reason));
process.on('uncaughtException', err => {
    console.error('[proces] krytyczny błąd, serwer się restartuje:', err);
    setTimeout(() => process.exit(1), 3000); // chwila na wysłanie wiadomości, potem restart jak dawniej
});

// wywołać, gdy bot Discord jest gotowy
function attachDiscord(discordClient) { client = discordClient; flush(); }

module.exports = { attachDiscord };
