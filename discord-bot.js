const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');

const { hashPin, generatePin, isValidPin } = require('./pin-utils');
const { notify, notifyAll, hasUnreadTicketNotice } = require('./notifications');
const KANAL_OGLOSZENIA_ID = "1566148109535416420"; // nowa wiadomość tutaj = powiadomienie "nowe ogłoszenie" na stronie

// Twoje kanały
const KANAL_PUBLICZNY_ID = "1566002632848449616";
const KANAL_ADMIN_ID = "1548618275083264060";
const KANAL_ZLECENIA_ID = "1548683873012162601";
const KANAL_PAKIETY_ROBUX_ID = "1565989968050913310";
const KANAL_PAKIETY_WT_ID = "1566002493966516354";
const KANAL_PAKIETY_SS_ID = KANAL_PAKIETY_ROBUX_ID; // Star Stable: na razie ten sam kanał co Robux; gdy utworzysz osobny, wpisz tu jego ID w cudzysłowie
const BUNDLE_CAT_LABELS = { robux: 'Robux', wt: 'War Thunder', ss: 'Star Stable' };
const ADMIN_DISCORD_ID = "398911896893521921";

// Tickety (support ze strony)
const GUILD_ID = "1543214998812102718";
const TICKET_CATEGORY_ID = "1573458449369407488";
const TICKET_ROLE_IDS = ["1548633150870261791", "1548633079898316800"]; // administracja, właściciel
const TICKET_DELETE_AFTER_MS = 60 * 60 * 1000; // kanał rozwiązanego ticketu znika po godzinie

let client;
let dbModels;

// Słownik aktywnych giveawayów w pamięci RAM
const activeGiveaways = new Map();

