require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, ApplicationCommandOptionType,
    PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ChannelType, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');
const mongoose = require('mongoose');
const Parser = require('rss-parser');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildPresences 
    ]
});

const CHANNELS = {
    WELCOME: '1279161469132341428',
    LEAVE: '1279161514670162082',
    ADMIN_CMDS: '1256544039579156541',
    MOD_LOGS: '1256544115517292616',
    YT_VIDEO: '1256545068349915217',
    STREAMS: '1256545089606516768',
    TICKETS: '1256545036112232499',
    TICKETS_CATEGORY: '1554373278418862150',
    STATS_TIME: '1256543516734128159',
    STATS_ONLINE: '1256543578281480265',
    STATS_ALL_REAL: '1275939716583129179',
    STATS_DATE: '1275939563415670926',
    STATS_BANS: '1275939641324732447',
    VOTING: '1279160696273244373',
    AUTOROLES: '1554380315156291625',
    COURT_CATEGORY: '1256543402749726752',
    RULES: '1256544920148119572',
    ADS: '1554394558349967370' 
};

// ==========================================
// REGULAMIN SERWERA
// ==========================================
const REGULAMIN_SERWERA = `
**Zasady Ogólne i Kanały Tekstowe (Czat)**
1️⃣ Bądźmy ludźmi – szanujmy się nawzajem. Zero wyzywania, toksyczności i dram.
2️⃣ Zakaz reklamowania innych serwerów, stron i swoich kanałów bez zgody administracji.
3️⃣ Nie spamuj – unikajmy wysyłania tych samych wiadomości po dziesięć razy.
4️⃣ Trzymaj się tematyki kanału (np. memy na kanale od memów).
5️⃣ Administracja ma zawsze ostatnie słowo. W razie łamania zasad, od razu wjeżdża Sąd.

**Zasady Kanałów Głosowych (Voice)**
🔊 Nie drzyj mordy do mikrofonu i nie puszczaj przesterów (zero earrape'ów).
🔊 Zakaz nagrywania rozmów bez zgody wszystkich obecnych na kanale.
🔊 Używaj "Naciśnij i mów" (push-to-talk) jeśli masz w tle remont, krzyczące rodzeństwo albo echo.
🔊 Nie skaczemy po kanałach bez sensu (zero channel hoppingu) żeby celowo kogoś wkurwiać.
🔊 Jeśli wbijasz komuś na kanał, zachowaj kulturę.
`;

// ==========================================
// USTAWIENIA REKLAMY RBX REWARDS
// ==========================================
const RBX_REWARDS_LINK = 'https://rbx-rewards.onrender.com/'; 
const RBX_REWARDS_LOGO = 'https://github.com/YTdoog3YT/Discord_bot/blob/main/logo.png?raw=true'; 

const AUTOROLES_LIST = [
    { label: '👦 Chłopak', value: '1554381536609050674', description: 'Twoja płeć' },
    { label: '👧 Dziewczyna', value: '1554381571799130132', description: 'Twoja płeć' },
    { label: '🔞 18+', value: '1554381848837230662', description: 'Mam ukończone 18 lat' },
    { label: '👶 18-', value: '1554381868126838924', description: 'Nie mam jeszcze 18 lat' },
    { label: '🎮 PlayStation', value: '1554381596373819392', description: 'Gram na konsoli PS' },
    { label: '🟢 Xbox', value: '1554381645522534400', description: 'Gram na konsoli Xbox' },
    { label: '💻 PC', value: '1554381663969087528', description: 'Gram na komputerze' },
    { label: '🟣 Powiadomienia Streamy', value: '1554381779094474793', description: 'Pingi o nowych live' },
    { label: '🔴 Powiadomienia Filmy', value: '1554381803798794351', description: 'Pingi o nowych filmach' }
];

// ==========================================
// USTAWIENIA TWÓRCY (YT & TWITCH)
// ==========================================
const TWITCH_USERNAME = 'TTV_YTdoog3YT'; 
const YOUTUBE_CHANNEL_ID = 'UC1QzrYhOlcmsOhZ5BQBZIvA'; 

const parser = new Parser();
let lastVideoId = ''; 
let isTwitchLive = false;
let twitchToken = '';

