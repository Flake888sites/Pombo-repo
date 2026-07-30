// ============================================================
// POMBO CORREIO - Backend (Express + SQLite + JWT)
// Apenas para brincadeira. Nao usar para dados sensiveis.
// ============================================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'pombo-correio-super-secreto-troque-isso';
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// BANCO DE DADOS
// ------------------------------------------------------------
const db = new Database(path.join(__dirname, 'pombos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  latitude REAL DEFAULT 0,
  longitude REAL DEFAULT 0,
  moedas INTEGER DEFAULT 50,
  pombosDesbloqueados TEXT DEFAULT '["pombo_comum"]',
  createdAt TEXT DEFAULT (datetime('now')),
  lastLocationChange TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromUserId INTEGER NOT NULL,
  toUserId INTEGER NOT NULL,
  mensagem TEXT NOT NULL,
  tipoPombo TEXT NOT NULL,
  velocidade REAL NOT NULL,
  distancia REAL NOT NULL,
  tempoChegada INTEGER NOT NULL,
  fromLat REAL,
  fromLng REAL,
  toLat REAL,
  toLng REAL,
  status TEXT DEFAULT 'voando',
  createdAt TEXT DEFAULT (datetime('now')),
  entregueEm TEXT
);

CREATE TABLE IF NOT EXISTS pombos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  velocidade REAL NOT NULL,
  multiplicadorMoedas REAL DEFAULT 1,
  custoMoedas INTEGER DEFAULT 0,
  emoji TEXT DEFAULT '🐦',
  descricao TEXT
);
`);

// Migração leve: garante a coluna lastLocationChange em bancos criados antes dessa mudança
try {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('lastLocationChange')) {
    db.exec(`ALTER TABLE users ADD COLUMN lastLocationChange TEXT DEFAULT (datetime('now'))`);
  }
} catch (e) {
  console.error('Erro na migração de lastLocationChange:', e.message);
}

// Migração: remove o Pombo Cósmico de bancos que já tinham sido populados antes dessa mudança
try {
  const cosmico = db.prepare("SELECT id FROM pombos WHERE tipo = 'pombo_cosmico'").get();
  if (cosmico) {
    // migra quem tinha esse pombo desbloqueado pra ficar sem quebrar o array salvo
    const usersComCosmico = db.prepare("SELECT id, pombosDesbloqueados FROM users WHERE pombosDesbloqueados LIKE '%pombo_cosmico%'").all();
    const updateUser = db.prepare('UPDATE users SET pombosDesbloqueados = ? WHERE id = ?');
    usersComCosmico.forEach(u => {
      const lista = JSON.parse(u.pombosDesbloqueados || '[]').filter(t => t !== 'pombo_cosmico');
      updateUser.run(JSON.stringify(lista), u.id);
    });
    db.prepare("DELETE FROM pombos WHERE tipo = 'pombo_cosmico'").run();
  }
} catch (e) {
  console.error('Erro na migração de remoção do pombo cósmico:', e.message);
}

// Popula tabela de pombos (apenas se vazia)
const pomboCount = db.prepare('SELECT COUNT(*) as c FROM pombos').get().c;
if (pomboCount === 0) {
  const insert = db.prepare(`
    INSERT INTO pombos (tipo, nome, velocidade, multiplicadorMoedas, custoMoedas, emoji, descricao)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tiposIniciais = [
    // tipo, nome, velocidade km/h, multiplicador de moedas, custo pra desbloquear, emoji, descricao
    ['caracol', 'Caracol Correio', 2, 8, 0, '🐌', 'Lentíssimo, mas paga muito bem. Pra quem tem paciência.'],
    ['pombo_comum', 'Pombo Comum', 60, 1, 0, '🐦', 'O clássico. Nada especial, mas sempre disponível.'],
    ['pombo_correio', 'Pombo-Correio Treinado', 90, 1.2, 30, '🕊️', 'Um pombo de verdade, treinado pra entregas.'],
    ['coruja', 'Coruja Noturna', 110, 1.4, 60, '🦉', 'Voa bem, principalmente à noite.'],
    ['falcao', 'Falcão Peregrino', 320, 1.8, 150, '🦅', 'Uma das aves mais rápidas do mundo.'],
    ['arara', 'Arara Colorida', 55, 1.5, 80, '🦜', 'Não é muito rápida, mas é estilosa.'],
    ['aguia', 'Águia Real', 240, 1.7, 130, '🦅', 'Forte e veloz, ótima para longas distâncias.'],
    ['morcego', 'Morcego Veloz', 100, 1.3, 70, '🦇', 'Voa até de olhos fechados (literalmente).'],
    ['foguete', 'Pombo Foguete', 900, 3, 500, '🚀', 'Alguém colocou um foguete nele. Não pergunte como.'],
    ['tartaruga', 'Tartaruga Espacial', 5, 6, 200, '🐢', 'Devagar e sempre. O dobro do bônus do caracol em moedas relativo à velocidade.'],
    ['guepardo', 'Guepardo Alado', 400, 2, 250, '🐆', 'O animal terrestre mais rápido, agora com asas.']
  ];
  const tx = db.transaction((rows) => {
    for (const r of rows) insert.run(...r);
  });
  tx(tiposIniciais);
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