module.exports = {
    init: (discordClient, models) => {
        client = discordClient;
        dbModels = models;

        // ===================== POWIADOMIENIA NA STRONIE =====================
        client.on('messageCreate', async message => {
            try {
                if (!message.guild) return;
                // ogłoszenie: każda wiadomość na kanale ogłoszeń (oprócz naszego bota)
                if (message.channelId === KANAL_OGLOSZENIA_ID) {
                    if (client.user && message.author.id === client.user.id) return;
                    await notifyAll('announcement', { messageId: message.id });
                    return;
                }
                // ticket: ktoś inny niż autor ticketu napisał na kanale ticketu
                if (message.author.bot || message.channel.parentId !== TICKET_CATEGORY_ID) return;
                const t = await dbModels.Ticket.findOne({ channelId: message.channelId }).lean();
                if (!t || String(t.discordId) === message.author.id) return;
                if (await hasUnreadTicketNotice(dbModels.User, t.username, t._id)) return; // już ma nieprzeczytane o tym tickecie
                await notify(t.username, 'ticket_reply', { ticketId: String(t._id), number: t.number, dayKey: t.dayKey || '' });
            } catch (e) { console.error('[powiadomienia] discord:', e.message); }
        });

        client.on('messageCreate', async message => {
            if (message.author.bot) return;
            const args = message.content.split(' ');
            const cmd = args[0].toLowerCase();

            // Tylko ty możesz odpalać te komendy
            if (['!kod', '!kody', '!usunkod', '!giveaway'].includes(cmd) && message.author.id !== ADMIN_DISCORD_ID) {
                return message.reply('❌ You don\'t have permission to use this command.');
            }

            // --- NOWOŚĆ: KOMENDA GIVEAWAY ---
            if (cmd === '!giveaway') {
                if (args.length !== 3) return message.reply('⚠️ Użycie: `!giveaway <ile_robux> <czas_w_minutach>`\nNp. `!giveaway 50 10`');
                
                const robuxReward = parseFloat(args[1]);
                const minutes = parseInt(args[2]);
                
                if (isNaN(robuxReward) || isNaN(minutes)) return message.reply('❌ Kwota i czas muszą być liczbami.');

                const giveawayId = `gw_${Date.now()}`;
                activeGiveaways.set(giveawayId, { reward: robuxReward, participants: [] });

                const embed = {
                    title: "🎉 NEW GIVEAWAY! 🎉",
                    description: `Prize: **${robuxReward} R$** sent straight to your account on the website!\n\n⏳ **Time:** ${minutes} min\n👇 Click the button below, enter your website username and join the draw!`,
                    color: 0x00e676,
                    footer: { text: "Automatic draw" }
                };

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`join_gw_${giveawayId}`).setLabel('🎟️ Join the giveaway').setStyle(ButtonStyle.Success)
                );

                const gwMsg = await message.channel.send({ embeds: [embed], components: [row] });

                // Odliczanie i losowanie
                setTimeout(async () => {
                    const gwData = activeGiveaways.get(giveawayId);
                    if (!gwData || gwData.participants.length === 0) {
                        gwMsg.edit({ embeds: [{ title: "❌ Giveaway ended", description: "Nobody joined :(", color: 0xff3333 }], components: [] });
                        activeGiveaways.delete(giveawayId);
                        return;
                    }

                    // Losowanie
                    const winnerNick = gwData.participants[Math.floor(Math.random() * gwData.participants.length)];
                    
                    // Doładowanie konta w bazie
                    try {
                        let user = await dbModels.User.findOne({ username: new RegExp(`^${winnerNick}$`, 'i') });
                        if (user) {
                            user.points += robuxReward;
                            await user.save();
                            await new dbModels.Earning({ username: user.username, amount: robuxReward, source: 'Giveaway' }).save();
                        }
                    } catch(err) { console.log("Błąd dodawania R$ w giveaway:", err); }

                    gwMsg.edit({ embeds: [{ title: "🎉 GIVEAWAY ENDED!", description: `Winner: **${winnerNick}**!\n💰 **${robuxReward} R$** has been added to their website account automatically!`, color: 0xffb703 }], components: [] });
                    activeGiveaways.delete(giveawayId);
                    
                }, minutes * 60 * 1000);
            }
            
            // --- KOMENDY KODÓW PROMOCYJNYCH ---
            if (cmd === '!kod') {
                if (args.length !== 4) return message.reply('⚠️ Użycie: `!kod <NAZWA> <PUNKTY> <MAX_OSÓB>`');
                const codeName = args[1].toUpperCase(); const reward = parseFloat(args[2]); const maxUses = parseInt(args[3]);
                try {
                    let existing = await dbModels.PromoCode.findOne({ code: codeName });
                    if (existing) {
                        existing.reward = reward; existing.maxUses = maxUses; existing.currentUses = 0; existing.usedBy = []; 
                        await existing.save();
                        return message.reply(`♻️ **Kod odnowiony!** \`${codeName}\` — **${reward} R$** (Limit: ${maxUses} użyć).`);
                    }
                    await new dbModels.PromoCode({ code: codeName, reward: reward, maxUses: maxUses }).save();
                    message.reply(`✅ **Kod utworzony!** \`${codeName}\` — **${reward} R$** (Limit: ${maxUses} użyć).`);
                } catch (err) {}
            }

            if (cmd === '!kody') {
                try {
                    const codes = await dbModels.PromoCode.find({});
                    if (!codes || codes.length === 0) {
                        return message.reply('📭 Brak jakichkolwiek kodów promocyjnych w bazie.');
                    }
                    let list = '🎟️ **Lista Kodów Promocyjnych:**\n\n';
                    codes.forEach(c => {
                        const isActive = c.currentUses < c.maxUses;
                        const statusIcon = isActive ? '🟢 Aktywny' : '🔴 Wykorzystany';
                        list += `${statusIcon} | Kod: \`${c.code}\` | Nagroda: **${c.reward} R$** | Użycia: **${c.currentUses}/${c.maxUses}**\n`;
                    });
                    message.reply(list);
                } catch (err) {
                    message.reply('❌ Błąd podczas pobierania kodów.');
                }
            }

            if (cmd === '!usunkod') {
                if (args.length !== 2) return message.reply('⚠️ Użycie: `!usunkod <NAZWA>`');
                const codeName = args[1].toUpperCase();
                try {
                    const deleted = await dbModels.PromoCode.findOneAndDelete({ code: codeName });
                    if (deleted) {
                        message.reply(`🗑️ Pomyślnie usunięto kod \`${codeName}\` z bazy danych!`);
                    } else {
                        message.reply(`❌ Nie znaleziono kodu o nazwie \`${codeName}\`.`);
                    }
                } catch (err) {
                    message.reply('❌ Błąd podczas usuwania kodu.');
                }
            }
        });

        // ===================== KANAŁ POMYSŁÓW =====================
        const KANAL_POMYSLY_ID = "1566904973210685501";
        const IDEA_COOLDOWN_MS = 10 * 60 * 1000; // jeden pomysł na osobę co 10 minut
        const IDEA_MIN = 10, IDEA_MAX = 1500;
        const ideaThreads = new Map();      // userId -> id otwartego wątku
        const ideaLastPublish = new Map();  // userId -> czas ostatniego pomysłu
        const ideaPublishing = new Set();   // wątki w trakcie publikacji

        // wysyła panel z przyciskiem na sam dół kanału (stary panel jest usuwany)
        async function refreshIdeaPanel() {
            const channel = client.channels.cache.get(KANAL_POMYSLY_ID) || await client.channels.fetch(KANAL_POMYSLY_ID).catch(() => null);
            if (!channel) return null;
            const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
            if (recent) {
                for (const msg of recent.values()) {
                    const isPanel = msg.author.id === client.user.id && msg.components.some(row => row.components.some(c => c.customId === 'idea_new'));
                    if (isPanel) await msg.delete().catch(() => {});
                }
            }
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('idea_new').setLabel('💡 Share an idea').setStyle(ButtonStyle.Success)
            );
            return channel.send({
                embeds: [{
                    title: "💡 Got an idea for RBX Rewards?",
                    description: "Click the button below and I'll open a **private thread** for you (only you and the staff can see it). Write your idea there and it will be posted on this channel for voting ✅ / ❌.\n\nYou can't type in this channel. Ideas are added only with the button.",
                    color: 0x00e676
                }],
                components: [row]
            });
        }

        client.on('messageCreate', async message => {
            if (message.author.bot) return;

            // komenda admina: wysyła (lub odświeża) panel z przyciskiem
            if (message.content.trim().toLowerCase() === '!pomysly') {
                if (message.author.id !== ADMIN_DISCORD_ID) return message.reply('❌ You don\'t have permission to use this command.');
                const sent = await refreshIdeaPanel();
                return message.reply(sent ? '✅ Panel pomysłów wysłany na kanał pomysłów.' : '❌ Nie mam dostępu do kanału pomysłów (sprawdź uprawnienia bota).');
            }

            // wiadomość właściciela w jego prywatnym wątku = jego pomysł
            const ch = message.channel;
            if (!ch.isThread || !ch.isThread() || ch.parentId !== KANAL_POMYSLY_ID) return;
            const m = ch.name.match(/(\d{17,20})$/);
            if (!m || m[1] !== message.author.id) return; // wiadomości adminów w wątku to zwykła rozmowa
            if (ideaPublishing.has(ch.id)) return;

            const text = message.content.trim();
            if (text.length < IDEA_MIN) return ch.send(`✏️ Your idea is too short (min. ${IDEA_MIN} characters). Describe it in more detail and send it again.`);
            if (text.length > IDEA_MAX) return ch.send(`✂️ Your idea is too long (${text.length}/${IDEA_MAX} characters). Shorten it and send it again.`);

            ideaPublishing.add(ch.id);
            try {
                const ideasChannel = client.channels.cache.get(KANAL_POMYSLY_ID) || await client.channels.fetch(KANAL_POMYSLY_ID);
                const files = [...message.attachments.values()]
                    .filter(a => (a.contentType || '').startsWith('image/') && a.size <= 8 * 1024 * 1024)
                    .slice(0, 3).map(a => ({ attachment: a.url, name: a.name }));
                const sent = await ideasChannel.send({
                    embeds: [{
                        title: "💡 NEW IDEA",
                        description: `<@${message.author.id}>\n\n${text}`,
                        color: 0xffb703,
                        timestamp: new Date().toISOString(),
                        footer: { text: "Vote with a reaction: ✅ I want this on the site, ❌ I don't" }
                    }],
                    files,
                    allowedMentions: { parse: [] }
                });
                await sent.react('✅');
                await sent.react('❌');

                ideaLastPublish.set(message.author.id, Date.now());
                ideaThreads.delete(message.author.id);
                await ch.send('🎉 Thank you! Your idea is now up for voting. This thread will disappear in a moment.');
                setTimeout(() => { ch.delete().catch(() => ch.setArchived(true).catch(() => {})); }, 6000);
                await refreshIdeaPanel();
            } catch (err) {
                console.error('[pomysły] publikacja:', err.message);
                ideaPublishing.delete(ch.id);
                ch.send('❌ Couldn\'t publish your idea. Try again, and if it still doesn\'t work, contact the staff.').catch(() => {});
            }
        });

        client.on('interactionCreate', async interaction => {
            if (!interaction.isButton() || interaction.customId !== 'idea_new') return;
            const userId = interaction.user.id;

            const wait = IDEA_COOLDOWN_MS - (Date.now() - (ideaLastPublish.get(userId) || 0));
            if (wait > 0) return interaction.reply({ content: `⏳ You can add another idea in ${Math.ceil(wait / 60000)} min.`, ephemeral: true });

            const existingId = ideaThreads.get(userId);
            if (existingId) {
                const t = await client.channels.fetch(existingId).catch(() => null);
                if (t) {
                    if (t.archived) await t.setArchived(false).catch(() => {});
                    return interaction.reply({ content: `📝 You already have an open idea thread: <#${t.id}>`, ephemeral: true });
                }
                ideaThreads.delete(userId);
            }

            await interaction.deferReply({ ephemeral: true });
            try {
                const parent = interaction.channel;
                if (!parent || parent.id !== KANAL_POMYSLY_ID) return interaction.editReply('❌ This button only works in the ideas channel.');
                const rawName = (interaction.member && interaction.member.displayName) || interaction.user.username;
                const safeName = rawName.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'player';
                const thread = await parent.threads.create({
                    name: `💡 ${safeName} ${userId}`,
                    type: ChannelType.PrivateThread,
                    autoArchiveDuration: 60,
                    invitable: false,
                    reason: 'Nowy pomysł od gracza'
                });
                await thread.members.add(userId);
                await thread.members.add(ADMIN_DISCORD_ID).catch(() => {});
                ideaThreads.set(userId, thread.id);
                await thread.send({
                    content: `<@${userId}>`,
                    embeds: [{
                        title: "💡 Write your idea",
                        description: `Describe it in **one message** (${IDEA_MIN} to ${IDEA_MAX} characters). You can attach up to 3 screenshots.\n\nOnce you send it, your idea will be posted on the voting channel and this thread will disappear. Only you and the staff can see this thread.\n\n*Ideas that break the rules (spam, swearing) will be removed.*`,
                        color: 0xffb703
                    }]
                });
                return interaction.editReply(`✅ I've opened a private thread just for you and the staff: <#${thread.id}>`);
            } catch (err) {
                console.error('[pomysły] tworzenie wątku:', err.message);
                return interaction.editReply('❌ Couldn\'t open a thread. Please contact the staff.').catch(() => {});
            }
        });

        // ===================== KOMENDA ADMINA: NAZWY KANAŁÓW PO ANGIELSKU =====================
        // jednorazowo: !przetlumaczkanaly zmienia na angielski nazwy kanałów publicznych (kanały moderacji zostają po polsku)
        const CHANNEL_RENAMES = {
            'testerzy-wymagania': 'tester-requirements',
            'kody': 'promo-codes',
            'potwierdzenia-wypłat': 'payout-proofs',
            'ogloszenia': 'announcements',
            'ogłoszenia': 'announcements',
            'testerzy': 'testers',
            'kanały tekstowe': 'Text Channels',
            'ogólny': 'general',
            'kanały głosowe': 'Voice Channels',
            'ogólne': 'General',
            'tickety': 'Tickets'
        };

        client.on('messageCreate', async message => {
            if (message.author.bot || !message.guild) return;
            if (message.content.trim().toLowerCase() !== '!przetlumaczkanaly') return;
            if (message.author.id !== ADMIN_DISCORD_ID) return message.reply('❌ You don\'t have permission to use this command.');

            const status = await message.reply('⏳ Zmieniam nazwy kanałów...');
            const done = [], failed = [];
            const channels = await message.guild.channels.fetch();
            for (const ch of channels.values()) {
                if (!ch) continue;
                const current = ch.name;
                let target = CHANNEL_RENAMES[current.trim().toLowerCase()];
                // kanał pomysłów ma emoji w nazwie, podmieniamy tylko słowo
                if (!target && /pomysły|pomysly/i.test(current)) target = current.replace(/pomysły|pomysly/i, 'ideas');
                if (!target || target === current) continue;
                try {
                    await ch.setName(target, 'Serwer po angielsku');
                    done.push(`${current} → ${target}`);
                } catch (e) {
                    failed.push(`${current} (${e.message})`);
                }
                await new Promise(r => setTimeout(r, 1200)); // spokojnie, żeby nie wpaść w limit Discorda
            }
            let txt = `✅ Zmieniono: **${done.length}**\n` + (done.length ? '```\n' + done.join('\n') + '\n```' : '');
            if (failed.length) txt += `\n❌ Nie udało się (${failed.length}):\n` + '```\n' + failed.join('\n') + '\n```';
            await status.edit(txt.slice(0, 1990)).catch(() => message.channel.send(txt.slice(0, 1990)));
        });

        // ===================== KOMENDA ADMINA: PIN GRACZA =====================
        client.on('messageCreate', async message => {
            if (message.author.bot) return;
            const args = message.content.trim().split(/\s+/);
            if (args[0].toLowerCase() !== '!ustawpin') return;
            if (message.author.id !== ADMIN_DISCORD_ID) return message.reply('❌ You don\'t have permission to use this command.');

            const nick = args[1];
            let pin = args[2];
            if (!nick) return message.reply('⚠️ Użycie: `!ustawpin <nick> <6 cyfr>` (bez PIN-u wylosuję nowy).');
            // wiadomość z PIN-em znika od razu (bot potrzebuje uprawnienia "Zarządzanie wiadomościami" na tym kanale)
            await message.delete().catch(() => {});

            if (pin && !isValidPin(pin)) return message.channel.send('❌ PIN musi mieć dokładnie 6 cyfr i nie może być zbyt prosty (np. 123456).');
            if (!pin) pin = generatePin();
            try {
                const safe = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const user = await dbModels.User.findOneAndUpdate(
                    { username: new RegExp(`^${safe}$`, 'i') },
                    { $set: { pinHash: await hashPin(pin), pinAttempts: 0, pinLockedUntil: null } },
                    { new: true }
                );
                if (!user) return message.channel.send(`❌ Nie znaleziono gracza \`${nick}\`.`);
                const reply = await message.channel.send(`✅ Ustawiono PIN dla **${user.username}**: ||${pin}|| (ta wiadomość zniknie za 60 s)`);
                setTimeout(() => reply.delete().catch(() => {}), 60000);
            } catch (err) {
                console.error('[pin] ustawianie:', err.message);
                message.channel.send('❌ Nie udało się ustawić PIN-u (błąd bazy).').catch(() => {});
            }
        });

        // ===================== BLOKADA KONTA: decyzja na tickecie (tylko właściciel) =====================
        client.on('interactionCreate', async interaction => {
            if (!interaction.isButton()) return;
            const cid = interaction.customId || '';
            const isKeep = cid.startsWith('blockkeep_'), isUnblock = cid.startsWith('blockunblock_');
            if (!isKeep && !isUnblock) return;
            if (interaction.user.id !== ADMIN_DISCORD_ID) return interaction.reply({ content: '❌ Only the owner can decide on the block.', ephemeral: true }).catch(() => {});
            try {
                const ticketId = cid.slice(cid.indexOf('_') + 1);
                const t = await dbModels.Ticket.findById(ticketId).lean();
                if (!t) return interaction.reply({ content: '⚠️ Nie znaleziono ticketu.', ephemeral: true });
                if (isUnblock) {
                    await dbModels.User.updateOne({ username: t.username }, { $set: { accountBlocked: false, blockedUntil: null } });
                    await interaction.update({ content: `🔓 Account **${t.username}** has been unblocked by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
                } else {
                    await interaction.update({ content: `🔒 The block on **${t.username}** stays (decision by <@${interaction.user.id}>).`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
                }
            } catch (err) {
                console.error('[blokada] przycisk:', err.message);
                if (!interaction.replied && !interaction.deferred) interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
            }
        });

        // ===================== TICKETY ZE STRONY =====================
        // przyciski "Rozwiązano" i "Przywróć" (tylko właściciel i administracja)
        client.on('interactionCreate', async interaction => {
            if (!interaction.isButton()) return;
            const cid = interaction.customId || '';
            const isResolve = cid.startsWith('ticket_resolve_');
            const isRestore = cid.startsWith('ticket_restore_');
            if (!isResolve && !isRestore) return;
            if (!canManageTickets(interaction)) return interaction.reply({ content: '❌ Only the staff can click this.', ephemeral: true }).catch(() => {});
            const ticketId = cid.slice('ticket_resolve_'.length);
            try {
                if (isResolve) {
                    const deleteAt = new Date(Date.now() + TICKET_DELETE_AFTER_MS);
                    const t = await dbModels.Ticket.findOneAndUpdate(
                        { _id: ticketId, status: 'open' },
                        { $set: { status: 'resolved', resolvedBy: interaction.user.id, resolvedAt: new Date(), deleteAt } },
                        { new: true }
                    );
                    if (!t) return interaction.reply({ content: '⚠️ Ten ticket jest już rozwiązany.', ephemeral: true });
                    await interaction.update({ components: [] }).catch(() => {});
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`ticket_restore_${t._id}`).setLabel('♻️ Reopen').setStyle(ButtonStyle.Secondary)
                    );
                    await interaction.channel.send({
                        content: `✅ Ticket resolved by <@${interaction.user.id}>.\n🗑️ This channel will be deleted <t:${Math.floor(deleteAt.getTime() / 1000)}:R> (at <t:${Math.floor(deleteAt.getTime() / 1000)}:t>).`,
                        components: [row],
                        allowedMentions: { parse: [] }
                    });
                } else {
                    const t = await dbModels.Ticket.findOneAndUpdate(
                        { _id: ticketId, status: 'resolved' },
                        { $set: { status: 'open', resolvedBy: '', resolvedAt: null, deleteAt: null } },
                        { new: true }
                    );
                    if (!t) return interaction.reply({ content: '⚠️ Tego ticketu nie da się już przywrócić.', ephemeral: true });
                    await interaction.update({ content: `${interaction.message.content}\n♻️ Reopened by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
                    await interaction.channel.send({
                        content: `♻️ Ticket reopened. This channel won't be deleted.`,
                        components: [ticketResolveRow(t._id)],
                        allowedMentions: { parse: [] }
                    });
                }
            } catch (err) {
                console.error('[tickety] przycisk:', err.message);
                if (!interaction.replied && !interaction.deferred) interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
            }
        });

        // ręcznie usunięty kanał = ticket zamknięty (żeby nie blokował limitu gracza)
        client.on('channelDelete', channel => {
            dbModels.Ticket.updateMany({ channelId: channel.id, status: { $in: ['open', 'resolved'] } }, { $set: { status: 'deleted' } }).catch(() => {});
        });

        // co minutę: usuwamy kanały rozwiązanych ticketów, którym minęła godzina (termin jest w bazie, więc restart serwera go nie gubi)
        setInterval(async () => {
            try {
                const due = await dbModels.Ticket.find({ status: 'resolved', deleteAt: { $lte: new Date() } }).limit(20);
                for (const t of due) {
                    const claimed = await dbModels.Ticket.findOneAndUpdate({ _id: t._id, status: 'resolved' }, { $set: { status: 'deleted' } });
                    if (!claimed) continue;
                    try {
                        const ch = t.channelId ? await client.channels.fetch(t.channelId).catch(e => { if (e && e.code === 10003) return null; throw e; }) : null;
                        if (ch) await ch.delete('Ticket rozwiązany godzinę temu');
                    } catch (e) {
                        console.error('[tickety] usuwanie kanału:', e.message);
                        await dbModels.Ticket.updateOne({ _id: t._id }, { $set: { status: 'resolved', deleteAt: new Date(Date.now() + 10 * 60 * 1000) } }).catch(() => {});
                    }
                }
            } catch (e) { console.error('[tickety] sprzątanie:', e.message); }
        }, 60 * 1000);

        // --- OBSŁUGA GUZIKÓW I MODALI ---
        client.on('interactionCreate', async interaction => {

            // 1. Kliknięcie w przycisk Giveaway
            if (interaction.isButton() && interaction.customId.startsWith('join_gw_')) {
                const giveawayId = interaction.customId.replace('join_gw_', '');
                if (!activeGiveaways.has(giveawayId)) {
                    return interaction.reply({ content: "❌ This giveaway has already ended.", ephemeral: true });
                }

                const modal = new ModalBuilder().setCustomId(`modal_gw_${giveawayId}`).setTitle('Join the giveaway');
                const input = new TextInputBuilder()
                    .setCustomId('gw_nick')
                    .setLabel("Your RBX Rewards username")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            // 2. Kliknięcie w zatwierdzenie/odrzucenie wypłaty
            if (interaction.isButton() && interaction.customId.startsWith('payout_')) {
                // Zabezpieczenie przed klikaniem przez graczy
                if (!interaction.member.permissions.has('Administrator') && interaction.user.id !== ADMIN_DISCORD_ID) {
                    return interaction.reply({ content: "❌ Brak uprawnień!", ephemeral: true });
                }

                const parts = interaction.customId.split('_');
                const action = parts[1]; // 'approve' lub 'reject'
                const payoutId = parts[2];
                if (action !== 'approve' && action !== 'reject') return;

                // atomowo: tylko jedno kliknięcie może przetworzyć wypłatę oczekującą
                let payout = null;
                try {
                    payout = await dbModels.Payout.findOneAndUpdate(
                        { _id: payoutId, status: 'Pending Manual' },
                        { $set: { status: action === 'approve' ? 'Completed' : 'Rejected', resolvedAt: new Date() } },
                        { new: true }
                    );
                } catch (err) {
                    console.error('[wypłaty] discord (status):', err.message);
                    return interaction.reply({ content: "Błąd bazy danych.", ephemeral: true }).catch(() => {});
                }
                if (!payout) return interaction.reply({ content: "⚠️ Ta wypłata została już przetworzona!", ephemeral: true });

                const embed = interaction.message.embeds[0];

                if (action === 'reject') {
                    // zwrot punktów graczowi; gdy się nie uda, wypłata wraca do oczekujących
                    try {
                        const refunded = await dbModels.User.findOneAndUpdate({ username: payout.username }, { $inc: { points: payout.pointsWithdrawn } });
                        if (!refunded) throw new Error('nie znaleziono gracza ' + payout.username);
                    } catch (err) {
                        console.error('[wypłaty] discord (zwrot):', err.message);
                        await dbModels.Payout.updateOne({ _id: payoutId }, { $set: { status: 'Pending Manual', resolvedAt: null } }).catch(() => {});
                        return interaction.reply({ content: "❌ Nie udało się zwrócić R$, więc wypłata wróciła do oczekujących. Spróbuj ponownie.", ephemeral: true }).catch(() => {});
                    }
                    try { await interaction.update({ embeds: [{ ...embed.data, title: "❌ ODRZUCONE ZLECENIE", color: 0xff3333 }], components: [] }); } catch (e) {}
                    await notify(payout.username, 'payout_rejected', { points: payout.pointsWithdrawn, usd: payout.usdAmount });
                    return;
                }

                // approve: publiczne powiadomienie + zielona wiadomość admina
                try {
                    const publicChannel = client.channels.cache.get(KANAL_PUBLICZNY_ID);
                    if (publicChannel) {
                        publicChannel.send({
                            embeds: [{
                                title: "💸 PAYOUT SENT!",
                                description: `👤 **${payout.username}** just got paid for **${payout.pointsWithdrawn} R$**!`,
                                color: 0x00FFAA,
                                thumbnail: { url: "https://rbx-rewards.pl/logo.png" }
                            }]
                        });
                    }
                } catch (e) {}
                try { await interaction.update({ embeds: [{ ...embed.data, title: "✅ OPŁACONE ZLECENIE", color: 0x00FFAA }], components: [] }); } catch (e) {}
                await notify(payout.username, 'payout_done', { points: payout.pointsWithdrawn, usd: payout.usdAmount });
                return;
            }

            // 2b. Pakiety: Done / Reject
            if (interaction.isButton() && interaction.customId.startsWith('bundle_')) {
                if (!interaction.member.permissions.has('Administrator') && interaction.user.id !== ADMIN_DISCORD_ID) {
                    return interaction.reply({ content: "❌ Brak uprawnień!", ephemeral: true });
                }

                const parts = interaction.customId.split('_');
                const action = parts[1]; // 'done' lub 'reject'
                const bundleId = parts[2];
                if (action !== 'done' && action !== 'reject') return;

                let bundle = null;
                try {
                    // atomowo: tylko jeden admin może przetworzyć pakiet w statusie "paid"
                    bundle = await dbModels.Bundle.findOneAndUpdate(
                        { _id: bundleId, status: 'paid' },
                        { $set: { status: action === 'done' ? 'done' : 'rejected', doneAt: new Date() } },
                        { new: true }
                    );
                } catch (err) {
                    console.error('[bundles] discord (status):', err.message);
                    return interaction.reply({ content: "Błąd bazy danych.", ephemeral: true }).catch(() => {});
                }
                if (!bundle) return interaction.reply({ content: "⚠️ Ten pakiet został już przetworzony!", ephemeral: true });

                const label = `${BUNDLE_CAT_LABELS[bundle.category] || bundle.category} – ${bundle.title}`;
                const embed = interaction.message.embeds[0];

                if (action === 'reject') {
                    try {
                        const refund = bundle.depositedC / 100;
                        const refunded = await dbModels.User.findOneAndUpdate({ username: bundle.username }, { $inc: { points: refund } });
                        if (!refunded) throw new Error('nie znaleziono gracza');
                        try { await new dbModels.Earning({ username: bundle.username, amount: refund, source: 'BundleRejected', details: label }).save(); }
                        catch (e) { console.error('[bundles] discord (historia zwrotu):', e.message); }
                    } catch (err) {
                        console.error('[bundles] discord (zwrot):', err.message);
                        await dbModels.Bundle.updateOne({ _id: bundleId }, { $set: { status: 'paid' } }).catch(() => {});
                        return interaction.reply({ content: "❌ Nie udało się zwrócić R$ — pakiet wrócił do statusu 'opłacony', spróbuj ponownie.", ephemeral: true }).catch(() => {});
                    }
                    try { await interaction.update({ embeds: [{ ...embed.data, title: "❌ PAKIET ODRZUCONY (zwrot R$)", color: 0xff3333 }], components: [] }); } catch (e) {}
                    await notify(bundle.username, 'bundle_rejected', { category: bundle.category, title: bundle.title });
                    return;
                }

                // done
                try { await new dbModels.Earning({ username: bundle.username, amount: 0, source: 'BundleDone', details: label }).save(); }
                catch (e) { console.error('[bundles] discord (historia realizacji):', e.message); }
                try {
                    const publicChannel = client.channels.cache.get(KANAL_PUBLICZNY_ID);
                    if (publicChannel) {
                        publicChannel.send({
                            embeds: [{
                                title: "📦 BUNDLE DELIVERED!",
                                description: `👤 **${bundle.username}** just got the **${label}** bundle!`,
                                color: 0x00FFAA,
                                thumbnail: { url: "https://rbx-rewards.onrender.com/logo.png" }
                            }]
                        });
                    }
                } catch (e) {}
                try { await interaction.update({ embeds: [{ ...embed.data, title: "✅ PAKIET ZREALIZOWANY", color: 0x00FFAA }], components: [] }); } catch (e) {}
                await notify(bundle.username, 'bundle_done', { category: bundle.category, title: bundle.title });
                return;
            }

            // --- ODBIÓR DANYCH Z MODALI (WYSKAKUJĄCYĄ OKIENEK) ---
            if (interaction.type === InteractionType.ModalSubmit) {
                // Odpowiedź na Giveaway
                if (interaction.customId.startsWith('modal_gw_')) {
                    const giveawayId = interaction.customId.replace('modal_gw_', '');
                    const nick = interaction.fields.getTextInputValue('gw_nick');
                    
                    const gwData = activeGiveaways.get(giveawayId);
                    if (gwData) {
                        if (gwData.participants.includes(nick)) {
                            return interaction.reply({ content: "⚠️ Your username is already in the draw!", ephemeral: true });
                        }
                        gwData.participants.push(nick);
                        return interaction.reply({ content: "✅ You've joined the draw! Fingers crossed.", ephemeral: true });
                    } else {
                        return interaction.reply({ content: "❌ This giveaway has already ended.", ephemeral: true });
                    }
                }

            }
        });
    },

    // Funkcja wywoływana z server.js gdy wpadnie nowe zlecenie
    sendPayoutAlert: async (payoutData) => {
        const zleceniaChannel = client.channels.cache.get(KANAL_ZLECENIA_ID);
        if (!zleceniaChannel) return;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`payout_approve_${payoutData._id}`).setLabel('✅ ZATWIERDŹ').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`payout_reject_${payoutData._id}`).setLabel('❌ ODRZUĆ (Zwrot R$)').setStyle(ButtonStyle.Danger)
        );

        await zleceniaChannel.send({
            embeds: [{
                title: "⚠️ NOWE ZLECENIE DO OPŁACENIA",
                description: `**Gracz:** ${payoutData.username}\n**Revtag Revolut:** \`${payoutData.payoutAddress || payoutData.paypalEmail}\`\n\n💰 **Zlecone Robuxy:** ${payoutData.pointsWithdrawn} R$\n💵 **Do przelewu (USD):** **$${payoutData.usdAmount.toFixed(2)}**\n\n*Po ręcznym wysłaniu kasy przez Revolut (na ten Revtag), kliknij zatwierdź.*`,
                color: 0xFF9900
            }],
            components: [row]
        });
    },

    // Funkcja wywoływana z server.js gdy pakiet zostanie w pełni opłacony
    sendBundleAlert: async (bundle, user) => {
        const isWt = bundle.category === 'wt';
        const channelId = bundle.category === 'ss' ? KANAL_PAKIETY_SS_ID : (isWt ? KANAL_PAKIETY_WT_ID : KANAL_PAKIETY_ROBUX_ID);
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (!channel) { console.error('[bundles] brak dostępu do kanału pakietów:', channelId); return; }

        const lines = [
            `**Gracz (strona):** \`${bundle.username}\``,
            bundle.category === 'ss' ? '🐴 **Star Stable:** wystarczy nazwa Discord, kod karty wyślij graczowi w wiadomości prywatnej' : (isWt ? `**ID Gaijin:** \`${bundle.gameId}\`` : `**Nick Roblox:** \`${bundle.gameId}\``),
            `**Discord:** \`${bundle.discord}\``,
            `**Weryfikacja:** ${user && user.verified ? '✅ zweryfikowany' : '⚠️ NIEZWERYFIKOWANY (sprawdź opis profilu Roblox)'}`,
            '',
            `📦 **Pakiet:** ${BUNDLE_CAT_LABELS[bundle.category] || bundle.category} – **${bundle.title}**`,
            `💰 **Opłacono:** ${bundle.priceC / 100} R$`
        ];
        if (bundle.customUsd > 0) lines.push(`💵 **Custom:** $${bundle.customUsd} ≈ ${bundle.approxRobux} Robux (szacunek)`);
        lines.push('', '*Po wysłaniu pakietu kliknij ZREALIZOWANY. Odrzucenie zwraca R$ graczowi.*');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bundle_done_${bundle._id}`).setLabel('✅ ZREALIZOWANY').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`bundle_reject_${bundle._id}`).setLabel('❌ ODRZUĆ (Zwrot R$)').setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            embeds: [{ title: `⚠️ NOWY PAKIET: ${bundle.category === 'ss' ? 'STAR STABLE' : (isWt ? 'WAR THUNDER' : 'ROBUX')}`, description: lines.join('\n'), color: 0xFF9900 }],
            components: [row]
        });
    },

    // ===================== TICKETY: funkcje dla server.js =====================
    GUILD_ID,

    // true = jest na serwerze, false = nie ma, null = nie da się sprawdzić (bot niegotowy / błąd)
    isGuildMember: async (discordId) => {
        if (!client || !client.isReady || !client.isReady()) return null;
        try {
            const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            await guild.members.fetch({ user: String(discordId), force: true });
            return true;
        } catch (e) {
            if (e && (e.code === 10007 || e.code === 10013)) return false; // Unknown Member / Unknown User
            console.error('[tickety] sprawdzanie członka:', e.message);
            return null;
        }
    },

    // tworzy prywatny kanał ticketu i wysyła na nim zgłoszenie z przyciskiem "Rozwiązano"
    createTicketChannel: async (ticket) => {
        if (!client || !client.isReady || !client.isReady()) throw new Error('bot niegotowy');
        const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
        const nick = String(ticket.username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'player';
        const name = `ticket${String(ticket.number).padStart(4, '0')}-${nick}`.slice(0, 100);
        const P = PermissionFlagsBits;
        const channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: TICKET_CATEGORY_ID,
            topic: `RBX Rewards website ticket • player: ${ticket.username}`,
            reason: 'Nowy ticket ze strony',
            permissionOverwrites: [
                { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
                { id: client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.ManageChannels] },
                ...TICKET_ROLE_IDS.map(id => ({ id, type: OverwriteType.Role, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles] })),
                { id: String(ticket.discordId), type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] }
            ]
        });
        try {
            await channel.send({
                content: `**User** <@${ticket.discordId}> / **${ticket.username}**\n**Message:** ${ticket.message}`,
                components: [ticketResolveRow(ticket._id)],
                allowedMentions: { users: [String(ticket.discordId)] }
            });
        } catch (e) {
            await channel.delete('Nie udało się wysłać zgłoszenia').catch(() => {});
            throw e;
        }
        // ticket zablokowanego gracza: decyzja o blokadzie (klika tylko właściciel)
        if (ticket.blockAppeal) {
            try {
                const u = await dbModels.User.findOne({ username: ticket.username }).select('blockedUntil').lean();
                const until = u && u.blockedUntil ? `until <t:${Math.floor(new Date(u.blockedUntil).getTime() / 1000)}:f>` : '**permanently**';
                await channel.send({
                    content: `🔒 This player's **account is blocked** ${until}.
The owner will decide:`,
                    components: [blockDecisionRow(ticket._id)],
                    allowedMentions: { parse: [] }
                });
            } catch (e) { console.error('[blokada] wiadomość w tickecie:', e.message); }
        }
        return channel;
    }
};

function blockDecisionRow(ticketId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`blockkeep_${ticketId}`).setLabel('🔒 Keep block').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`blockunblock_${ticketId}`).setLabel('🔓 Unblock').setStyle(ButtonStyle.Success)
    );
}

function plDateTime(date) {
    return new Date(date).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ticketResolveRow(ticketId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_resolve_${ticketId}`).setLabel('✅ Resolved').setStyle(ButtonStyle.Success)
    );
}

function canManageTickets(interaction) {
    if (interaction.user && interaction.user.id === ADMIN_DISCORD_ID) return true;
    const roles = interaction.member && interaction.member.roles;
    if (!roles) return false;
    if (roles.cache) return TICKET_ROLE_IDS.some(id => roles.cache.has(id));
    if (Array.isArray(roles)) return TICKET_ROLE_IDS.some(id => roles.includes(id));
    return false;
}

function plTime(date) {
    return new Date(date).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
}