async function getTwitchToken() {
    try {
        if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return null;
        const response = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { method: 'POST' });
        const data = await response.json();
        twitchToken = data.access_token;
        return twitchToken;
    } catch (err) { console.error('❌ Błąd pobierania tokenu Twitch:', err); }
}

async function updateServerStats() {
    try {
        const guild = client.guilds.cache.first(); 
        if (!guild) return;

        await guild.members.fetch(); 
        const realUsers = guild.members.cache.filter(m => !m.user.bot);
        const onlineUsers = realUsers.filter(m => m.presence && m.presence.status !== 'offline' && m.presence.status !== 'invisible');
        const bans = await guild.bans.fetch();
        
        const now = new Date();
        const timeString = now.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
        const dateString = now.toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' });

        const channelTime = guild.channels.cache.get(CHANNELS.STATS_TIME);
        if (channelTime && channelTime.name !== `⌚ Godzina: ${timeString}`) await channelTime.setName(`⌚ Godzina: ${timeString}`);

        const channelDate = guild.channels.cache.get(CHANNELS.STATS_DATE);
        if (channelDate && channelDate.name !== `📅 Data: ${dateString}`) await channelDate.setName(`📅 Data: ${dateString}`);

        const channelAll = guild.channels.cache.get(CHANNELS.STATS_ALL_REAL);
        if (channelAll && channelAll.name !== `👥 Użytkownicy: ${realUsers.size}`) await channelAll.setName(`👥 Użytkownicy: ${realUsers.size}`);

        const channelOnline = guild.channels.cache.get(CHANNELS.STATS_ONLINE);
        if (channelOnline && channelOnline.name !== `🟢 Online: ${onlineUsers.size}`) await channelOnline.setName(`🟢 Online: ${onlineUsers.size}`);

        const channelBans = guild.channels.cache.get(CHANNELS.STATS_BANS);
        if (channelBans && channelBans.name !== `🔨 Zbanowani: ${bans.size}`) await channelBans.setName(`🔨 Zbanowani: ${bans.size}`);

    } catch (err) { console.error('❌ Błąd aktualizacji statystyk:', err); }
}

