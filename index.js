require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes, ChannelType } = require('discord.js');
const express = require('express');
const db = require('./database');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });
const app = express();

// Middleware
app.use(express.json());

client.commands = new Collection();

// Importa tutti i comandi
const commands = require('./commands');
client.commands = commands;

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
// Support both comma-separated GUILD_IDS or numbered env vars GUILD_ID_1, GUILD_ID_2, ...
let GUILD_IDS = process.env.GUILD_IDS ? process.env.GUILD_IDS.split(',').map(id => id.trim()).filter(Boolean) : [];
if (!GUILD_IDS || GUILD_IDS.length === 0) {
  const numbered = Object.keys(process.env)
    .filter(k => /^GUILD_ID_\d+$/.test(k))
    .map(k => ({ n: parseInt(k.split('_').pop(), 10), v: process.env[k] }))
    .sort((a, b) => a.n - b.n)
    .map(x => (x.v || '').trim())
    .filter(Boolean);
  if (numbered.length > 0) {
    GUILD_IDS = numbered;
  }
}
const CARTELLINO_CHANNEL_ID = process.env.CARTELLINO_CHANNEL_ID;

// Ruoli autorizzati (supporto per override per-guild via VAR_{GUILDID})
function getGuildEnv(key, guildId) {
  if (!guildId) return process.env[key];
  // First try per-guild ID override: VAR_<GUILDID>
  const byId = process.env[`${key}_${guildId}`];
  if (byId !== undefined) return byId;

  // Then try numeric suffix based on GUILD_IDS order: VAR_1, VAR_2, ...
  try {
    const idx = GUILD_IDS.indexOf(String(guildId));
    if (idx !== -1) {
      const byIndex = process.env[`${key}_${idx + 1}`];
      if (byIndex !== undefined) return byIndex;
    }
  } catch (e) {
    // ignore
  }

  return process.env[key];
}

function hasRole(member, roleName) {
  if (!member) return false;
  return member.roles.cache.some(role => role.name === roleName || role.id === roleName);
}

async function handleReady() {
  console.log(`✅ Bot online come ${client.user.tag}`);

  // Registra i comandi slash
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const commandData = Object.values(commands).map(cmd => cmd.data.toJSON());
  
  try {
    console.log('📝 Registrazione comandi slash...');
    if (GUILD_IDS.length > 0) {
      for (const guildId of GUILD_IDS) {
        console.log(`➡️ Registrazione comandi su guild ${guildId}`);
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commandData });
      }
    } else if (GUILD_ID) {
      console.log(`➡️ Registrazione comandi su guild ${GUILD_ID}`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandData });
    } else {
      console.log('➡️ Registrazione comandi globali');
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandData });
    }
    console.log('✅ Comandi registrati con successo');
  } catch (error) {
    console.error('❌ Errore nella registrazione dei comandi:', error);
  }
}

client.once('ready', handleReady);
client.once('clientReady', handleReady);

