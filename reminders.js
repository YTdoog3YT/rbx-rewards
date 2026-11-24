// =================== PRZYPOMNIENIA OD BOTA (prywatne wiadomości) ===================
// Lista przypomnień poniżej. Bot sprawdza co minutę (czas polski), czy któreś trzeba wysłać.
// To, co już poszło, jest zapisane w bazie, więc restart serwera nie wyśle niczego drugi raz.
// Jeśli serwer nie działał o tej godzinie, przypomnienie pójdzie później tego samego dnia.
const mongoose = require('mongoose');

const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];

// daysBeforeEnd: ile dni przed ostatnim dniem miesiąca (1 = przedostatni dzień: 29/30, w lutym 27 albo 28 w roku przestępnym;
//                5 = np. 25 kwietnia). months: tylko w tych miesiącach (1-12). skipMonths: oprócz tych miesięcy.
const ALEKS = '1211371515048894486';
const BRAJAN = '398911896893521921';
const aleksText = ({ monthName, year }) => `📄 **Hej Aleks!** Zbliża się koniec miesiąca, podeślij proszę Brajanowi wyciąg za ${monthName} ${year}. Dzięki!`;

const REMINDERS = [
    // Aleks: wyciąg dzień przed końcem miesiąca, w kwietniu 5 dni przed końcem (25.04, razem z PIT-em)
    { id: 'aleks-wyciag', discordId: ALEKS, daysBeforeEnd: 1, skipMonths: [4], hour: 12, startFrom: '2026-12', text: aleksText },
    { id: 'aleks-wyciag-kwiecien', discordId: ALEKS, daysBeforeEnd: 5, months: [4], hour: 12, startFrom: '2026-12', text: aleksText },

    // Brajan: co miesiąc (oprócz kwietnia) VAT i papiery do PIT-u
    {
        id: 'brajan-vat-pit', discordId: BRAJAN, daysBeforeEnd: 1, skipMonths: [4], hour: 12, startFrom: '2026-12',
        text: ({ monthName, year }) => `📋 **Hej Brajan!** Jutro koniec miesiąca (${monthName} ${year}): ogarnij **VAT-R/VAT-UE** i zbierz wszystkie dowody i pliki, żeby uzupełnić Excela do PIT-u.`
    },
    // Brajan: w kwietniu 5 dni przed końcem (25.04) wysyłka PIT-u za poprzedni rok
    {
        id: 'brajan-pit-kwiecien', discordId: BRAJAN, daysBeforeEnd: 5, months: [4], hour: 12, startFrom: '2026-12',
        text: ({ year }) => `🧾 **Hej Brajan!** Za 5 dni koniec kwietnia: ogarnij **VAT-R/VAT-UE**, uzupełnij wszystkie dane i **WYŚLIJ PIT za ${year - 1}** (termin 30.04)!`
    },
];

// wiadomości jednorazowe (wysyłane raz, zaraz po starcie bota; potem już nigdy)
const ONE_TIME = [
    {
        id: 'intro-aleks', discordId: ALEKS,
        text: '👋 **Cześć Aleks!** To wiadomość testowa od bota RBX Rewards.\nNa tym czacie będę Ci przypominał o dokumentach: pod koniec każdego miesiąca o wyciągu (w kwietniu 25.04).\n📤 Dokumenty wysyłaj **Brajanowi prywatnie**, nie tutaj – tu nikt ich nie odczyta.'
    },
    {
        id: 'intro-brajan', discordId: BRAJAN,
        text: '👋 **Cześć Brajan!** To wiadomość testowa od bota RBX Rewards.\nNa tym czacie będę Ci przypominał o dokumentach: pod koniec każdego miesiąca o VAT-R/VAT-UE i papierach do PIT-u, a co roku 25.04 o wysłaniu PIT-u.\n📤 Aleks dostał info, że wyciągi ma wysyłać **Tobie prywatnie**, nie botowi.'
    },
];

const ReminderSentSchema = new mongoose.Schema({ key: { type: String, unique: true }, sentAt: { type: Date, default: Date.now } });
const ReminderSent = mongoose.models.ReminderSent || mongoose.model('ReminderSent', ReminderSentSchema);

function warsawNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).map(p => [p.type, p.value]));
    return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour };
}
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12

// zwraca klucz okresu (np. 'aleks-wyciag:2026-12'), jeśli przypomnienie wypada teraz
function dueKey(r, now) {
    const ym = `${now.y}-${String(now.m).padStart(2, '0')}`;
    if (ym < r.startFrom || now.h < r.hour) return null;
    if (r.months && !r.months.includes(now.m)) return null;
    if (r.skipMonths && r.skipMonths.includes(now.m)) return null;
    if (now.d === lastDayOfMonth(now.y, now.m) - r.daysBeforeEnd) return `${r.id}:${ym}`;
    return null;
}

let busy = false;
async function tick(client) {
    if (busy || !client || !client.isReady || !client.isReady()) return;
    busy = true;
    try {
        for (const o of ONE_TIME) {
            const key = 'once:' + o.id;
            if (await ReminderSent.exists({ key })) continue;
            try {
                const user = await client.users.fetch(o.discordId);
                await user.send({ content: o.text, allowedMentions: { parse: [] } });
                await ReminderSent.create({ key });
                console.log(`[przypomnienia] wysłano ${key}`);
            } catch (e) { console.error(`[przypomnienia] nie wysłano ${key} (prywatna wiadomość do ${o.discordId}):`, e.message); }
        }
        const now = warsawNow();
        for (const r of REMINDERS) {
            const key = dueKey(r, now);
            if (!key || await ReminderSent.exists({ key })) continue;
            try {
                const user = await client.users.fetch(r.discordId);
                await user.send({ content: r.text({ monthName: MONTHS[now.m - 1], year: now.y }), allowedMentions: { parse: [] } });
                await ReminderSent.create({ key });
                console.log(`[przypomnienia] wysłano ${key}`);
            } catch (e) { console.error(`[przypomnienia] nie wysłano ${key} (prywatna wiadomość do ${r.discordId}):`, e.message); }
        }
    } catch (e) { console.error('[przypomnienia] sprawdzanie:', e.message); }
    finally { busy = false; }
}

// wywołać, gdy bot Discord jest gotowy
function startReminders(client) {
    setTimeout(() => tick(client), 20 * 1000);
    setInterval(() => tick(client), 60 * 1000).unref();
}

module.exports = { startReminders, dueKey, lastDayOfMonth, REMINDERS };
