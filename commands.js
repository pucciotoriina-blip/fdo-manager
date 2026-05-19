const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./database');

const HIDE_PULISCI_FEDINA = process.env.HIDE_PULISCI_FEDINA === 'true';

function getGuildEnv(key, guildId) {
  if (!guildId) return process.env[key];
  // Prima prova la variante con l'ID del guild: VAR_<GUILDID>
  const byId = process.env[`${key}_${guildId}`];
  if (byId !== undefined) return byId;

  // Poi prova la variante numerica basata sull'ordine in GUILD_IDS: VAR_1, VAR_2, ...
  let guildsList = (process.env.GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (guildsList.length === 0) {
    guildsList = Object.keys(process.env)
      .filter(k => /^GUILD_ID_\d+$/.test(k))
      .map(k => ({ n: parseInt(k.split('_').pop(), 10), v: process.env[k] }))
      .sort((a, b) => a.n - b.n)
      .map(x => x.v.trim())
      .filter(Boolean);
  }
  const idx = guildsList.indexOf(String(guildId));
  if (idx !== -1) {
    const byIndex = process.env[`${key}_${idx + 1}`];
    if (byIndex !== undefined) return byIndex;
  }

  // Fallback alla variabile globale
  return process.env[key];
}

function hasRole(member, roleName) {
  if (!member) return false;
  return member.roles.cache.some(role => role.name === roleName || role.id === roleName);
}

async function sendToCartellinoChannel(interaction, embed) {
  const channelId = getGuildEnv('CARTELLINO_CHANNEL_ID', interaction.guildId);
  if (channelId) {
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      if (channel) {
        await channel.send({ embeds: [embed] });
      }
    } catch (error) {
      console.error('Errore nell\'invio al canale cartellini:', error);
    }
  }
}

function parseMentions(mentionString) {
  if (!mentionString) return [];
  // Estrae gli user ID dalle mention Discord format: <@USERID> o <@!USERID>
  const userIds = [];
  const matches = mentionString.match(/<@!?(\d+)>/g);
  if (matches) {
    matches.forEach(match => {
      const id = match.replace(/[<@!>]/g, '');
      if (id && !userIds.includes(id)) {
        userIds.push(id);
      }
    });
  }
  return userIds;
}

function calculateAge(dataNascitaStr) {
  // Parsa la data nel formato GG/MM/YYYY
  const [giorno, mese, anno] = dataNascitaStr.split('/').map(Number);
  const dataNascita = new Date(anno, mese - 1, giorno);
  const oggi = new Date();
  
  let anni = oggi.getFullYear() - dataNascita.getFullYear();
  let mesi = oggi.getMonth() - dataNascita.getMonth();
  
  if (oggi.getDate() < dataNascita.getDate()) {
    mesi -= 1;
  }
  if (mesi < 0) {
    anni -= 1;
    mesi += 12;
  }
  
  return { anni, mesi };
}

async function createInfoPersonaEmbed(persona) {
  const eta = calculateAge(persona.dataNascita);
  
  const embed = new EmbedBuilder()
    .setColor(persona.fedina === 'pulita' ? 0x00ff00 : 0xff0000)
    .setTitle(`👤 ${persona.nome} ${persona.cognome}`)
    .setDescription(`**Data di Nascita:** ${persona.dataNascita}\n**Età:** ${eta.anni} anni ${eta.mesi} mesi\n**Fedina:** ${persona.fedina === 'pulita' ? '✅ PULITA' : '🚨 SPORCA'}`)
    .setFields([
      { name: '\u200b', value: '\u200b' }
    ]);
  
  if (persona.arresti && persona.arresti.length > 0) {
    const arresti = await Promise.all(persona.arresti.map(async arrestId => {
      const arr = await db.getArresto(arrestId);
      if (!arr) return null;
      return `[ID: ${arrestId}] - ${arr.reati}\n📅 ${new Date(arr.data).toLocaleDateString('it-IT')}`;
    }));
    const validArresti = arresti.filter(a => a !== null);
    
    if (validArresti.length > 0) {
      embed.addFields({
        name: '🚔 Arresti',
        value: validArresti.join('\n\n'),
        inline: false
      });
    }
  }
  
  if (persona.macchineSequestrate && persona.macchineSequestrate.length > 0) {
    embed.addFields({
      name: '🚗 Macchine Sequestrate',
      value: persona.macchineSequestrate.map(m => `Targa: \`${m.targa}\``).join('\n'),
      inline: false
    });
  }
  
  if (persona.denuncie && persona.denuncie.length > 0) {
    const denuncie = await Promise.all(persona.denuncie.map(async denId => {
      const den = await db.getDenuncia(denId);
      if (!den) return null;
      return `[ID: ${denId}] - ${den.reati}`;
    }));
    const validDenuncie = denuncie.filter(d => d !== null);
    
    if (validDenuncie.length > 0) {
      embed.addFields({
        name: '📋 Denuncie',
        value: validDenuncie.join('\n'),
        inline: false
      });
    }
  }
  
  if (persona.multe && persona.multe.length > 0) {
    const multe = await Promise.all(persona.multe.map(async multaId => {
      const multa = await db.getMulta(multaId);
      if (!multa) return null;
      return `[ID: ${multaId}] - ${multa.reato}`;
    }));
    const validMulte = multe.filter(m => m !== null);
    
    if (validMulte.length > 0) {
      embed.addFields({
        name: '💰 Multe',
        value: validMulte.join('\n'),
        inline: false
      });
    }
  }
  
  if (persona.pda) {
    const pdaInfo = await db.getPda(persona.pda);
    if (pdaInfo) {
      embed.addFields({
        name: '🔫 Porto d\'Armi (PDA)',
        value: `ID: \`${pdaInfo.id}\`\nMotivo: ${pdaInfo.motivo}\n📅 Scadenza: ${pdaInfo.dataScadenza}`,
        inline: false
      });
    }
  } else {
    embed.addFields({
      name: '🔫 Porto d\'Armi (PDA)',
      value: '❌ Non possiede PDA',
      inline: false
    });
  }
  
  return embed;
}