client.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand()) {
    const command = client.commands[interaction.commandName];
    
    if (!command) {
      console.warn(`Comando non trovato: ${interaction.commandName}`);
      return interaction.reply({ content: '❌ Comando non trovato.', ephemeral: true });
    }
    
    try {
      await command.execute(interaction, client);
    } catch (error) {
      console.error('❌ Errore nel comando:', error);
      const errorMsg = error.message || 'Errore sconosciuto';
      const errorMessage = { 
        content: `❌ C'è stato un errore nell'esecuzione del comando!\n\`\`\`${errorMsg}\`\`\``, 
        ephemeral: true 
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage);
      } else {
        await interaction.reply(errorMessage);
      }
    }
  }
  
  if (interaction.isButton()) {
    const parts = interaction.customId.split('_');
    const action = parts[0];
    const userId = parts.slice(1).join('_');
    
      if (action === 'timbra') {
      const staffRole = getGuildEnv('STAFF_ROLE', interaction.guildId) || 'Staff LSPD';
      if (interaction.user.id !== userId && !hasRole(interaction.member, staffRole)) {
        return interaction.reply({ content: '❌ Non puoi usare i bottoni di altri agenti!', ephemeral: true });
      }
      
      const agente = await db.getAgente(userId);
      if (!agente) await db.addAgente(userId, interaction.user.username);
      
      await db.updateAgente(userId, {
        inServizio: true,
        timbraInizio: new Date().toISOString()
      });
      
      // Ottieni gli agenti in servizio
      const tuttiAgenti = await db.getAllAgenti();
      const agentiInServizio = Object.entries(tuttiAgenti)
        .filter(([id, agente]) => agente.inServizio)
        .map(([id]) => `<@${id}>`);
      
      let risposta = `✅ Timbratura entrata registrata alle ${new Date().toLocaleTimeString('it-IT')}\n\n`;
      
      if (agentiInServizio.length > 0) {
        risposta += `👮 **Agenti in servizio:** ${agentiInServizio.join(' • ')}`;
      } else {
        risposta += `⚠️ Nessun altro agente in servizio al momento`;
      }
      
      await interaction.reply({ content: risposta, ephemeral: true });
    }
    
    if (action === 'stimbra') {
      const staffRole = getGuildEnv('STAFF_ROLE', interaction.guildId) || 'Staff LSPD';
      if (interaction.user.id !== userId && !hasRole(interaction.member, staffRole)) {
        return interaction.reply({ content: '❌ Non puoi usare i bottoni di altri agenti!', ephemeral: true });
      }
      
      const agente = await db.getAgente(userId);
      if (!agente || !agente.inServizio) {
        return interaction.reply({ content: '⚠️ Non sei in servizio!', ephemeral: true });
      }
      
      const inizio = new Date(agente.timbraInizio);
      const fine = new Date();
      const ore = (fine - inizio) / (1000 * 60 * 60);
      
      await db.updateAgente(userId, {
        inServizio: false,
        timbraInizio: null,
        oreServizio: agente.oreServizio + ore,
        oreTotali: agente.oreTotali + ore
      });
      
      await interaction.reply({ content: `✅ Timbratura uscita registrata. Ore lavorate: ${ore.toFixed(2)}h`, ephemeral: true });
    }
    
    if (action === 'stat') {
      const agente = await db.getAgente(userId);
      if (!agente) {
        return interaction.reply({ content: '⚠️ Nessun dato trovato!', ephemeral: true });
      }
      
      const embed = {
        color: 0x0099ff,
        title: `📊 Statistiche - ${agente.nome}`,
        fields: [
          { name: 'Ore Totali', value: `${agente.oreTotali.toFixed(2)}h`, inline: true },
          { name: 'Stato', value: agente.inServizio ? '🟢 In Servizio' : '⚫ Fuori Servizio', inline: true },
          { name: 'PDA Emessi', value: `${agente.pdaEmessi}`, inline: true },
          { name: 'Arresti', value: `${agente.arresti}`, inline: true },
          { name: 'Multe', value: `${agente.multe}`, inline: true },
          { name: 'Sequestri', value: `${agente.sequestri}`, inline: true }
        ]
      };
      
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    if (action === 'info') {
      const agente = await db.getAgente(userId);
      if (!agente) {
        return interaction.reply({ content: '⚠️ Nessun dato trovato!', ephemeral: true });
      }
      
      const embed = {
        color: 0x0099ff,
        title: `📋 Info Agente - ${agente.nome}`,
        fields: [
          { name: 'Ore Cartellino', value: `\`${agente.oreServizio.toFixed(2)}h\``, inline: true },
          { name: 'Ore Totali', value: `\`${agente.oreTotali.toFixed(2)}h\``, inline: true },
          { name: 'Stato', value: agente.inServizio ? '🟢 In Servizio' : '⚫ Fuori Servizio', inline: true },
          { name: 'PDA Emessi', value: `\`${agente.pdaEmessi}\``, inline: true },
          { name: 'Arresti', value: `\`${agente.arresti}\``, inline: true },
          { name: 'Multe', value: `\`${agente.multe}\``, inline: true },
          { name: 'Sequestri', value: `\`${agente.sequestri}\``, inline: true }
        ]
      };
      
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    if (action === 'stato') {
      const agente = await db.getAgente(userId);
      if (!agente) {
        return interaction.reply({ content: '⚠️ Nessun dato trovato!', ephemeral: true });
      }
      
      const status = agente.inServizio ? '🟢 **IN SERVIZIO**' : '⚫ **FUORI SERVIZIO**';
      
      // Ottieni tutti gli agenti in servizio
      const tuttiAgenti = await db.getAllAgenti();
      const agentiInServizio = Object.entries(tuttiAgenti)
        .filter(([id, agent]) => agent.inServizio)
        .map(([id]) => `<@${id}>`);
      
      let risposta = `${status}\n\n`;
      
      if (agentiInServizio.length > 0) {
        risposta += `👮 **Agenti in servizio:** ${agentiInServizio.join(' • ')}`;
      } else {
        risposta += `⚠️ Nessun agente in servizio al momento`;
      }
      
      await interaction.reply({ content: risposta, ephemeral: true });
    }
  }
});