client.once('ready', async () => {
    console.log(`🤖 Bot Admina (Nr 2) gotowy! Zalogowano jako: ${client.user.tag}`);

    const commands = [
        { name: 'ban', description: 'Zbanuj użytkownika', options: [ { name: 'uzytkownik', type: ApplicationCommandOptionType.User, description: 'Kogo?', required: true }, { name: 'powod', type: ApplicationCommandOptionType.String, description: 'Za co?', required: true }, { name: 'czas', type: ApplicationCommandOptionType.String, description: 'Czas', required: false } ] },
        { name: 'kick', description: 'Wyrzuć użytkownika', options: [ { name: 'uzytkownik', type: ApplicationCommandOptionType.User, description: 'Kogo?', required: true }, { name: 'powod', type: ApplicationCommandOptionType.String, description: 'Powód', required: false } ] },
        { name: 'mute', description: 'Wycisz użytkownika', options: [ { name: 'uzytkownik', type: ApplicationCommandOptionType.User, description: 'Kogo?', required: true }, { name: 'czas', type: ApplicationCommandOptionType.String, description: 'Czas (np. 10m, 1h)', required: true }, { name: 'powod', type: ApplicationCommandOptionType.String, description: 'Powód', required: false } ] },
        { name: 'głosowanie', description: 'Stwórz nowe głosowanie na dedykowanym kanale', options: [ { name: 'tresc', type: ApplicationCommandOptionType.String, description: 'Treść / Pytanie w głosowaniu', required: true } ] },
        { name: 'sad', description: 'Zaciągnij gracza przed oblicze administracji!', options: [ { name: 'uzytkownik', type: ApplicationCommandOptionType.User, description: 'Oskarżony', required: true }, { name: 'powod', type: ApplicationCommandOptionType.String, description: 'Za co go sądzimy?', required: true } ] },
        { name: 'reklama', description: 'Wysyła ghost-ping @everyone na dedykowany kanał reklamowy!' } 
    ];
    await client.application.commands.set(commands).catch(console.error);

    try {
        const rulesChannel = client.channels.cache.get(CHANNELS.RULES);
        if (rulesChannel) {
            const messages = await rulesChannel.messages.fetch({ limit: 10 });
            const hasRules = messages.some(m => m.author.id === client.user.id && m.embeds[0]?.title === '📜 Regulamin Serwera');
            if (!hasRules) {
                const rulesEmbed = new EmbedBuilder().setColor('#ff4757').setTitle('📜 Regulamin Serwera').setDescription(REGULAMIN_SERWERA).setFooter({ text: 'Nieznajomość regulaminu nie zwalnia z jego przestrzegania!' }).setTimestamp();
                await rulesChannel.send({ embeds: [rulesEmbed] });
            }
        }
    } catch (err) {}

    try {
        const ticketChannel = client.channels.cache.get(CHANNELS.TICKETS);
        if (ticketChannel) {
            const messages = await ticketChannel.messages.fetch({ limit: 10 });
            const hasPanel = messages.some(m => m.author.id === client.user.id && m.components.length > 0 && m.embeds[0]?.title === '🎫 Pomoc i Wsparcie');
            if (!hasPanel) {
                const ticketEmbed = new EmbedBuilder().setColor('#2b2d31').setTitle('🎫 Pomoc i Wsparcie').setDescription('Potrzebujesz pomocy administracji? Kliknij przycisk poniżej, aby utworzyć prywatny kanał rozmowy.\n\n⚠️ **Pamiętaj:** Możesz mieć otwarty tylko **1** ticket naraz!');
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_ticket').setLabel('📩 Utwórz Ticket').setStyle(ButtonStyle.Success));
                await ticketChannel.send({ embeds: [ticketEmbed], components: [row] });
            }
        }
    } catch (err) {}

    try {
        const rolesChannel = client.channels.cache.get(CHANNELS.AUTOROLES);
        if (rolesChannel) {
            const messages = await rolesChannel.messages.fetch({ limit: 10 });
            const hasRolesPanel = messages.some(m => m.author.id === client.user.id && m.components.length > 0 && m.embeds[0]?.title === '🎭 Wybierz swoje role');
            if (!hasRolesPanel) {
                const rolesEmbed = new EmbedBuilder().setColor('#9b59b6').setTitle('🎭 Wybierz swoje role').setDescription('Otwórz menu poniżej i zaznacz role, które chcesz otrzymać. Możesz zaznaczyć **kilka naraz**! Jeśli chcesz zdjąć z siebie rolę, po prostu ją odznacz.');
                const selectMenu = new StringSelectMenuBuilder().setCustomId('autoroles_select').setPlaceholder('Rozwiń listę i wybierz...').setMinValues(0).setMaxValues(AUTOROLES_LIST.length).addOptions(AUTOROLES_LIST.map(role => new StringSelectMenuOptionBuilder().setLabel(role.label).setDescription(role.description).setValue(role.value)));
                const row = new ActionRowBuilder().addComponents(selectMenu);
                await rolesChannel.send({ embeds: [rolesEmbed], components: [row] });
            }
        }
    } catch (err) {}

    updateServerStats();
    setInterval(updateServerStats, 360000); 

    setInterval(async () => {
        try {
            if (YOUTUBE_CHANNEL_ID.includes('TUTAJ_WPISZ')) return; 
            const feed = await parser.parseURL(`https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`);
            if (feed.items.length > 0) {
                const latestVideo = feed.items[0];
                if (lastVideoId !== latestVideo.id) {
                    if (lastVideoId !== '') { 
                        const channel = client.channels.cache.get(CHANNELS.YT_VIDEO);
                        if (channel) {
                            const embed = new EmbedBuilder().setColor('#ff0000').setTitle('🔴 NOWY FILM NA KANALE!').setDescription(`Właśnie wjechał nowy materiał: **${latestVideo.title}**\n\n🔗 [Oglądaj tutaj!](${latestVideo.link})`).setTimestamp();
                            await channel.send({ content: '@everyone', embeds: [embed] });
                        }
                    }
                    lastVideoId = latestVideo.id; 
                }
            }
        } catch (err) { }
    }, 300000); 

    setInterval(async () => {
        try {
            if (!process.env.TWITCH_CLIENT_ID || TWITCH_USERNAME.includes('TUTAJ_WPISZ')) return;
            if (!twitchToken) await getTwitchToken();
            const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${TWITCH_USERNAME}`, { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${twitchToken}` } });
            if (res.status === 401) { await getTwitchToken(); return; } 
            const data = await res.json();
            const stream = data.data && data.data[0];
            if (stream) {
                if (!isTwitchLive) { 
                    isTwitchLive = true;
                    const channel = client.channels.cache.get(CHANNELS.STREAMS);
                    if (channel) {
                        const embed = new EmbedBuilder().setColor('#9146ff').setTitle('🟪 ODPALAMY STREAMA!').setDescription(`Gramy w **${stream.game_name || 'coś fajnego'}**!\n\n📝 **Temat:** ${stream.title}\n🔗 **[WBIJAJ NA LIVE!](https://twitch.tv/${TWITCH_USERNAME})**`).setImage(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${TWITCH_USERNAME.toLowerCase()}-1280x720.jpg?r=${Math.random()}`).setTimestamp();
                        await channel.send({ content: '@everyone', embeds: [embed] });
                    }
                }
            } else { isTwitchLive = false; }
        } catch (err) {}
    }, 180000); 
});

client.on('guildMemberAdd', member => {
    const channel = member.guild.channels.cache.get(CHANNELS.WELCOME);
    if (!channel) return;
    const embed = new EmbedBuilder().setColor('#00e676').setTitle(`👋 Witamy!`).setDescription(`Siemano **${member.user.username}**!`).setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }));
    channel.send({ embeds: [embed] });
});

client.on('guildMemberRemove', member => {
    const channel = member.guild.channels.cache.get(CHANNELS.LEAVE);
    if (!channel) return;
    const embed = new EmbedBuilder().setColor('#ff3333').setTitle(`😢 Ktoś nas opuścił...`).setDescription(`**${member.user.username}** poszedł sobie.`).setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }));
    channel.send({ embeds: [embed] });
});

function parseTimeToMs(timeStr) {
    if (!timeStr || timeStr.toLowerCase() === 'forever') return null;
    const match = timeStr.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    const val = parseInt(match[1]), unit = match[2];
    if (unit === 's') return val * 1000; if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000; if (unit === 'd') return val * 24 * 60 * 60 * 1000;
    return null;
}

client.on('interactionCreate', async interaction => {
    
    // --- OBSŁUGA MODALI (SĄD) ---
    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('modal_court_')) {
            const parts = interaction.customId.split('_');
            const action = parts[2]; 
            const userId = parts[3];
            
            const czas = interaction.fields.getTextInputValue('czas');
            const powod = interaction.fields.getTextInputValue('powod');
            
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            const logChannel = await interaction.guild.channels.fetch(CHANNELS.MOD_LOGS).catch(() => null);
            
            if (!member) return interaction.reply({ content: '❌ Ten gracz zdążył uciec z serwera!', ephemeral: true });

            const logEmbed = new EmbedBuilder().setThumbnail(member.user.displayAvatarURL({ dynamic: true })).setTimestamp().setFooter({ text: `Sędzia: ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });
            
            await interaction.reply({ content: `✅ Wyrok został wykonany. Kanały sądu znikną za 3 sekundy.`, ephemeral: true });

            if (action === 'ban') {
                const timeMs = parseTimeToMs(czas);
                await member.ban({ reason: powod });
                logEmbed.setColor('#000000').setTitle('🔨 ZBANOWANO GRACZA (SĄD)').setDescription(`**Gracz:** ${member}\n**Powód:** ${powod}\n**Czas:** ${czas || 'Zawsze'}`);
                if (timeMs) setTimeout(async () => { await interaction.guild.members.unban(member.id).catch(() => {}); }, timeMs);
                if (logChannel) await logChannel.send({ embeds: [logEmbed] });
            } 
            else if (action === 'mute') {
                const timeMs = parseTimeToMs(czas);
                if (timeMs) await member.timeout(timeMs, powod);
                logEmbed.setColor('#00bfff').setTitle('🔇 WYCISZONO GRACZA (SĄD)').setDescription(`**Gracz:** ${member}\n**Powód:** ${powod}\n**Czas:** ${czas}`);
                if (logChannel) await logChannel.send({ embeds: [logEmbed] });
                
                const topic = interaction.channel.topic || '';
                const roleMatch = topic.match(/roles:([\d,]+)/);
                if (roleMatch && roleMatch[1]) {
                    const rolesToRestore = roleMatch[1].split(',');
                    await member.roles.add(rolesToRestore).catch(() => {});
                }
            }

            const topic = interaction.channel.topic || '';
            const voiceMatch = topic.match(/voice:(\d+)/);
            if (voiceMatch && voiceMatch[1]) {
                const vc = interaction.guild.channels.cache.get(voiceMatch[1]);
                if (vc) await vc.delete().catch(() => {});
            }
            setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
            return;
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'autoroles_select') {
        const allAutoroleIds = AUTOROLES_LIST.map(r => r.value);
        const selectedRoles = interaction.values;
        const toAdd = selectedRoles;
        const toRemove = allAutoroleIds.filter(id => !selectedRoles.includes(id));
        
        try {
            await interaction.member.roles.add(toAdd);
            await interaction.member.roles.remove(toRemove);
            await interaction.reply({ content: '✅ Role zaktualizowane pomyślnie!', ephemeral: true });
        } catch (err) {
            console.error('Błąd nadawania ról:', err);
            await interaction.reply({ content: '❌ Wystąpił błąd. Upewnij się, że rola bota jest WYŻEJ na liście niż role, które próbujesz otrzymać!', ephemeral: true });
        }
        return;
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'create_ticket') {
            const ticketName = `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            const existingChannel = interaction.guild.channels.cache.find(c => c.name === ticketName);
            if (existingChannel) return interaction.reply({ content: `❌ Masz już otwarty ticket: <#${existingChannel.id}>`, ephemeral: true });

            const ticketChannel = await interaction.guild.channels.create({
                name: ticketName,
                type: ChannelType.GuildText,
                parent: CHANNELS.TICKETS_CATEGORY, 
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] }, 
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, 
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            await interaction.reply({ content: `✅ Twój ticket został utworzony: <#${ticketChannel.id}>`, ephemeral: true });
            const insideEmbed = new EmbedBuilder().setColor('#ffaa00').setTitle('🎫 Nowy Ticket').setDescription(`Witaj ${interaction.user}!\n\nOpisz swój problem, a administracja wkrótce Ci pomoże. Tylko Ty i administracja macie wgląd w ten kanał.`).setFooter({ text: 'Kliknięcie przycisku "Zamknij" bezpowrotnie skasuje ten kanał.' });
            const closeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Zamknij Ticket (Tylko Admin)').setStyle(ButtonStyle.Danger));
            await ticketChannel.send({ content: `@here`, embeds: [insideEmbed], components: [closeRow] });
        }

        if (interaction.customId === 'close_ticket') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Tylko administracja może zamknąć ten ticket!', ephemeral: true });
            await interaction.reply('🔒 Zamykanie ticketa... Kanał zniknie za 3 sekundy.');
            setTimeout(() => { interaction.channel.delete().catch(err => console.error("Nie udało się skasować ticketa", err)); }, 3000);
        }

        if (interaction.customId.startsWith('court_')) {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Tylko sędzia może wydawać wyroki!', ephemeral: true });
            
            const action = interaction.customId.split('_')[1]; 
            const userId = interaction.customId.split('_')[2];
            
            if (action === 'ban' || action === 'mute') {
                const modal = new ModalBuilder()
                    .setCustomId(`modal_court_${action}_${userId}`)
                    .setTitle(action === 'ban' ? 'Wymierz wyrok: BAN' : 'Wymierz wyrok: WYCISZ');
                
                const timeInput = new TextInputBuilder()
                    .setCustomId('czas')
                    .setLabel(action === 'ban' ? 'Czas (np. 7d, 1h, puste=Zawsze)' : 'Czas (np. 15m, 1h, 7d)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(action === 'mute'); 
                
                const reasonInput = new TextInputBuilder()
                    .setCustomId('powod')
                    .setLabel('Powód wyroku')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(timeInput), new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
            }
            
            if (action === 'free') {
                await interaction.reply('🟢 Uniewinnianie... Zwracam role i zamykam salę na 3 sekundy.');
                
                const topic = interaction.channel.topic || '';
                const roleMatch = topic.match(/roles:([\d,]+)/);
                if (roleMatch && roleMatch[1]) {
                    const rolesToRestore = roleMatch[1].split(',');
                    const member = await interaction.guild.members.fetch(userId).catch(() => null);
                    if (member) await member.roles.add(rolesToRestore).catch(() => {});
                }
                
                const voiceMatch = topic.match(/voice:(\d+)/);
                if (voiceMatch && voiceMatch[1]) {
                    const vc = interaction.guild.channels.cache.get(voiceMatch[1]);
                    if (vc) await vc.delete().catch(() => {});
                }
                setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
            }
        }
    }

    if (!interaction.isChatInputCommand()) return; 

    if (interaction.commandName !== 'reklama' && interaction.channelId !== CHANNELS.ADMIN_CMDS) {
        return interaction.reply({ content: `🚫 Komendy tylko na <#${CHANNELS.ADMIN_CMDS}>!`, ephemeral: true });
    }
    
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Brak uprawnień!', ephemeral: true });
    }

    const command = interaction.commandName;

    if (command === 'reklama') {
        const adsChannel = interaction.guild.channels.cache.get(CHANNELS.ADS);
        if (!adsChannel) return interaction.reply({ content: '❌ Nie znaleziono kanału reklamowego!', ephemeral: true });

        await interaction.reply({ content: `✅ Wysłano ghost pinga na kanał <#${CHANNELS.ADS}>!`, ephemeral: true });
        
        const pingMsg = await adsChannel.send('@everyone');
        setTimeout(() => pingMsg.delete().catch(() => {}), 1000);

        const messages = await adsChannel.messages.fetch({ limit: 10 });
        const hasAd = messages.some(m => m.author.id === client.user.id && m.embeds[0]?.title === '💸 Brakuje na kebsa albo energola?');

        if (!hasAd) {
            const promoEmbed = new EmbedBuilder()
                .setColor('#10b981')
                .setTitle('💸 Brakuje na kebsa albo energola?')
                .setDescription('A może chcesz po prostu trochę dorobić do kieszonkowego bez zbędnego wysiłku?\n\nWpadaj na **RBX Rewards**! Oglądaj filmy, wykonuj super proste zadania i wypłacaj realną gotówkę prosto na swoje konto (PayPal itp).\n\nSzybko, łatwo i bez żadnej ściemy!')
                .setImage(RBX_REWARDS_LOGO)
                .setFooter({ text: 'Zacznij zarabiać już teraz, klikając przycisk poniżej!' })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('💵 Odbierz Kasę')
                    .setStyle(ButtonStyle.Link)
                    .setURL(RBX_REWARDS_LINK)
            );

            await adsChannel.send({ embeds: [promoEmbed], components: [row] });
        }
        return;
    }
    
    if (command === 'sad') {
        const targetMember = interaction.options.getMember('uzytkownik');
        const reason = interaction.options.getString('powod') || 'Brak powodu';
        
        if (!targetMember) return interaction.reply({ content: '❌ Nie znalazłem użytkownika.', ephemeral: true });
        if (!targetMember.manageable) return interaction.reply({ content: '❌ Ten użytkownik ma zbyt wysoką rolę (immunitet)!', ephemeral: true });

        const cleanUsername = targetMember.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');

        const textChannel = await interaction.guild.channels.create({
            name: `📝-reichtag-${cleanUsername}`,
            type: ChannelType.GuildText,
            parent: CHANNELS.COURT_CATEGORY,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: targetMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });

        const voiceChannel = await interaction.guild.channels.create({
            name: `🔊-rozprawa-${cleanUsername}`,
            type: ChannelType.GuildVoice,
            parent: CHANNELS.COURT_CATEGORY,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: targetMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }
            ]
        });

        const savedRoles = [...targetMember.roles.cache.filter(r => r.id !== interaction.guild.id && !r.managed && interaction.guild.members.me.roles.highest.position > r.position).keys()];
        await textChannel.setTopic(`voice:${voiceChannel.id}|user:${targetMember.id}|roles:${savedRoles.join(',')}`);
        await targetMember.roles.remove(savedRoles).catch(() => {});

        await interaction.reply({ content: `✅ Sąd został otwarty: <#${textChannel.id}>`, ephemeral: true });

        const courtEmbed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setTitle('⚖️ SALA SĄDOWA')
            .setDescription(`${targetMember}, zostałeś wezwany na przesłuchanie!\n**Powód wezwania:** ${reason}\n\nTłumacz się. Administracja zadecyduje o Twoim losie.`)
            .setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true, size: 256 }));

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`court_ban_${targetMember.id}`).setLabel('🔴 ZBANUJ').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`court_mute_${targetMember.id}`).setLabel('🟡 WYCISZ').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`court_free_${targetMember.id}`).setLabel('🟢 UNIEWINNIJ').setStyle(ButtonStyle.Success)
        );

        await textChannel.send({ content: `${targetMember} @here`, embeds: [courtEmbed], components: [row] });
        return; 
    }

    if (command === 'głosowanie') {
        const tresc = interaction.options?.getString('tresc') || "Brak treści.";
        const voteChannel = interaction.guild.channels.cache.get(CHANNELS.VOTING);
        if (!voteChannel) return interaction.reply({ content: '❌ Nie znaleziono kanału do głosowań!', ephemeral: true });

        const voteEmbed = new EmbedBuilder().setColor('#ffd700').setTitle('📊 Nowe Głosowanie!').setDescription(`**${tresc}**`).setFooter({ text: `Autor: ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() }).setTimestamp();

        await interaction.reply({ content: '✅ Głosowanie zostało wystawione na odpowiednim kanale.', ephemeral: true });
        const msg = await voteChannel.send({ content: '@everyone', embeds: [voteEmbed] });
        await msg.react('✅');
        await msg.react('❌');
        return; 
    }

    const targetMember = interaction.options?.getMember('uzytkownik');
    const reason = interaction.options?.getString('powod') || 'Brak powodu';
    const timeString = interaction.options?.getString('czas');
    const logChannel = await interaction.guild.channels.fetch(CHANNELS.MOD_LOGS).catch(() => null);

    if (!targetMember) return interaction.reply({ content: '❌ Nie znalazłem użytkownika.', ephemeral: true });
    if (!targetMember.manageable || !targetMember.bannable) return interaction.reply({ content: '❌ Ten użytkownik ma zbyt wysoką rolę!', ephemeral: true });

    const logEmbed = new EmbedBuilder().setThumbnail(targetMember.user.displayAvatarURL({ dynamic: true })).setTimestamp().setFooter({ text: `Przez: ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

    try {
        if (command === 'ban') {
            const timeMs = parseTimeToMs(timeString);
            await targetMember.ban({ reason });
            logEmbed.setColor('#000000').setTitle('🔨 ZBANOWANO GRACZA').setDescription(`**Gracz:** ${targetMember}\n**Powód:** ${reason}\n**Czas:** ${timeString || 'Zawsze'}`);
            if (timeMs) setTimeout(async () => { await interaction.guild.members.unban(targetMember.id).catch(() => {}); }, timeMs);
            await interaction.reply({ content: `✅ **${targetMember.user.username}** dostał bana.`, ephemeral: true });
            if (logChannel) logChannel.send({ embeds: [logEmbed] });
        }
        if (command === 'kick') {
            await targetMember.kick(reason);
            logEmbed.setColor('#ff9900').setTitle('👢 WYRZUCONO GRACZA').setDescription(`**Gracz:** ${targetMember}\n**Powód:** ${reason}`);
            await interaction.reply({ content: `✅ **${targetMember.user.username}** wyrzucony.`, ephemeral: true });
            if (logChannel) logChannel.send({ embeds: [logEmbed] });
        }
        if (command === 'mute') {
            const timeMs = parseTimeToMs(timeString);
            if (!timeMs) return interaction.reply({ content: '❌ Podaj poprawny czas wyciszenia!', ephemeral: true });
            await targetMember.timeout(timeMs, reason);
            logEmbed.setColor('#00bfff').setTitle('🔇 WYCISZONO GRACZA').setDescription(`**Gracz:** ${targetMember}\n**Powód:** ${reason}\n**Czas:** ${timeString}`);
            await interaction.reply({ content: `✅ **${targetMember.user.username}** wyciszony na ${timeString}.`, ephemeral: true });
            if (logChannel) logChannel.send({ embeds: [logEmbed] });
        }
    } catch (error) {}
});

module.exports = {
    init: () => {
        client.login(process.env.BOT_2_TOKEN).catch(err => {
            console.error("❌ Błąd logowania Bota nr 2:", err.message);
        });
    }
};