const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, ChannelType } = require('discord.js');

// Twoje kanały
const KANAL_PUBLICZNY_ID = "1566002632848449616";
const KANAL_ADMIN_ID = "1548618275083264060";
const KANAL_ZLECENIA_ID = "1548683873012162601";
const KANAL_PAKIETY_ROBUX_ID = "1565989968050913310";
const KANAL_PAKIETY_WT_ID = "1566002493966516354";
const BUNDLE_CAT_LABELS = { robux: 'Robux', wt: 'War Thunder' };
const ADMIN_DISCORD_ID = "398911896893521921";

let client;
let dbModels;

// Słownik aktywnych giveawayów w pamięci RAM
const activeGiveaways = new Map();

module.exports = {
    init: (discordClient, models) => {
        client = discordClient;
        dbModels = models;

        client.on('messageCreate', async message => {
            if (message.author.bot) return;
            const args = message.content.split(' ');
            const cmd = args[0].toLowerCase();

            // Tylko ty możesz odpalać te komendy
            if (['!kod', '!kody', '!usunkod', '!giveaway'].includes(cmd) && message.author.id !== ADMIN_DISCORD_ID) {
                return message.reply('❌ Brak uprawnień, Szefie!');
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
                    title: "🎉 NOWY GIVEAWAY! 🎉",
                    description: `Do wygrania: **${robuxReward} R$** bezpośrednio na Twoje konto na stronie!\n\n⏳ **Czas:** ${minutes} minut\n👇 Kliknij przycisk poniżej, wpisz swój nick ze strony i dołącz do losowania!`,
                    color: 0x00e676,
                    footer: { text: "Losowanie automatyczne" }
                };

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`join_gw_${giveawayId}`).setLabel('🎟️ Dołącz do losowania').setStyle(ButtonStyle.Success)
                );

                const gwMsg = await message.channel.send({ embeds: [embed], components: [row] });

                // Odliczanie i losowanie
                setTimeout(async () => {
                    const gwData = activeGiveaways.get(giveawayId);
                    if (!gwData || gwData.participants.length === 0) {
                        gwMsg.edit({ embeds: [{ title: "❌ Giveaway zakończony", description: "Nikt nie wziął udziału :(", color: 0xff3333 }], components: [] });
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

                    gwMsg.edit({ embeds: [{ title: "🎉 GIVEAWAY ZAKOŃCZONY!", description: `Wygrywa: **${winnerNick}**!\n💰 **${robuxReward} R$** zostało automatycznie dodane do Twojego konta na stronie!`, color: 0xffb703 }], components: [] });
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
                new ButtonBuilder().setCustomId('idea_new').setLabel('💡 Podziel się pomysłem').setStyle(ButtonStyle.Success)
            );
            return channel.send({
                embeds: [{
                    title: "💡 Masz pomysł na RBX Rewards?",
                    description: "Kliknij przycisk poniżej, a otworzę dla Ciebie **prywatny wątek** (widzisz go tylko Ty i administracja). Napisz tam swój pomysł, a pojawi się na tym kanale do głosowania ✅ / ❌.\n\nNa tym kanale nie można pisać, a pomysły dodajesz tylko przyciskiem.",
                    color: 0x00e676
                }],
                components: [row]
            });
        }

        client.on('messageCreate', async message => {
            if (message.author.bot) return;

            // komenda admina: wysyła (lub odświeża) panel z przyciskiem
            if (message.content.trim().toLowerCase() === '!pomysly') {
                if (message.author.id !== ADMIN_DISCORD_ID) return message.reply('❌ Brak uprawnień, Szefie!');
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
            if (text.length < IDEA_MIN) return ch.send(`✏️ Pomysł jest za krótki (min. ${IDEA_MIN} znaków). Opisz go dokładniej i wyślij jeszcze raz.`);
            if (text.length > IDEA_MAX) return ch.send(`✂️ Pomysł jest za długi (${text.length}/${IDEA_MAX} znaków). Skróć go i wyślij jeszcze raz.`);

            ideaPublishing.add(ch.id);
            try {
                const ideasChannel = client.channels.cache.get(KANAL_POMYSLY_ID) || await client.channels.fetch(KANAL_POMYSLY_ID);
                const files = [...message.attachments.values()]
                    .filter(a => (a.contentType || '').startsWith('image/') && a.size <= 8 * 1024 * 1024)
                    .slice(0, 3).map(a => ({ attachment: a.url, name: a.name }));
                const sent = await ideasChannel.send({
                    embeds: [{
                        title: "💡 NOWY POMYSŁ",
                        description: `<@${message.author.id}>\n\n${text}`,
                        color: 0xffb703,
                        timestamp: new Date().toISOString(),
                        footer: { text: "Zagłosuj reakcją: ✅ chcę to na stronie, ❌ nie chcę" }
                    }],
                    files,
                    allowedMentions: { parse: [] }
                });
                await sent.react('✅');
                await sent.react('❌');

                ideaLastPublish.set(message.author.id, Date.now());
                ideaThreads.delete(message.author.id);
                await ch.send('🎉 Dziękujemy! Twój pomysł jest już na kanale do głosowania. Ten wątek za chwilę zniknie.');
                setTimeout(() => { ch.delete().catch(() => ch.setArchived(true).catch(() => {})); }, 6000);
                await refreshIdeaPanel();
            } catch (err) {
                console.error('[pomysły] publikacja:', err.message);
                ideaPublishing.delete(ch.id);
                ch.send('❌ Nie udało się opublikować pomysłu. Spróbuj jeszcze raz, a jeśli nadal nie działa, napisz do administracji.').catch(() => {});
            }
        });

        client.on('interactionCreate', async interaction => {
            if (!interaction.isButton() || interaction.customId !== 'idea_new') return;
            const userId = interaction.user.id;

            const wait = IDEA_COOLDOWN_MS - (Date.now() - (ideaLastPublish.get(userId) || 0));
            if (wait > 0) return interaction.reply({ content: `⏳ Kolejny pomysł możesz dodać za ${Math.ceil(wait / 60000)} min.`, ephemeral: true });

            const existingId = ideaThreads.get(userId);
            if (existingId) {
                const t = await client.channels.fetch(existingId).catch(() => null);
                if (t) {
                    if (t.archived) await t.setArchived(false).catch(() => {});
                    return interaction.reply({ content: `📝 Masz już otwarty wątek na pomysł: <#${t.id}>`, ephemeral: true });
                }
                ideaThreads.delete(userId);
            }

            await interaction.deferReply({ ephemeral: true });
            try {
                const parent = interaction.channel;
                if (!parent || parent.id !== KANAL_POMYSLY_ID) return interaction.editReply('❌ Ten przycisk działa tylko na kanale pomysłów.');
                const rawName = (interaction.member && interaction.member.displayName) || interaction.user.username;
                const safeName = rawName.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'gracz';
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
                        title: "💡 Napisz swój pomysł",
                        description: `Opisz go w **jednej wiadomości** (od ${IDEA_MIN} do ${IDEA_MAX} znaków). Możesz dołączyć do 3 zrzutów ekranu.\n\nPo wysłaniu pomysł pojawi się na kanale do głosowania, a ten wątek zniknie. Ten wątek widzisz tylko Ty i administracja.\n\n*Pomysły niezgodne z regulaminem (spam, wulgaryzmy) będą usuwane.*`,
                        color: 0xffb703
                    }]
                });
                return interaction.editReply(`✅ Otworzyłem prywatny wątek tylko dla Ciebie i administracji: <#${thread.id}>`);
            } catch (err) {
                console.error('[pomysły] tworzenie wątku:', err.message);
                return interaction.editReply('❌ Nie udało się otworzyć wątku. Napisz do administracji.').catch(() => {});
            }
        });

        // --- OBSŁUGA GUZIKÓW I MODALI ---
        client.on('interactionCreate', async interaction => {

            // 1. Kliknięcie w przycisk Giveaway
            if (interaction.isButton() && interaction.customId.startsWith('join_gw_')) {
                const giveawayId = interaction.customId.replace('join_gw_', '');
                if (!activeGiveaways.has(giveawayId)) {
                    return interaction.reply({ content: "❌ Ten giveaway już się zakończył.", ephemeral: true });
                }

                const modal = new ModalBuilder().setCustomId(`modal_gw_${giveawayId}`).setTitle('Dołącz do Giveaway');
                const input = new TextInputBuilder()
                    .setCustomId('gw_nick')
                    .setLabel("Twój nick ze strony RBX Rewards")
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

                try {
                    const payout = await dbModels.Payout.findOneAndUpdate({ _id: payoutId, status: 'Pending Manual' }, { $set: { status: action === 'approve' ? 'Completed' : 'Rejected' } }, { new: true });
                    if (!payout) {
                        return interaction.reply({ content: "⚠️ Ta wypłata została już przetworzona!", ephemeral: true });
                    }

                    if (action === 'approve') {
                        payout.status = 'Completed';
                        await payout.save();

                        // Wysłanie publicznego powiadomienia
                        const publicChannel = client.channels.cache.get(KANAL_PUBLICZNY_ID);
                        if (publicChannel) {
                            publicChannel.send({
                                embeds: [{
                                    title: "💸 WYPŁATA ZREALIZOWANA!",
                                    description: `👤 Gracz: **${payout.username}** właśnie otrzymał przelew za **${payout.pointsWithdrawn} R$**!`,
                                    color: 0x00FFAA,
                                    thumbnail: { url: "https://rbx-rewards.onrender.com/logo.png" }
                                }]
                            });
                        }

                        // Edycja wiadomości admina na zieloną
                        const embed = interaction.message.embeds[0];
                        await interaction.update({
                            embeds: [{ ...embed.data, title: "✅ OPŁACONE ZLECENIE", color: 0x00FFAA }],
                            components: [] // Usunięcie guzików
                        });
                    }

                    if (action === 'reject') {
                        payout.status = 'Rejected';
                        await payout.save();

                        // Zwrócenie punktów graczowi
                        const user = await dbModels.User.findOne({ username: payout.username });
                        if (user) {
                            user.points += payout.pointsWithdrawn;
                            await user.save();
                        }

                        // Edycja wiadomości admina na czerwoną
                        const embed = interaction.message.embeds[0];
                        await interaction.update({
                            embeds: [{ ...embed.data, title: "❌ ODRZUCONE ZLECENIE", color: 0xff3333 }],
                            components: []
                        });
                    }
                } catch (err) { interaction.reply({ content: "Błąd bazy danych.", ephemeral: true }); }
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
                                title: "📦 PAKIET ZREALIZOWANY!",
                                description: `👤 **${bundle.username}** kupił pakiet **${label}**!`,
                                color: 0x00FFAA,
                                thumbnail: { url: "https://rbx-rewards.onrender.com/logo.png" }
                            }]
                        });
                    }
                } catch (e) {}
                try { await interaction.update({ embeds: [{ ...embed.data, title: "✅ PAKIET ZREALIZOWANY", color: 0x00FFAA }], components: [] }); } catch (e) {}
                return;
            }

            // 3. Kliknięcie w odpowiedź na Support
            if (interaction.isButton() && interaction.customId.startsWith('reply_ticket_')) {
                const targetUser = interaction.customId.replace('reply_ticket_', '');
                
                const modal = new ModalBuilder().setCustomId(`modal_reply_${targetUser}`).setTitle('Odpowiedź dla Gracza');
                const input = new TextInputBuilder()
                    .setCustomId('reply_text')
                    .setLabel("Treść odpowiedzi (trafi prosto na stronę)")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
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
                            return interaction.reply({ content: "⚠️ Twój nick jest już w losowaniu!", ephemeral: true });
                        }
                        gwData.participants.push(nick);
                        return interaction.reply({ content: "✅ Pomyślnie dołączono do losowania! Trzymaj kciuki.", ephemeral: true });
                    } else {
                        return interaction.reply({ content: "❌ Ten giveaway już się zakończył.", ephemeral: true });
                    }
                }

                // Odpowiedź na Ticket
                if (interaction.customId.startsWith('modal_reply_')) {
                    const targetUser = interaction.customId.replace('modal_reply_', '');
                    const replyText = interaction.fields.getTextInputValue('reply_text');

                    try {
                        const user = await dbModels.User.findOne({ username: new RegExp(`^${targetUser}$`, 'i') });
                        if (user) {
                            user.inbox.push({ message: replyText, date: new Date() });
                            await user.save();
                            
                            // Edytujemy oryginalnego ticketa, żeby wiedzieć, że już mu odpisano
                            const embed = interaction.message.embeds[0];
                            await interaction.message.edit({
                                embeds: [{ ...embed.data, title: "✅ ROZWIĄZANY TICKET", color: 0x00e676 }],
                                components: [] // Usuwa guzik odpowiedzi
                            });

                            return interaction.reply({ content: `✅ Wysłano odpowiedź do ${targetUser}!`, ephemeral: true });
                        } else {
                            return interaction.reply({ content: `❌ Nie znaleziono użytkownika ${targetUser} w bazie!`, ephemeral: true });
                        }
                    } catch (err) { interaction.reply({ content: "Błąd.", ephemeral: true }); }
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
                description: `**Gracz:** ${payoutData.username}\n**Email PayPal:** \`${payoutData.paypalEmail}\`\n\n💰 **Zlecone Robuxy:** ${payoutData.pointsWithdrawn} R$\n💵 **Do przelewu (USD):** **$${payoutData.usdAmount.toFixed(2)}**\n\n*Po ręcznym wysłaniu kasy na PayPal, kliknij zatwierdź.*`,
                color: 0xFF9900
            }],
            components: [row]
        });
    },

    // Funkcja wywoływana z server.js gdy pakiet zostanie w pełni opłacony
    sendBundleAlert: async (bundle, user) => {
        const isWt = bundle.category === 'wt';
        const channelId = isWt ? KANAL_PAKIETY_WT_ID : KANAL_PAKIETY_ROBUX_ID;
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (!channel) { console.error('[bundles] brak dostępu do kanału pakietów:', channelId); return; }

        const lines = [
            `**Gracz (strona):** \`${bundle.username}\``,
            isWt ? `**ID Gaijin:** \`${bundle.gameId}\`` : `**Nick Roblox:** \`${bundle.gameId}\``,
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
            embeds: [{ title: `⚠️ NOWY PAKIET: ${isWt ? 'WAR THUNDER' : 'ROBUX'}`, description: lines.join('\n'), color: 0xFF9900 }],
            components: [row]
        });
    },

    // Funkcja wywoływana z server.js gdy wpadnie ticket
    sendTicketAlert: async (username, contact, message) => {
        const supportChannel = client.channels.cache.find(c => c.name === 'support-tickets');
        if (!supportChannel) return;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`reply_ticket_${username}`).setLabel('✉️ Odpowiedz Graczowi').setStyle(ButtonStyle.Primary)
        );

        await supportChannel.send({
            embeds: [{
                title: "🚨 NOWY TICKET",
                description: `👤 **Od:** \`${username}\`\n💬 **Kontakt Zew:** \`${contact || "Brak"}\`\n\n**Wiadomość:**\n> ${message}`,
                color: 0xff3333
            }],
            components: [row]
        });
    }
};