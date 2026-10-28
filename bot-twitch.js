const tmi = require('tmi.js');

const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const TWITCH_BOT_TOKEN = process.env.TWITCH_BOT_TOKEN; 
const TWITCH_CHANNEL = 'ttv_ytdoog3yt'; 

const cooldowns = new Set();
const COOLDOWN_SECONDS = 5; 

module.exports = {
    init: () => {
        if (!TWITCH_BOT_USERNAME || !TWITCH_BOT_TOKEN) {
            console.log("⚠️ Brak danych do Twitch Bota. Pomijam uruchamianie.");
            return;
        }

        const client = new tmi.Client({
            options: { debug: false },
            connection: { reconnect: true, secure: true },
            identity: { username: TWITCH_BOT_USERNAME, password: TWITCH_BOT_TOKEN },
            channels: [TWITCH_CHANNEL]
        });

        client.connect().then(() => {
            console.log(`🟪 Bot Twitch (${TWITCH_BOT_USERNAME}) podłączony do kanału ${TWITCH_CHANNEL}!`);
        }).catch(err => console.error("Błąd połączenia Twitch:", err));

        client.on('message', (channel, tags, message, self) => {
            if (self || !message.startsWith('!')) return;

            const args = message.slice(1).split(' ');
            const command = args[0].toLowerCase();

            if (cooldowns.has(command)) return;

            let response = "";
            if (command === 'strona' || command === 'rbx') {
                response = "💎 Odbieraj darmowe Robuxy za granie w gry i ankiety! Wbijaj na: https://rbx-rewards.onrender.com";
            } else if (command === 'discord' || command === 'dc') {
                response = "👾 Dołącz do naszej armii na Discordzie! Kliknij tutaj: https://discord.gg/49EwqEsFTJ";
            } else if (command === 'pomoc' || command === 'komendy') {
                response = "🛠️ Dostępne komendy: !strona, !discord, !yt";
            } else if (command === 'yt' || command === 'youtube') {
                response = "🔴 Zostaw suba na moim YouTube! https://www.youtube.com/@ttv_ytdoog3yt778";
            }

            if (response !== "") {
                client.say(channel, response).catch(err => {});
                cooldowns.add(command);
                setTimeout(() => { cooldowns.delete(command); }, COOLDOWN_SECONDS * 1000);
            }
        });
    }
};