// Distância Haversine em km
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // raio da Terra em km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente.' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.username = payload.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

const LOCATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function publicUser(u) {
  if (!u) return null;
  const lastChange = new Date((u.lastLocationChange || u.createdAt) + 'Z').getTime();
  const nextChangeAt = lastChange + LOCATION_COOLDOWN_MS;
  const canChangeLocation = Date.now() >= nextChangeAt;
  return {
    id: u.id,
    username: u.username,
    latitude: u.latitude,
    longitude: u.longitude,
    moedas: u.moedas,
    pombosDesbloqueados: JSON.parse(u.pombosDesbloqueados || '[]'),
    createdAt: u.createdAt,
    lastLocationChange: u.lastLocationChange,
    canChangeLocation,
    nextLocationChangeAt: new Date(nextChangeAt).toISOString()
  };
}

// Atualiza mensagens cujo tempo de chegada já passou -> "entregue"
function atualizarStatusMensagens() {
  const agora = Date.now();
  const voando = db.prepare(`SELECT * FROM messages WHERE status = 'voando'`).all();
  const update = db.prepare(`UPDATE messages SET status = 'entregue', entregueEm = ? WHERE id = ?`);
  for (const m of voando) {
    const criado = new Date(m.createdAt + 'Z').getTime();
    if (agora - criado >= m.tempoChegada) {
      update.run(new Date().toISOString(), m.id);
    }
  }
}

// Esconde o texto da mensagem de quem NÃO é o remetente enquanto o pombo ainda está voando.
// O remetente sempre pode ver o que escreveu; o destinatário só vê depois de "entregue".
function sanitizeMessage(m, viewerUserId) {
  if (!m) return m;
  const isSender = m.fromUserId === viewerUserId;
  if (m.status === 'voando' && !isSender) {
    return Object.assign({}, m, { mensagem: null });
  }
  return m;
}
function sanitizeMessages(list, viewerUserId) {
  return list.map(m => sanitizeMessage(m, viewerUserId));
}

// ------------------------------------------------------------
// ROTAS - USUÁRIOS
// ------------------------------------------------------------

// Registro
app.post('/api/users', (req, res) => {
  const { username, password, latitude, longitude } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username e password são obrigatórios.' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'username precisa ter pelo menos 3 caracteres.' });
  }
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) {
    return res.status(400).json({ error: 'Escolha sua localização inicial no mapa antes de criar a conta.' });
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'Localização inválida.' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return res.status(409).json({ error: 'Esse username já existe.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, latitude, longitude, lastLocationChange)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(username, hash, latitude, longitude);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username e password são obrigatórios.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// Listar usuários (para escolher destinatário)
app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT * FROM users').all();
  res.json(users.map(publicUser));
});

// Dados do usuário logado
app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json(publicUser(user));
});

// Atualizar localização (simulada) - respeita cooldown de 7 dias
app.put('/api/users/location', authMiddleware, (req, res) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'latitude e longitude são obrigatórios.' });
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'Localização inválida.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const lastChange = new Date((user.lastLocationChange || user.createdAt) + 'Z').getTime();
  const nextChangeAt = lastChange + LOCATION_COOLDOWN_MS;
  const now = Date.now();

  if (now < nextChangeAt) {
    const faltamMs = nextChangeAt - now;
    const faltamHoras = Math.ceil(faltamMs / (60 * 60 * 1000));
    const faltamDias = Math.floor(faltamHoras / 24);
    const horasRestantes = faltamHoras % 24;
    let mensagem;
    if (faltamDias > 0) {
      mensagem = `Você só pode trocar de localização novamente em ${faltamDias}d ${horasRestantes}h.`;
    } else {
      mensagem = `Você só pode trocar de localização novamente em ${faltamHoras}h.`;
    }
    return res.status(429).json({
      error: mensagem,
      nextLocationChangeAt: new Date(nextChangeAt).toISOString()
    });
  }

  db.prepare(`UPDATE users SET latitude = ?, longitude = ?, lastLocationChange = datetime('now') WHERE id = ?`)
    .run(latitude, longitude, req.userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json(publicUser(updated));
});

