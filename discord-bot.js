const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType } = require('discord.js');

// Twoje kanały
const KANAL_PUBLICZNY_ID = "1547480985506029639";
const KANAL_ADMIN_ID = "1548618275083264060";
const KANAL_ZLECENIA_ID = "1548683873012162601";
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
            
            // Tutaj masz stare komendy od kodów promocyjnych...
            if (cmd === '!kod') {
                if (args.length !== 4) return message.reply('⚠️ Użycie: `!kod <NAZWA> <PUNKTY> <MAX_OSÓB>`');
                const codeName = args[1].toUpperCase(); const reward = parseFloat(args[2]); const maxUses = parseInt(args[3]);
                try {
                    let existing = await dbModels.PromoCode.findOne({ code: codeName });
                    if (existing) {
                        existing.reward = reward; existing.maxUses = maxUses; existing.currentUses = 0; existing.usedBy = []; 
                        await existing.save();
                        return message.reply(`♻️ **Kod odnowiony!** ${codeName} - ${reward} R$ (${maxUses} użyć).`);
                    }
                    await new dbModels.PromoCode({ code: codeName, reward: reward, maxUses: maxUses }).save();
                    message.reply(`✅ **Kod utworzony!** ${codeName} - ${reward} R$ (${maxUses} użyć).`);
                } catch (err) {}
            }
        });

        // --- OBSŁUGA GUZIKÓW I MODALI ---
        client.on('interactionCreate', async interaction => {
            
            // 1. Kliknięcie w guzik "Dołącz do Giveawaya"
            if (interaction.isButton() && interaction.customId.startsWith('join_gw_')) {
                const giveawayId = interaction.customId.replace('join_gw_', '');
                
                const modal = new ModalBuilder().setCustomId(`modal_gw_${giveawayId}`).setTitle('Dołącz do Giveawaya');
                const input = new TextInputBuilder()
                    .setCustomId('gw_nick')
                    .setLabel("Podaj swój DOKŁADNY nick ze strony")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                await interaction.showModal(modal);
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
                    const payout = await dbModels.Payout.findById(payoutId);
                    if (!payout || payout.status !== 'Pending Manual') {
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

            // --- ODBIÓR DANYCH Z MODALI (WYSKAKUJĄCYCH OKIENEK) ---
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