// ====== API ROUTES ======

// Variabile globale per i player online da FiveM
let fivemPlayersOnline = [];

// Endpoint per ricevere i dati dei player da FiveM
app.post('/api/fivem-players', (req, res) => {
  const { players } = req.body;
  
  if (Array.isArray(players)) {
    fivemPlayersOnline = players;
    if (process.env.DEBUG) {
      console.log(`✅ [FiveM] ${players.length} player online`);
    }
  }
  
  res.json({ success: true, message: 'Dati ricevuti' });
});

// Funzione per controllare se un player è online in FiveM
function isPlayerOnlineFiveM(personaIdentifier) {
  return fivemPlayersOnline.some(p => 
    p.identifier && p.identifier.includes(personaIdentifier)
  );
}

// Endpoint per cercare una persona
app.get('/api/persona/:nome/:cognome/:dataNascita', async (req, res) => {
  const { nome, cognome, dataNascita } = req.params;
  const persona = await db.getPersona(nome, cognome, dataNascita);
  
  if (!persona) {
    return res.status(404).json({ error: 'Persona non trovata', success: false });
  }
  
  res.json({
    success: true,
    data: persona
  });
});

// Endpoint per ottenere tutte le persone
app.get('/api/persone', async (req, res) => {
  const db_data = await db.loadDatabase();
  const persone = Object.values(db_data.persone || {});
  
  res.json({
    success: true,
    total: persone.length,
    data: persone
  });
});

// Endpoint per cercare persone per nome
app.get('/api/persone/ricerca/:termine', async (req, res) => {
  const { termine } = req.params;
  const db_data = await db.loadDatabase();
  const persone = Object.values(db_data.persone || {});
  
  const risultati = persone.filter(p => 
    p.nome.toLowerCase().includes(termine.toLowerCase()) || 
    p.cognome.toLowerCase().includes(termine.toLowerCase())
  );
  
  res.json({
    success: true,
    total: risultati.length,
    data: risultati
  });
});

// Endpoint per ottenere info dettagliate di una persona (con arresti, denuncie, ecc)
app.get('/api/persona-completa/:nome/:cognome/:dataNascita', async (req, res) => {
  const { nome, cognome, dataNascita } = req.params;
  const persona = await db.getPersona(nome, cognome, dataNascita);
  
  if (!persona) {
    return res.status(404).json({ error: 'Persona non trovata', success: false });
  }
  
  const db_data = await db.loadDatabase();
  
  // Aggiungi dettagli degli arresti
  const arresti = (persona.arresti || []).map(id => db_data.arresti[id]).filter(a => a);
  // Aggiungi dettagli delle denuncie
  const denuncie = (persona.denuncie || []).map(id => db_data.denuncie[id]).filter(d => d);
  // Aggiungi dettagli delle multe
  const multe = (persona.multe || []).map(id => db_data.multe[id]).filter(m => m);
  // Aggiungi dettagli del PDA
  const pda = persona.pda ? db_data.pda[persona.pda] : null;
  
  res.json({
    success: true,
    data: {
      ...persona,
      arresti: arresti,
      denuncie: denuncie,
      multe: multe,
      pda: pda
    }
  });
});

const API_PORT = process.env.API_PORT || 3001;

client.login(TOKEN);

// Avvia il server API
app.listen(API_PORT, () => {
  console.log(`🌐 API Server running su http://localhost:${API_PORT}`);
});