// Comprar/desbloquear um pombo com moedas
app.post('/api/pombos/desbloquear', authMiddleware, (req, res) => {
  const { tipo } = req.body;
  const pombo = db.prepare('SELECT * FROM pombos WHERE tipo = ?').get(tipo);
  if (!pombo) return res.status(404).json({ error: 'Pombo não encontrado.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const desbloqueados = JSON.parse(user.pombosDesbloqueados || '[]');

  if (desbloqueados.includes(tipo)) {
    return res.status(400).json({ error: 'Você já desbloqueou esse pombo.' });
  }
  if (user.moedas < pombo.custoMoedas) {
    return res.status(400).json({ error: 'Moedas insuficientes.', necessario: pombo.custoMoedas, atual: user.moedas });
  }

  desbloqueados.push(tipo);
  db.prepare('UPDATE users SET moedas = moedas - ?, pombosDesbloqueados = ? WHERE id = ?')
    .run(pombo.custoMoedas, JSON.stringify(desbloqueados), req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json(publicUser(updated));
});

// ------------------------------------------------------------
// ROTAS - POMBOS (tipos disponíveis)
// ------------------------------------------------------------
app.get('/api/pombos', (req, res) => {
  const pombos = db.prepare('SELECT * FROM pombos ORDER BY velocidade ASC').all();
  res.json(pombos);
});

// ------------------------------------------------------------
// ROTAS - MENSAGENS
// ------------------------------------------------------------

// Enviar mensagem (envia um pombo)
app.post('/api/messages', authMiddleware, (req, res) => {
  atualizarStatusMensagens();

  const { toUserId, mensagem, tipoPombo } = req.body;
  if (!toUserId || !mensagem || !tipoPombo) {
    return res.status(400).json({ error: 'toUserId, mensagem e tipoPombo são obrigatórios.' });
  }
  if (mensagem.length > 500) {
    return res.status(400).json({ error: 'Mensagem muito longa (máx 500 caracteres).' });
  }

  const fromUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const toUser = db.prepare('SELECT * FROM users WHERE id = ?').get(toUserId);
  if (!toUser) return res.status(404).json({ error: 'Destinatário não encontrado.' });
  if (toUser.id === fromUser.id) return res.status(400).json({ error: 'Você não pode mandar pombo pra si mesmo.' });

  // Regra: só 1 pombo voando por vez (por remetente)
  const jaVoando = db.prepare(`SELECT id FROM messages WHERE fromUserId = ? AND status = 'voando'`).get(req.userId);
  if (jaVoando) {
    return res.status(409).json({ error: 'Você já tem um pombo voando! Espere ele chegar antes de mandar outro.' });
  }

  const desbloqueados = JSON.parse(fromUser.pombosDesbloqueados || '[]');
  let pombo = db.prepare('SELECT * FROM pombos WHERE tipo = ?').get(tipoPombo);
  if (!pombo) return res.status(404).json({ error: 'Tipo de pombo inválido.' });
  if (!desbloqueados.includes(tipoPombo)) {
    return res.status(403).json({ error: 'Você não desbloqueou esse pombo ainda.' });
  }

  let distancia = haversineKm(fromUser.latitude, fromUser.longitude, toUser.latitude, toUser.longitude);
  distancia = Math.round(distancia * 100) / 100;

  let tempoChegada;
  let entregaInstantanea = false;
  if (distancia < 0.5) {
    tempoChegada = 0;
    entregaInstantanea = true;
  } else {
    tempoChegada = Math.round((distancia / pombo.velocidade) * 1000);
    // teto de segurança: min 2s, max 48h (mesmo pra distâncias enormes com pombos lentos)
    tempoChegada = Math.max(2000, Math.min(tempoChegada, 48 * 60 * 60 * 1000));
  }

  const status = entregaInstantanea ? 'entregue' : 'voando';
  const entregueEm = entregaInstantanea ? new Date().toISOString() : null;

  const info = db.prepare(`
    INSERT INTO messages
      (fromUserId, toUserId, mensagem, tipoPombo, velocidade, distancia, tempoChegada, fromLat, fromLng, toLat, toLng, status, entregueEm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.userId, toUserId, mensagem, tipoPombo, pombo.velocidade, distancia, tempoChegada,
    fromUser.latitude, fromUser.longitude, toUser.latitude, toUser.longitude, status, entregueEm
  );

  // Recompensa em moedas por enviar (multiplicador do pombo escolhido)
  const moedasGanhas = Math.max(1, Math.round(2 * pombo.multiplicadorMoedas));
  db.prepare('UPDATE users SET moedas = moedas + ? WHERE id = ?').run(moedasGanhas, req.userId);

  const novaMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ mensagem: novaMsg, moedasGanhas });
});

// Mensagens trocadas com um usuário específico (histórico do chat)
app.get('/api/messages/:userId', authMiddleware, (req, res) => {
  atualizarStatusMensagens();
  const otherId = parseInt(req.params.userId, 10);
  const msgs = db.prepare(`
    SELECT * FROM messages
    WHERE (fromUserId = ? AND toUserId = ?) OR (fromUserId = ? AND toUserId = ?)
    ORDER BY createdAt ASC
  `).all(req.userId, otherId, otherId, req.userId);
  res.json(sanitizeMessages(msgs, req.userId));
});

// Todas as mensagens "voando" no momento (pra mapa mundi / feed público)
app.get('/api/messages/status/voando', authMiddleware, (req, res) => {
  atualizarStatusMensagens();
  const msgs = db.prepare(`
    SELECT m.*, uf.username as fromUsername, ut.username as toUsername
    FROM messages m
    JOIN users uf ON uf.id = m.fromUserId
    JOIN users ut ON ut.id = m.toUserId
    WHERE m.status = 'voando'
    ORDER BY m.createdAt DESC
  `).all();
  res.json(msgs);
});

// Feed público de TODAS as mensagens em trânsito ou recentes (todo mundo pode ver quem manda pra quem, sem o texto)
app.get('/api/feed', authMiddleware, (req, res) => {
  atualizarStatusMensagens();
  const msgs = db.prepare(`
    SELECT m.id, m.fromUserId, m.toUserId, m.tipoPombo, m.velocidade, m.distancia,
           m.tempoChegada, m.fromLat, m.fromLng, m.toLat, m.toLng, m.status, m.createdAt, m.entregueEm,
           uf.username as fromUsername, ut.username as toUsername
    FROM messages m
    JOIN users uf ON uf.id = m.fromUserId
    JOIN users ut ON ut.id = m.toUserId
    ORDER BY m.createdAt DESC
    LIMIT 200
  `).all();
  res.json(msgs);
});

// Minhas mensagens pendentes (recebidas, ainda voando, endereçadas a mim)
app.get('/api/messages/pendentes/minhas', authMiddleware, (req, res) => {
  atualizarStatusMensagens();
  const msgs = db.prepare(`
    SELECT m.*, uf.username as fromUsername
    FROM messages m
    JOIN users uf ON uf.id = m.fromUserId
    WHERE m.toUserId = ? AND m.status = 'voando'
    ORDER BY m.createdAt DESC
  `).all(req.userId);
  res.json(sanitizeMessages(msgs, req.userId));
});

// Lista de conversas (chats) do usuário logado, com última mensagem
app.get('/api/chats', authMiddleware, (req, res) => {
  atualizarStatusMensagens();
  const msgs = db.prepare(`
    SELECT m.*, uf.username as fromUsername, ut.username as toUsername
    FROM messages m
    JOIN users uf ON uf.id = m.fromUserId
    JOIN users ut ON ut.id = m.toUserId
    WHERE m.fromUserId = ? OR m.toUserId = ?
    ORDER BY m.createdAt DESC
  `).all(req.userId, req.userId);

  const chatsMap = {};
  for (const m of msgs) {
    const otherId = m.fromUserId === req.userId ? m.toUserId : m.fromUserId;
    const otherName = m.fromUserId === req.userId ? m.toUsername : m.fromUsername;
    if (!chatsMap[otherId]) {
      chatsMap[otherId] = {
        userId: otherId,
        username: otherName,
        ultimaMensagem: sanitizeMessage(m, req.userId),
        totalMensagens: 0
      };
    }
    chatsMap[otherId].totalMensagens++;
  }
  res.json(Object.values(chatsMap));
});

// ------------------------------------------------------------
// HEALTHCHECK (para o UptimeRobot)
// ------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pombo-correio-backend', time: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  atualizarStatusMensagens();
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🐦 Pombo Correio backend rodando na porta ${PORT}`);
});
