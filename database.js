const fs = require('fs');
const path = require('path');

const customDbPath = process.env.DATABASE_FILE_PATH || process.env.DB_PATH;
const dbPath = customDbPath ? path.resolve(customDbPath) : path.join(__dirname, 'database.json');

function ensureDbFile() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({
      agenti: {},
      persone: {},
      arresti: {},
      denuncie: {},
      multe: {},
      sequestri: {},
      pda: {},
      nextArrestId: 1,
      nextDenunciaId: 1,
      nextMultaId: 1,
      nextSequestroId: 1,
      nextPdaId: 1
    }, null, 2), 'utf8');
  }
}

async function loadDatabase() {
  ensureDbFile();
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

function saveDatabase(data) {
  ensureDbFile();
  const tempPath = `${dbPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, dbPath);
}

function getPersonaId(nome, cognome, dataNascita) {
  return `${nome.trim()}-${cognome.trim()}-${dataNascita.trim()}`.toLowerCase();
}

async function getNextSequence(name) {
  const db = await loadDatabase();
  const field = `next${name.charAt(0).toUpperCase() + name.slice(1)}Id`;
  const nextValue = db[field] || 1;
  db[field] = nextValue + 1;
  saveDatabase(db);
  return nextValue;
}

async function addAgente(userId, userName) {
  const db = await loadDatabase();
  if (!db.agenti[userId]) {
    db.agenti[userId] = {
      nome: userName,
      oreServizio: 0,
      oreTotali: 0,
      inServizio: false,
      timbraInizio: null,
      pdaEmessi: 0,
      arresti: 0,
      multe: 0,
      sequestri: 0,
      createdAt: new Date().toISOString()
    };
    saveDatabase(db);
  }
  return userId;
}

async function updateAgente(userId, data) {
  const db = await loadDatabase();
  if (db.agenti[userId]) {
    db.agenti[userId] = { ...db.agenti[userId], ...data };
    saveDatabase(db);
  }
}

async function getAgente(userId) {
  const db = await loadDatabase();
  return db.agenti[userId] || null;
}

async function getAllAgenti() {
  const db = await loadDatabase();
  return db.agenti || {};
}

async function addPersona(nome, cognome, dataNascita) {
  const personaId = getPersonaId(nome, cognome, dataNascita);
  const db = await loadDatabase();
  if (!db.persone[personaId]) {
    db.persone[personaId] = {
      nome,
      cognome,
      dataNascita,
      fedina: 'pulita',
      arresti: [],
      denuncie: [],
      multe: [],
      macchineSequestrate: [],
      pda: null,
      createdAt: new Date().toISOString()
    };
    saveDatabase(db);
  }
  return personaId;
}

async function getPersona(nome, cognome, dataNascita) {
  const personaId = getPersonaId(nome, cognome, dataNascita);
  const db = await loadDatabase();
  return db.persone[personaId] || null;
}

async function addArresto(agentiIds, nome, cognome, dataNascita, reati, multa, oggettiSequestrati, oggettiConsegnati, fotoUrl) {
  const db = await loadDatabase();
  const arrestId = db.nextArrestId++;
  const personaId = await addPersona(nome, cognome, dataNascita);

  db.arresti[arrestId] = {
    id: arrestId,
    agenti: Array.isArray(agentiIds) ? agentiIds : [agentiIds],
    nome,
    cognome,
    dataNascita,
    reati,
    multa,
    oggettiSequestrati,
    oggettiConsegnati,
    foto: fotoUrl,
    data: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  db.persone[personaId].arresti.push(arrestId);
  db.persone[personaId].fedina = 'sporca';

  (Array.isArray(agentiIds) ? agentiIds : [agentiIds]).forEach(agenteId => {
    if (db.agenti[agenteId]) {
      db.agenti[agenteId].arresti++;
    }
  });

  saveDatabase(db);
  return arrestId;
}

async function editArresto(arrestId, data) {
  const db = await loadDatabase();
  if (db.arresti[arrestId]) {
    db.arresti[arrestId] = { ...db.arresti[arrestId], ...data };
    saveDatabase(db);
  }
}

async function removeArresto(arrestId) {
  const db = await loadDatabase();
  const arresto = db.arresti[arrestId];
  if (!arresto) return { success: false };

  const personaId = getPersonaId(arresto.nome, arresto.cognome, arresto.dataNascita);
  if (db.persone[personaId]) {
    db.persone[personaId].arresti = db.persone[personaId].arresti.filter(id => id !== arrestId);
    if (db.persone[personaId].arresti.length === 0 && db.persone[personaId].denuncie.length === 0 && db.persone[personaId].multe.length === 0) {
      db.persone[personaId].fedina = 'pulita';
    }
  }

  if (Array.isArray(arresto.agenti)) {
    arresto.agenti.forEach(agenteId => {
      if (db.agenti[agenteId] && db.agenti[agenteId].arresti > 0) {
        db.agenti[agenteId].arresti -= 1;
      }
    });
  }

  delete db.arresti[arrestId];
  saveDatabase(db);
  return { success: true, arresto, persona: db.persone[personaId] || null };
}

async function getArresto(arrestId) {
  const db = await loadDatabase();
  return db.arresti[arrestId] || null;
}

async function addPda(agentiIds, nome, cognome, dataNascita, motivo, dataScadenza) {
  const db = await loadDatabase();
  const pdaId = db.nextPdaId++;
  const personaId = await addPersona(nome, cognome, dataNascita);

  if (db.persone[personaId].pda) {
    delete db.pda[db.persone[personaId].pda];
  }

  db.pda[pdaId] = {
    id: pdaId,
    agenti: Array.isArray(agentiIds) ? agentiIds : [agentiIds],
    nome,
    cognome,
    dataNascita,
    motivo,
    dataScadenza,
    data: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  db.persone[personaId].pda = pdaId;

  (Array.isArray(agentiIds) ? agentiIds : [agentiIds]).forEach(agenteId => {
    if (db.agenti[agenteId]) {
      db.agenti[agenteId].pdaEmessi++;
    }
  });

  saveDatabase(db);
  return pdaId;
}

async function editPda(pdaId, data) {
  const db = await loadDatabase();
  if (db.pda[pdaId]) {
    db.pda[pdaId] = { ...db.pda[pdaId], ...data };
    saveDatabase(db);
  }
}

async function getPda(pdaId) {
  const db = await loadDatabase();
  return db.pda[pdaId] || null;
}

async function removePda(nome, cognome, dataNascita, motivo) {
  const db = await loadDatabase();
  const personaId = getPersonaId(nome, cognome, dataNascita);

  if (db.persone[personaId]?.pda) {
    const pdaRecord = db.pda[db.persone[personaId].pda];
    delete db.pda[db.persone[personaId].pda];
    db.persone[personaId].pda = null;
    saveDatabase(db);
    return { success: true, pdaRecord, motivo };
  }
  return { success: false };
}

async function addDenuncia(nome, cognome, dataNascita, data, reati, chiEspone, proveReato, fotoUrl, linkProve, createdBy) {
  const db = await loadDatabase();
  const denunciaId = db.nextDenunciaId++;
  const personaId = await addPersona(nome, cognome, dataNascita);

  db.denuncie[denunciaId] = {
    id: denunciaId,
    nome,
    cognome,
    dataNascita,
    data,
    reati,
    chiEspone,
    proveReato,
    foto: fotoUrl || null,
    link: linkProve || null,
    createdBy: createdBy || null,
    createdAt: new Date().toISOString()
  };

  db.persone[personaId].denuncie.push(denunciaId);
  saveDatabase(db);
  return denunciaId;
}

async function editDenuncia(denunciaId, data) {
  const db = await loadDatabase();
  if (db.denuncie[denunciaId]) {
    db.denuncie[denunciaId] = { ...db.denuncie[denunciaId], ...data };
    saveDatabase(db);
  }
}

async function getDenuncia(denunciaId) {
  const db = await loadDatabase();
  return db.denuncie[denunciaId] || null;
}

async function addMulta(agentiIds, nome, cognome, dataNascita, data, reato) {
  const db = await loadDatabase();
  const multaId = db.nextMultaId++;
  const personaId = await addPersona(nome, cognome, dataNascita);

  db.multe[multaId] = {
    id: multaId,
    agenti: Array.isArray(agentiIds) ? agentiIds : [agentiIds],
    nome,
    cognome,
    dataNascita,
    data,
    reato,
    createdAt: new Date().toISOString()
  };

  db.persone[personaId].multe.push(multaId);

  (Array.isArray(agentiIds) ? agentiIds : [agentiIds]).forEach(agenteId => {
    if (db.agenti[agenteId]) {
      db.agenti[agenteId].multe++;
    }
  });

  saveDatabase(db);
  return multaId;
}

async function editMulta(multaId, data) {
  const db = await loadDatabase();
  if (db.multe[multaId]) {
    db.multe[multaId] = { ...db.multe[multaId], ...data };
    saveDatabase(db);
  }
}

async function getMulta(multaId) {
  const db = await loadDatabase();
  return db.multe[multaId] || null;
}

async function addSequestro(agentiIds, nome, cognome, dataNascita, data, targa, motivo, multa) {
  const db = await loadDatabase();
  const sequestroId = db.nextSequestroId++;
  const personaId = await addPersona(nome, cognome, dataNascita);

  db.sequestri[sequestroId] = {
    id: sequestroId,
    agenti: Array.isArray(agentiIds) ? agentiIds : [agentiIds],
    nome,
    cognome,
    dataNascita,
    data,
    targa,
    motivo,
    multa,
    createdAt: new Date().toISOString()
  };

  db.persone[personaId].macchineSequestrate.push({
    targa,
    sequestroId,
    data: new Date().toISOString()
  });

  (Array.isArray(agentiIds) ? agentiIds : [agentiIds]).forEach(agenteId => {
    if (db.agenti[agenteId]) {
      db.agenti[agenteId].sequestri++;
    }
  });

  saveDatabase(db);
  return sequestroId;
}

async function editSequestro(sequestroId, data) {
  const db = await loadDatabase();
  if (db.sequestri[sequestroId]) {
    db.sequestri[sequestroId] = { ...db.sequestri[sequestroId], ...data };
    saveDatabase(db);
  }
}

async function getSequestro(sequestroId) {
  const db = await loadDatabase();
  return db.sequestri[sequestroId] || null;
}

async function removeSequestro(nome, cognome, dataNascita, targa) {
  const db = await loadDatabase();
  const personaId = getPersonaId(nome, cognome, dataNascita);

  if (db.persone[personaId]) {
    db.persone[personaId].macchineSequestrate = db.persone[personaId].macchineSequestrate.filter(m => m.targa !== targa);
    saveDatabase(db);
    return true;
  }
  return false;
}

async function pulisciFedina(nome, cognome, dataNascita) {
  const db = await loadDatabase();
  const personaId = getPersonaId(nome, cognome, dataNascita);

  if (db.persone[personaId]) {
    db.persone[personaId].fedina = 'pulita';
    db.persone[personaId].arresti = [];
    db.persone[personaId].denuncie = [];
    db.persone[personaId].multe = [];
    saveDatabase(db);
    return true;
  }
  return false;
}

module.exports = {
  loadDatabase,
  saveDatabase,
  addAgente,
  updateAgente,
  getAgente,
  getAllAgenti,
  addPersona,
  getPersona,
  addArresto,
  editArresto,
  removeArresto,
  getArresto,
  addPda,
  editPda,
  getPda,
  removePda,
  addDenuncia,
  editDenuncia,
  getDenuncia,
  addMulta,
  editMulta,
  getMulta,
  addSequestro,
  editSequestro,
  getSequestro,
  removeSequestro,
  pulisciFedina
};