function canModifyRecord(interaction, record) {
  if (!record) return false;
  if (hasRole(interaction.member, STAFF_ROLE)) return true;
  if (Array.isArray(record.agenti) && record.agenti.includes(interaction.user.id)) return true;
  if (record.createdBy && record.createdBy === interaction.user.id) return true;
  return false;
}

const commands = {
  timbratura: {
    data: new SlashCommandBuilder()
      .setName('timbratura')
      .setDescription('Apre il cartellino di timbratura LSPD')
      .addUserOption(option => 
        option.setName('agente').setDescription('Agente (default: te stesso)').setRequired(false)
      ),
    execute: async (interaction) => {
      const agente = interaction.options.getUser('agente') || interaction.user;
      const agenteId = agente.id;
      
      if (agente.id !== interaction.user.id && !hasRole(interaction.member, STAFF_ROLE)) {
        return interaction.reply({ content: '❌ Solo lo staff può visualizzare i cartellini di altri agenti!', ephemeral: true });
      }
      
      let agenteData = await db.getAgente(agenteId);
      if (!agenteData) {
        await db.addAgente(agenteId, agente.username);
        agenteData = await db.getAgente(agenteId);
      }
      
      const statoServizio = agenteData.inServizio ? '🟢 In servizio' : '⚫ Fuori servizio';
      const inizioTurno = agenteData.timbraInizio ? new Date(agenteData.timbraInizio).toLocaleString('it-IT') : '—';

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`🚔 CARTELLINO LSPD - ${agenteData.nome}`)
        .setDescription('**CARTELLINO UFFICIALE LSPD**\nUsa i comandi qui sotto per gestire il tuo turno e consultare le statistiche del servizio.')
        .addFields([
          { name: '👮 Agente', value: agenteData.nome, inline: true },
          { name: '🆔 ID', value: `\`${agenteId}\``, inline: true },
          { name: '📌 Stato', value: statoServizio, inline: true },
          { name: '⏱️ Inizio Turno', value: `\`${inizioTurno}\``, inline: true },
          { name: '🕒 Ore Cartellino', value: `\`${agenteData.oreServizio.toFixed(2)}h\``, inline: true },
          { name: '📊 Ore Totali', value: `\`${agenteData.oreTotali.toFixed(2)}h\``, inline: true },
          { name: '🚔 Arresti', value: `\`${agenteData.arresti}\``, inline: true },
          { name: '💰 Multe', value: `\`${agenteData.multe}\``, inline: true },
          { name: '🚗 Sequestri', value: `\`${agenteData.sequestri}\``, inline: true },
          { name: '🔫 PDA Emessi', value: `\`${agenteData.pdaEmessi}\``, inline: true }
        ])
        .setFooter({ text: `ID: ${agenteId} • LSPD Cartellino` })
        .setTimestamp();
      
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`timbra_${agenteId}`)
            .setLabel('Timbra')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🟢'),
          new ButtonBuilder()
            .setCustomId(`stimbra_${agenteId}`)
            .setLabel('Stimbra')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔴'),
          new ButtonBuilder()
            .setCustomId(`stato_${agenteId}`)
            .setLabel('In Servizio')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📊'),
          new ButtonBuilder()
            .setCustomId(`info_${agenteId}`)
            .setLabel('Info')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📋')
        );
      
      // Invia il cartellino nel canale dedicato se configurato
      if (CARTELLINO_CHANNEL_ID) {
        try {
          const channel = await interaction.client.channels.fetch(CARTELLINO_CHANNEL_ID);
          if (channel) {
            await channel.send({ embeds: [embed], components: [row] });
            await interaction.reply({ content: `✅ Cartellino di ${agente.username} inviato al canale!`, ephemeral: true });
          }
        } catch (error) {
          console.error('Errore nell\'invio del cartellino:', error);
          await interaction.reply({ embeds: [embed], components: [row] });
        }
      } else {
        await interaction.reply({ embeds: [embed], components: [row] });
      }
    }
  },

  aggiungi_ore: {
    data: new SlashCommandBuilder()
      .setName('aggiungi_ore')
      .setDescription('[STAFF] Aggiungi ore a un agente')
      .addUserOption(option => option.setName('agente').setDescription('Agente').setRequired(true))
      .addNumberOption(option => option.setName('ore').setDescription('Numero di ore').setRequired(true)),
    execute: async (interaction) => {
      if (!hasRole(interaction.member, STAFF_ROLE)) {
        return interaction.reply({ content: '❌ Solo lo staff può usare questo comando!', ephemeral: true });
      }
      
      const agente = interaction.options.getUser('agente');
      const ore = interaction.options.getNumber('ore');
      
      let agenteData = await db.getAgente(agente.id);
      if (!agenteData) {
        await db.addAgente(agente.id, agente.username);
        agenteData = await db.getAgente(agente.id);
      }
      
      await db.updateAgente(agente.id, {
        oreServizio: agenteData.oreServizio + ore,
        oreTotali: agenteData.oreTotali + ore
      });
      
      await interaction.reply({ content: `✅ Aggiunte ${ore}h all'agente ${agente.username}`, ephemeral: true });
    }
  },

  togli_ore: {
    data: new SlashCommandBuilder()
      .setName('togli_ore')
      .setDescription('[STAFF] Togli ore a un agente')
      .addUserOption(option => option.setName('agente').setDescription('Agente').setRequired(true))
      .addNumberOption(option => option.setName('ore').setDescription('Numero di ore').setRequired(true)),
    execute: async (interaction) => {
      if (!hasRole(interaction.member, STAFF_ROLE)) {
        return interaction.reply({ content: '❌ Solo lo staff può usare questo comando!', ephemeral: true });
      }
      
      const agente = interaction.options.getUser('agente');
      const ore = interaction.options.getNumber('ore');
      
      let agenteData = await db.getAgente(agente.id);
      if (!agenteData) {
        await db.addAgente(agente.id, agente.username);
        agenteData = await db.getAgente(agente.id);
      }
      
      const nuoveOreServizio = Math.max(0, agenteData.oreServizio - ore);
      const nuoreOreTotali = Math.max(0, agenteData.oreTotali - ore);
      
      await db.updateAgente(agente.id, {
        oreServizio: nuoveOreServizio,
        oreTotali: nuoreOreTotali
      });
      
      await interaction.reply({ content: `✅ Tolte ${ore}h all'agente ${agente.username}`, ephemeral: true });
    }
  },

  forza_stop: {
    data: new SlashCommandBuilder()
      .setName('forza_stop')
      .setDescription('[STAFF] Forza stop del servizio di un agente')
      .addUserOption(option => option.setName('agente').setDescription('Agente').setRequired(true)),
    execute: async (interaction) => {
      if (!hasRole(interaction.member, STAFF_ROLE)) {
        return interaction.reply({ content: '❌ Solo lo staff può usare questo comando!', ephemeral: true });
      }
      
      const agente = interaction.options.getUser('agente');
      const agenteData = await db.getAgente(agente.id);
      
      if (!agenteData || !agenteData.inServizio) {
        return interaction.reply({ content: '⚠️ L\'agente non è in servizio!', ephemeral: true });
      }
      
      const inizio = new Date(agenteData.timbraInizio);
      const fine = new Date();
      const ore = (fine - inizio) / (1000 * 60 * 60);
      
      await db.updateAgente(agente.id, {
        inServizio: false,
        timbraInizio: null,
        oreServizio: agenteData.oreServizio + ore,
        oreTotali: agenteData.oreTotali + ore
      });
      
      await interaction.reply({ content: `✅ Servizio forzatamente terminato. Ore: ${ore.toFixed(2)}h`, ephemeral: true });
    }
  },

  info_agente: {
    data: new SlashCommandBuilder()
      .setName('info_agente')
      .setDescription('[STAFF] Visualizza info di un agente')
      .addUserOption(option => option.setName('agente').setDescription('Agente').setRequired(true)),
    execute: async (interaction) => {
      if (!hasRole(interaction.member, STAFF_ROLE)) {
        return interaction.reply({ content: '❌ Solo lo staff può usare questo comando!', ephemeral: true });
      }
      
      const agente = interaction.options.getUser('agente');
      let agenteData = await db.getAgente(agente.id);
      
      if (!agenteData) {
        await db.addAgente(agente.id, agente.username);
        agenteData = await db.getAgente(agente.id);
      }
      
      if (!agenteData) {
        return interaction.reply({ content: '⚠️ Agente non trovato!', ephemeral: true });
      }
      
      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`👮 ${agenteData.nome}`)
        .setFields([
          { name: 'Ore Cartellino', value: `\`${agenteData.oreServizio.toFixed(2)}h\``, inline: true },
          { name: 'Ore Totali', value: `\`${agenteData.oreTotali.toFixed(2)}h\``, inline: true },
          { name: 'Stato', value: agenteData.inServizio ? '🟢 In Servizio' : '⚫ Fuori Servizio', inline: true },
          { name: 'PDA Emessi', value: `\`${agenteData.pdaEmessi}\``, inline: true },
          { name: 'Arresti', value: `\`${agenteData.arresti}\``, inline: true },
          { name: 'Multe', value: `\`${agenteData.multe}\``, inline: true },
          { name: 'Sequestri', value: `\`${agenteData.sequestri}\``, inline: true }
        ])
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },

  arresto: {
    data: new SlashCommandBuilder()
      .setName('arresto')
      .setDescription('Registra un arresto')
      .addStringOption(option => option.setName('nome').setDescription('Nome arrestato').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome arrestato').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('reati').setDescription('Reati imputati').setRequired(true))
      .addNumberOption(option => option.setName('multa').setDescription('Importo multa').setRequired(true))
      .addStringOption(option => option.setName('oggetti_sequestrati').setDescription('Oggetti sequestrati').setRequired(true))
      .addStringOption(option => option.setName('oggetti_consegnati').setDescription('Oggetti consegnati').setRequired(true))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto arrestato').setRequired(true))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Registra la persona se non esiste nel database
      await db.addPersona(nome, cognome, dataNascita);
      let persona = await db.getPersona(nome, cognome, dataNascita);
      
      const reati = interaction.options.getString('reati');
      const multa = interaction.options.getNumber('multa');
      const oggettiSequestrati = interaction.options.getString('oggetti_sequestrati');
      const oggettiConsegnati = interaction.options.getString('oggetti_consegnati');
      const fotoAttachment = interaction.options.getAttachment('foto');
      const foto = fotoAttachment.url;
      
      const agentiString = interaction.options.getString('agenti') || '';
      const agentiMenzionati = parseMentions(agentiString).length > 0 ? parseMentions(agentiString) : [interaction.user.id];
      
      // Assicurati che tutti gli agenti siano nel database
      for (const agenteId of agentiMenzionati) {
        let agenteData = await db.getAgente(agenteId);
        if (!agenteData) {
          try {
            const user = await interaction.client.users.fetch(agenteId);
            await db.addAgente(agenteId, user.username);
          } catch (error) {
            console.error('Errore nel fetch dell\'utente:', error);
          }
        }
      }
      
      const arrestId = await db.addArresto(
        agentiMenzionati,
        nome,
        cognome,
        dataNascita,
        reati,
        multa,
        oggettiSequestrati,
        oggettiConsegnati,
        foto
      );
      
      const eta = calculateAge(dataNascita);
      const arrestDate = new Date();
      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle(`🚔 ARRESTO REGISTRATO`)
        .setDescription(`**Arrestato:** ${nome} ${cognome}\n**Data Arresto:** ${arrestDate.toLocaleDateString('it-IT')} • ${arrestDate.toLocaleTimeString('it-IT')}`)
        .setImage(foto)
        .setFields([
          { name: '🆔 ID Arresto', value: `\`${arrestId}\``, inline: true },
          { name: '📅 Nascita', value: `\`${dataNascita}\``, inline: true },
          { name: '🧬 Età', value: `\`${eta.anni} anni ${eta.mesi} mesi\``, inline: true },
          { name: '💰 Multa', value: `\`€${multa.toFixed(2)}\``, inline: true },
          { name: '⚖️ Reati', value: `\`\`\`${reati}\`\`\``, inline: false },
          { name: '🔒 Sequestrati', value: `\`\`\`${oggettiSequestrati}\`\`\``, inline: false },
          { name: '📦 Consegnati', value: `\`\`\`${oggettiConsegnati}\`\`\``, inline: false },
          { name: '👮 Agenti', value: agentiMenzionati.map((id, i) => `${i + 1}. <@${id}>`).join('\n'), inline: false },
          { name: '👤 Registrato da', value: `\`${interaction.user.username}\``, inline: true },
          { name: '⏰ Ora', value: `\`${arrestDate.toLocaleTimeString('it-IT')}\``, inline: true }
        ])
        .setFooter({ text: 'LSPD Arresto • Sistema di controllo' })
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  edit_arresto: {
    data: new SlashCommandBuilder()
      .setName('edit_arresto')
      .setDescription('Modifica un arresto')
      .addIntegerOption(option => option.setName('id').setDescription('ID dell\'arresto').setRequired(true))
      .addStringOption(option => option.setName('reati').setDescription('Reati').setRequired(false))
      .addNumberOption(option => option.setName('multa').setDescription('Multa').setRequired(false))
      .addStringOption(option => option.setName('oggetti_sequestrati').setDescription('Oggetti sequestrati').setRequired(false))
      .addStringOption(option => option.setName('oggetti_consegnati').setDescription('Oggetti consegnati').setRequired(false))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto arrestato').setRequired(false)),
    execute: async (interaction) => {
      const id = interaction.options.getInteger('id');
      const arresto = await db.getArresto(id);
      
      if (!arresto) {
        return interaction.reply({ content: '❌ Arresto non trovato!', ephemeral: true });
      }
      
      if (!canModifyRecord(interaction, arresto)) {
        return interaction.reply({ content: '❌ Solo chi ha effettuato l\'arresto o lo staff può modificarlo!', ephemeral: true });
      }
      
      const updates = {};
      if (interaction.options.getString('reati')) updates.reati = interaction.options.getString('reati');
      if (interaction.options.getNumber('multa') !== null) updates.multa = interaction.options.getNumber('multa');
      if (interaction.options.getString('oggetti_sequestrati')) updates.oggettiSequestrati = interaction.options.getString('oggetti_sequestrati');
      if (interaction.options.getString('oggetti_consegnati')) updates.oggettiConsegnati = interaction.options.getString('oggetti_consegnati');
      if (interaction.options.getString('agenti')) {
        const agentiString = interaction.options.getString('agenti') || '';
        const parsedAgenti = parseMentions(agentiString);
        if (parsedAgenti.length > 0) updates.agenti = parsedAgenti;
      }
      if (interaction.options.getAttachment('foto')) {
        const fotoAttachment = interaction.options.getAttachment('foto');
        updates.foto = fotoAttachment.url;
      }
      
      await db.editArresto(id, updates);
      
      await interaction.reply({ content: `✅ Arresto #${id} modificato con successo!`, ephemeral: true });
    }
  },

  rilascia_pda: {
    data: new SlashCommandBuilder()
      .setName('rilascia_pda')
      .setDescription('Rilascia un porto d\'armi (PDA)')
      .addStringOption(option => option.setName('nome').setDescription('Nome').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('motivo').setDescription('Motivo del rilascio').setRequired(true))
      .addStringOption(option => option.setName('data_scadenza').setDescription('Data scadenza (GG/MM/YYYY)').setRequired(true))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto').setRequired(true))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Registra la persona se non esiste nel database
      await db.addPersona(nome, cognome, dataNascita);
      let persona = await db.getPersona(nome, cognome, dataNascita);
      
      const motivo = interaction.options.getString('motivo');
      const dataScadenza = interaction.options.getString('data_scadenza');
      const fotoAttachment = interaction.options.getAttachment('foto');
      const foto = fotoAttachment.url;
      const agentiString = interaction.options.getString('agenti') || '';
      const agentiMenzionati = parseMentions(agentiString).length > 0 ? parseMentions(agentiString) : [interaction.user.id];
      
      // Assicurati che tutti gli agenti siano nel database
      for (const agenteId of agentiMenzionati) {
        let agenteData = await db.getAgente(agenteId);
        if (!agenteData) {
          try {
            const user = await interaction.client.users.fetch(agenteId);
            await db.addAgente(agenteId, user.username);
          } catch (error) {
            console.error('Errore nel fetch dell\'utente:', error);
          }
        }
      }
      
      const pdaId = await db.addPda(agentiMenzionati, nome, cognome, dataNascita, motivo, dataScadenza);
      
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle(`🔫 PDA RILASCIATO`)
        .setImage(foto)
        .setFields([
          { name: '🆔 ID PDA', value: `\`${pdaId}\``, inline: true },
          { name: 'Persona', value: `${nome} ${cognome}`, inline: true },
          { name: 'Data Nascita', value: `\`${dataNascita}\``, inline: true },
          { name: 'Motivo', value: motivo, inline: false },
          { name: 'Scadenza', value: `\`${dataScadenza}\``, inline: true },
          { name: '👮 Agenti Coinvolti', value: agentiMenzionati.map((id, i) => `${i + 1}. <@${id}>`).join('\n'), inline: false }
        ])
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  annulla_arresto: {
    data: new SlashCommandBuilder()
      .setName('annulla_arresto')
      .setDescription('Annulla un arresto registrato')
      .addIntegerOption(option => option.setName('id').setDescription('ID dell\'arresto').setRequired(true)),
    execute: async (interaction) => {
      const id = interaction.options.getInteger('id');
      const arresto = await db.getArresto(id);

      if (!arresto) {
        return interaction.reply({ content: '❌ Arresto non trovato!', ephemeral: true });
      }

      if (!canModifyRecord(interaction, arresto)) {
        return interaction.reply({ content: '❌ Solo chi ha effettuato l\'arresto o lo staff può annullarlo!', ephemeral: true });
      }

      const result = await db.removeArresto(id);
      if (!result.success) {
        return interaction.reply({ content: '❌ Errore durante l\'annullamento dell\'arresto!', ephemeral: true });
      }

      const persona = result.persona;
      const embed = new EmbedBuilder()
        .setColor(0xff6600)
        .setTitle('🚫 ARRESTO ANNULLATO')
        .setFields([
          { name: '🆔 ID Arresto', value: `\`${id}\``, inline: true },
          { name: 'Persona', value: `${arresto.nome} ${arresto.cognome}`, inline: true },
          { name: 'Data Nascita', value: `\`${arresto.dataNascita}\``, inline: true },
          { name: 'Annullato da', value: `\`${interaction.user.username}\``, inline: true },
          { name: 'Fedina', value: `\`${persona?.fedina === 'pulita' ? 'PULITA' : 'SPORCA'}\``, inline: true }
        ])
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  },

  edit_pda: {
    data: new SlashCommandBuilder()
      .setName('edit_pda')
      .setDescription('Modifica un PDA')
      .addIntegerOption(option => option.setName('id').setDescription('ID del PDA').setRequired(true))
      .addStringOption(option => option.setName('motivo').setDescription('Motivo').setRequired(false))
      .addStringOption(option => option.setName('data_scadenza').setDescription('Data scadenza').setRequired(false))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto').setRequired(false)),
    execute: async (interaction) => {
      const id = interaction.options.getInteger('id');
      const pda = await db.getPda(id);
      
      if (!pda) {
        return interaction.reply({ content: '❌ PDA non trovato!', ephemeral: true });
      }
      
      if (!canModifyRecord(interaction, pda)) {
        return interaction.reply({ content: '❌ Solo chi ha rilasciato il PDA o lo staff può modificarlo!', ephemeral: true });
      }
      
      const updates = {};
      if (interaction.options.getString('motivo')) updates.motivo = interaction.options.getString('motivo');
      if (interaction.options.getString('data_scadenza')) updates.dataScadenza = interaction.options.getString('data_scadenza');
      if (interaction.options.getString('agenti')) {
        const agentiString = interaction.options.getString('agenti') || '';
        const parsedAgenti = parseMentions(agentiString);
        if (parsedAgenti.length > 0) updates.agenti = parsedAgenti;
      }
      if (interaction.options.getAttachment('foto')) {
        const fotoAttachment = interaction.options.getAttachment('foto');
        updates.foto = fotoAttachment.url;
      }
      
      await db.editPda(id, updates);
      
      await interaction.reply({ content: `✅ PDA #${id} modificato con successo!`, ephemeral: true });
    }
  },

  ritira_pda: {
    data: new SlashCommandBuilder()
      .setName('ritira_pda')
      .setDescription('Ritira un porto d\'armi (PDA)')
      .addStringOption(option => option.setName('nome').setDescription('Nome').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('motivo').setDescription('Motivo del ritiro').setRequired(true)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Verifica che la persona esista nel database
      let persona = await db.getPersona(nome, cognome, dataNascita);
      if (!persona) {
        return interaction.reply({ content: `❌ Persona non trovata nel database! Prima fai \`/info ${nome} ${cognome} ${dataNascita}\` per registrarla.`, ephemeral: true });
      }
      
      const motivo = interaction.options.getString('motivo');
      
      const result = await db.removePda(nome, cognome, dataNascita, motivo);
      
      if (!result.success) {
        return interaction.reply({ content: '❌ PDA non trovato!', ephemeral: true });
      }
      
      const embed = new EmbedBuilder()
        .setColor(0xff6600)
        .setTitle(`🔫 PDA RITIRATO`)
        .setFields([
          { name: 'Persona', value: `${nome} ${cognome}`, inline: true },
          { name: 'Motivo', value: motivo, inline: false },
          { name: 'Ritirato da', value: `\`${interaction.user.username}\``, inline: true }
        ])
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  denuncia: {
    data: new SlashCommandBuilder()
      .setName('denuncia')
      .setDescription('Registra una denuncia')
      .addStringOption(option => option.setName('nome').setDescription('Nome denunciato').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome denunciato').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('data').setDescription('Data denuncia (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('reati').setDescription('Reati contestati').setRequired(true))
      .addStringOption(option => option.setName('chi_espone').setDescription('Chi espone la denuncia').setRequired(true))
      .addStringOption(option => option.setName('prove_reato').setDescription('Descrizione prove').setRequired(true))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto').setRequired(true))
      .addStringOption(option => option.setName('link_prove').setDescription('Link prove').setRequired(false)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Registra la persona se non esiste nel database
      await db.addPersona(nome, cognome, dataNascita);
      let persona = await db.getPersona(nome, cognome, dataNascita);
      
      const data = interaction.options.getString('data');
      const reati = interaction.options.getString('reati');
      const chiEspone = interaction.options.getString('chi_espone');
      const proveReato = interaction.options.getString('prove_reato');
      const fotoAttachment = interaction.options.getAttachment('foto');
      const fotoUrl = fotoAttachment ? fotoAttachment.url : null;
      const linkProve = interaction.options.getString('link_prove');
      
      const denunciaId = await db.addDenuncia(nome, cognome, dataNascita, data, reati, chiEspone, proveReato, fotoUrl, linkProve, interaction.user.id);
      
      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle(`📋 DENUNCIA REGISTRATA`)
        .setFields([
          { name: '🆔 ID Denuncia', value: `\`${denunciaId}\``, inline: true },
          { name: 'Denunciato', value: `${nome} ${cognome}`, inline: true },
          { name: 'Data Nascita', value: `\`${dataNascita}\``, inline: true },
          { name: 'Data Denuncia', value: `\`${data}\``, inline: true },
          { name: 'Reati', value: `\`\`\`${reati}\`\`\``, inline: false },
          { name: 'Esposta da', value: `\`${chiEspone}\``, inline: true },
          { name: 'Prove', value: `\`\`\`${proveReato}\`\`\``, inline: false },
          ...(fotoUrl ? [{ name: 'Foto Prova', value: `[Allegato](${fotoUrl})`, inline: false }] : []),
          ...(linkProve ? [{ name: 'Link Prove', value: `[Link](${linkProve})`, inline: false }] : [])
        ])
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  edit_denuncia: {
    data: new SlashCommandBuilder()
      .setName('edit_denuncia')
      .setDescription('Modifica una denuncia')
      .addIntegerOption(option => option.setName('id').setDescription('ID della denuncia').setRequired(true))
      .addStringOption(option => option.setName('reati').setDescription('Reati').setRequired(false))
      .addStringOption(option => option.setName('prove_reato').setDescription('Prove').setRequired(false))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto prove').setRequired(false))
      .addStringOption(option => option.setName('link_prove').setDescription('Link prove').setRequired(false)),
    execute: async (interaction) => {
      const id = interaction.options.getInteger('id');
      const denuncia = await db.getDenuncia(id);
      
      if (!denuncia) {
        return interaction.reply({ content: '❌ Denuncia non trovata!', ephemeral: true });
      }
      
      if (!canModifyRecord(interaction, denuncia)) {
        return interaction.reply({ content: '❌ Solo chi ha registrato la denuncia o lo staff può modificarla!', ephemeral: true });
      }
      
      const updates = {};
      if (interaction.options.getString('reati')) updates.reati = interaction.options.getString('reati');
      if (interaction.options.getString('prove_reato')) updates.proveReato = interaction.options.getString('prove_reato');
      if (interaction.options.getAttachment('foto')) {
        const fotoAttachment = interaction.options.getAttachment('foto');
        updates.foto = fotoAttachment.url;
      }
      if (interaction.options.getString('link_prove')) updates.linkProve = interaction.options.getString('link_prove');
      
      await db.editDenuncia(id, updates);
      
      await interaction.reply({ content: `✅ Denuncia #${id} modificata con successo!`, ephemeral: true });
    }
  },

  multa: {
    data: new SlashCommandBuilder()
      .setName('multa')
      .setDescription('Registra una multa')
      .addStringOption(option => option.setName('nome').setDescription('Nome multato').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome multato').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('data').setDescription('Data multa (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('reato').setDescription('Motivo della multa').setRequired(true))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Registra la persona se non esiste nel database
      await db.addPersona(nome, cognome, dataNascita);
      let persona = await db.getPersona(nome, cognome, dataNascita);
      
      const data = interaction.options.getString('data');
      const reato = interaction.options.getString('reato');
      const agentiString = interaction.options.getString('agenti') || '';
      const agentiMenzionati = parseMentions(agentiString).length > 0 ? parseMentions(agentiString) : [interaction.user.id];
      
      // Assicurati che tutti gli agenti siano nel database
      for (const agenteId of agentiMenzionati) {
        let agenteData = await db.getAgente(agenteId);
        if (!agenteData) {
          try {
            const user = await interaction.client.users.fetch(agenteId);
            await db.addAgente(agenteId, user.username);
          } catch (error) {
            console.error('Errore nel fetch dell\'utente:', error);
          }
        }
      }
      
      const multaId = await db.addMulta(agentiMenzionati, nome, cognome, dataNascita, data, reato);
      
      const embed = new EmbedBuilder()
        .setColor(0xffcc00)
        .setTitle(`💰 MULTA REGISTRATA`)
        .setFields([
          { name: '🆔 ID Multa', value: `\`${multaId}\``, inline: true },
          { name: 'Multato', value: `${nome} ${cognome}`, inline: true },
          { name: 'Data Nascita', value: `\`${dataNascita}\``, inline: true },
          { name: 'Data', value: `\`${data}\``, inline: true },
          { name: 'Motivo', value: `\`\`\`${reato}\`\`\``, inline: false },
          { name: 'Agenti', value: agentiMenzionati.map((id, i) => `${i + 1}. <@${id}>`).join('\n'), inline: false }
        ])
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  edit_multa: {
    data: new SlashCommandBuilder()
      .setName('edit_multa')
      .setDescription('Modifica una multa')
      .addIntegerOption(option => option.setName('id').setDescription('ID della multa').setRequired(true))
      .addStringOption(option => option.setName('reato').setDescription('Motivo multa').setRequired(false))
      .addStringOption(option => option.setName('data').setDescription('Data multa').setRequired(false))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false)),
    execute: async (interaction) => {
      const id = interaction.options.getInteger('id');
      const multa = await db.getMulta(id);
      
      if (!multa) {
        return interaction.reply({ content: '❌ Multa non trovata!', ephemeral: true });
      }
      
      if (!canModifyRecord(interaction, multa)) {
        return interaction.reply({ content: '❌ Solo chi ha emesso la multa o lo staff può modificarla!', ephemeral: true });
      }
      
      const updates = {};
      if (interaction.options.getString('reato')) updates.reato = interaction.options.getString('reato');
      if (interaction.options.getString('data')) updates.data = interaction.options.getString('data');
      if (interaction.options.getString('agenti')) {
        const agentiString = interaction.options.getString('agenti') || '';
        const parsedAgenti = parseMentions(agentiString);
        if (parsedAgenti.length > 0) updates.agenti = parsedAgenti;
      }
      
      await db.editMulta(id, updates);
      
      await interaction.reply({ content: `✅ Multa #${id} modificata con successo!`, ephemeral: true });
    }
  },

  sequestra_macchina: {
    data: new SlashCommandBuilder()
      .setName('sequestra_macchina')
      .setDescription('Sequestra una macchina')
      .addStringOption(option => option.setName('nome').setDescription('Nome proprietario').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome proprietario').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('data').setDescription('Data sequestro (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('targa').setDescription('Targa veicolo').setRequired(true))
      .addStringOption(option => option.setName('motivo').setDescription('Motivo sequestro').setRequired(true))
      .addNumberOption(option => option.setName('multa').setDescription('Importo multa').setRequired(true))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto').setRequired(true))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Registra la persona se non esiste nel database
      await db.addPersona(nome, cognome, dataNascita);
      let persona = await db.getPersona(nome, cognome, dataNascita);
      
      const data = interaction.options.getString('data');
      const targa = interaction.options.getString('targa');
      const motivo = interaction.options.getString('motivo');
      const multa = interaction.options.getNumber('multa');
      const fotoAttachment = interaction.options.getAttachment('foto');
      const foto = fotoAttachment.url;
      const agentiString = interaction.options.getString('agenti') || '';
      const agentiMenzionati = parseMentions(agentiString).length > 0 ? parseMentions(agentiString) : [interaction.user.id];
      
      // Assicurati che tutti gli agenti siano nel database
      for (const agenteId of agentiMenzionati) {
        let agenteData = await db.getAgente(agenteId);
        if (!agenteData) {
          try {
            const user = await interaction.client.users.fetch(agenteId);
            await db.addAgente(agenteId, user.username);
          } catch (error) {
            console.error('Errore nel fetch dell\'utente:', error);
          }
        }
      }
      
      const sequestroId = await db.addSequestro(agentiMenzionati, nome, cognome, dataNascita, data, targa, motivo, multa);
      
      const embed = new EmbedBuilder()
        .setColor(0x0066ff)
        .setTitle(`🚗 MACCHINA SEQUESTRATA`)
        .setImage(foto)
        .setFields([
          { name: '🆔 ID Sequestro', value: `\`${sequestroId}\``, inline: true },
          { name: 'Proprietario', value: `${nome} ${cognome}`, inline: true },
          { name: 'Data Nascita', value: `\`${dataNascita}\``, inline: true },
          { name: 'Targa', value: `\`${targa}\``, inline: true },
          { name: 'Data', value: `\`${data}\``, inline: true },
          { name: 'Motivo', value: `\`\`\`${motivo}\`\`\``, inline: false },
          { name: 'Multa', value: `\`€${multa.toFixed(2)}\``, inline: true },
          { name: '👮 Agenti Coinvolti', value: agentiMenzionati.map((id, i) => `${i + 1}. <@${id}>`).join('\n'), inline: false }
        ])
        .setTimestamp();
      
      await sendToCartellinoChannel(interaction, embed);
      await interaction.reply({ embeds: [embed] });
    }
  },

  dissezestra: {
    data: new SlashCommandBuilder()
      .setName('dissezestra')
      .setDescription('Rilascia una macchina sequestrata')
      .addStringOption(option => option.setName('nome').setDescription('Nome proprietario').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome proprietario').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('targa').setDescription('Targa veicolo').setRequired(true)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      const targa = interaction.options.getString('targa');
      
      const result = await db.removeSequestro(nome, cognome, dataNascita, targa);
      
      if (!result) {
        return interaction.reply({ content: '❌ Sequestro non trovato!', ephemeral: true });
      }
      
      const embed = new EmbedBuilder()
        .setColor(0x66ff00)
        .setTitle(`🚗 MACCHINA RILASCIATA`)
        .setFields([
          { name: 'Proprietario', value: `${nome} ${cognome}`, inline: true },
          { name: 'Data Nascita', value: `\`${dataNascita}\``, inline: true },
          { name: 'Targa', value: `\`${targa}\``, inline: true },
          { name: 'Liberata da', value: `\`${interaction.user.username}\``, inline: true }
        ])
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  edit_sequestro: {
    data: new SlashCommandBuilder()
      .setName('edit_sequestro')
      .setDescription('Modifica un sequestro')
      .addIntegerOption(option => option.setName('id').setDescription('ID sequestro').setRequired(true))
      .addStringOption(option => option.setName('motivo').setDescription('Motivo').setRequired(false))
      .addNumberOption(option => option.setName('multa').setDescription('Multa').setRequired(false))
      .addStringOption(option => option.setName('targa').setDescription('Targa veicolo').setRequired(false))
      .addStringOption(option => option.setName('agenti').setDescription('Colleghi coinvolti (tagga: @agente1 @agente2)').setRequired(false))
      .addAttachmentOption(option => option.setName('foto').setDescription('Foto').setRequired(false)),
    execute: async (interaction) => {
      const id = interaction.options.getInteger('id');
      const sequestro = await db.getSequestro(id);
      
      if (!sequestro) {
        return interaction.reply({ content: '❌ Sequestro non trovato!', ephemeral: true });
      }
      
      if (!canModifyRecord(interaction, sequestro)) {
        return interaction.reply({ content: '❌ Solo chi ha effettuato il sequestro o lo staff può modificarlo!', ephemeral: true });
      }
      
      const updates = {};
      if (interaction.options.getString('motivo')) updates.motivo = interaction.options.getString('motivo');
      if (interaction.options.getNumber('multa') !== null) updates.multa = interaction.options.getNumber('multa');
      if (interaction.options.getString('targa')) updates.targa = interaction.options.getString('targa');
      if (interaction.options.getString('agenti')) {
        const agentiString = interaction.options.getString('agenti') || '';
        const parsedAgenti = parseMentions(agentiString);
        if (parsedAgenti.length > 0) updates.agenti = parsedAgenti;
      }
      if (interaction.options.getAttachment('foto')) {
        const fotoAttachment = interaction.options.getAttachment('foto');
        updates.foto = fotoAttachment.url;
      }
      
      await db.editSequestro(id, updates);
      
      await interaction.reply({ content: `✅ Sequestro #${id} modificato con successo!`, ephemeral: true });
    }
  },

  info: {
    data: new SlashCommandBuilder()
      .setName('info')
      .setDescription('Visualizza informazioni di una persona')
      .addStringOption(option => option.setName('nome').setDescription('Nome').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true)),
    execute: async (interaction) => {
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Registra la persona nel database se non esiste
      await db.addPersona(nome, cognome, dataNascita);
      
      let persona = await db.getPersona(nome, cognome, dataNascita);
      
      if (!persona) {
        return interaction.reply({ content: '❌ Errore nel caricamento dei dati!', ephemeral: true });
      }
      
      const embed = await createInfoPersonaEmbed(persona);
      await interaction.reply({ embeds: [embed] });
    }
  },

  pulisci_fedina: {
    data: new SlashCommandBuilder()
      .setName('pulisci_fedina')
      .setDescription('[RUOLO SPECIALE] Pulisce la fedina di una persona')
      .addStringOption(option => option.setName('nome').setDescription('Nome').setRequired(true))
      .addStringOption(option => option.setName('cognome').setDescription('Cognome').setRequired(true))
      .addStringOption(option => option.setName('data_nascita').setDescription('Data di nascita (GG/MM/YYYY)').setRequired(true))
      .addStringOption(option => option.setName('motivo').setDescription('Motivo della pulizia').setRequired(true))
      .addAttachmentOption(option => option.setName('foto_pagamento').setDescription('Foto comprovante pagamento').setRequired(true)),
    execute: async (interaction) => {
      const pulisciRole = getGuildEnv('PULISCI_FEDINA_ROLE', interaction.guildId) || 'Comandante';
      if (!hasRole(interaction.member, pulisciRole)) {
        return interaction.reply({ content: '❌ Non hai il permesso per usare questo comando!', ephemeral: true });
      }
      
      const nome = interaction.options.getString('nome');
      const cognome = interaction.options.getString('cognome');
      const dataNascita = interaction.options.getString('data_nascita');
      
      // Verifica che la persona esista nel database
      let persona = await db.getPersona(nome, cognome, dataNascita);
      if (!persona) {
        return interaction.reply({ content: `❌ Persona non trovata nel database! Prima fai \`/info ${nome} ${cognome} ${dataNascita}\` per registrarla.`, ephemeral: true });
      }
      
      const motivo = interaction.options.getString('motivo');
      const fotoAttachment = interaction.options.getAttachment('foto_pagamento');
      const fotoPagamento = fotoAttachment.url;
      
      const result = await db.pulisciFedina(nome, cognome, dataNascita);
      
      if (!result) {
        return interaction.reply({ content: '❌ Persona non trovata!', ephemeral: true });
      }
      
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle(`✅ FEDINA PULITA`)
        .setImage(fotoPagamento)
        .setFields([
          { name: 'Persona', value: `${nome} ${cognome}`, inline: true },
          { name: 'Data Nascita', value: `\`${dataNascita}\``, inline: true },
          { name: 'Motivo', value: motivo, inline: false },
          { name: 'Pulita da', value: `\`${interaction.user.username}\``, inline: true },
          { name: 'Data', value: new Date().toLocaleString('it-IT'), inline: true }
        ])
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  cartellino_sistema: {
    data: new SlashCommandBuilder()
      .setName('cartellino_sistema')
      .setDescription('Visualizza gli agenti in servizio'),
    execute: async (interaction) => {
      const allAgenti = await db.getAllAgenti?.() || {};
      const agentiInServizio = Object.values(allAgenti).filter(agente => agente.inServizio);
      
      let descriptionText = '';
      if (agentiInServizio.length === 0) {
        descriptionText = '✅ Nessun agente in servizio';
      } else {
        descriptionText = agentiInServizio.map(agente => {
          const inizio = new Date(agente.timbraInizio);
          const now = new Date();
          const ore = (now - inizio) / (1000 * 60 * 60);
          return `👮 **${agente.nome}** - In servizio da ${ore.toFixed(2)}h`;
        }).join('\n');
      }
      
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('🚔 AGENTI IN SERVIZIO')
        .setDescription(descriptionText)
        .setFooter({ text: 'Sistema Cartellini LSPD' })
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

};

if (HIDE_PULISCI_FEDINA) {
  delete commands.pulisci_fedina;
}

module.exports = commands;
