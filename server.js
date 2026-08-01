// ============================================================
// POMBO CORREIO - Backend (Express + Postgres/Supabase + JWT)
// Apenas para brincadeira. Nao usar para dados sensiveis.
// ============================================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'pombo-correio-super-secreto-troque-isso';
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// BANCO DE DADOS (Postgres via Supabase)
// ------------------------------------------------------------
// Defina a variável de ambiente DATABASE_URL no Render com a connection string
// do Supabase (Project Settings -> Database -> Connection string -> modo "Transaction pooler").
if (!process.env.DATABASE_URL) {
  console.error('⚠️  DATABASE_URL não configurada! Defina essa variável de ambiente com a connection string do Supabase.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase exige SSL
});

// Helper: roda uma query e retorna as linhas
async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function qOne(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      latitude DOUBLE PRECISION DEFAULT 0,
      longitude DOUBLE PRECISION DEFAULT 0,
      moedas INTEGER DEFAULT 50,
      pombos_desbloqueados TEXT DEFAULT '["pombo_comum"]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_location_change TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_user_id INTEGER NOT NULL REFERENCES users(id),
      to_user_id INTEGER NOT NULL REFERENCES users(id),
      mensagem TEXT NOT NULL,
      tipo_pombo TEXT NOT NULL,
      velocidade DOUBLE PRECISION NOT NULL,
      distancia DOUBLE PRECISION NOT NULL,
      tempo_chegada BIGINT NOT NULL,
      from_lat DOUBLE PRECISION,
      from_lng DOUBLE PRECISION,
      to_lat DOUBLE PRECISION,
      to_lng DOUBLE PRECISION,
      status TEXT DEFAULT 'voando',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      entregue_em TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pombos (
      id SERIAL PRIMARY KEY,
      tipo TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      velocidade DOUBLE PRECISION NOT NULL,
      multiplicador_moedas DOUBLE PRECISION DEFAULT 1,
      custo_moedas INTEGER DEFAULT 0,
      emoji TEXT DEFAULT '🐦',
      descricao TEXT
    );
  `);

  // Popula tabela de pombos (apenas se vazia)
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM pombos');
  if (rows[0].c === 0) {
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
    for (const t of tiposIniciais) {
      await pool.query(
        `INSERT INTO pombos (tipo, nome, velocidade, multiplicador_moedas, custo_moedas, emoji, descricao)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        t
      );
    }
    console.log('✅ Tabela de pombos populada com', tiposIniciais.length, 'tipos.');
  }

  console.log('✅ Banco de dados (Postgres/Supabase) pronto.');
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

// Converte a linha do banco (snake_case) pro formato que o frontend espera (camelCase)
function publicUser(u) {
  if (!u) return null;
  const lastChange = new Date(u.last_location_change || u.created_at).getTime();
  const nextChangeAt = lastChange + LOCATION_COOLDOWN_MS;
  const canChangeLocation = Date.now() >= nextChangeAt;
  return {
    id: u.id,
    username: u.username,
    latitude: u.latitude,
    longitude: u.longitude,
    moedas: u.moedas,
    pombosDesbloqueados: JSON.parse(u.pombos_desbloqueados || '[]'),
    createdAt: u.created_at,
    lastLocationChange: u.last_location_change,
    canChangeLocation,
    nextLocationChangeAt: new Date(nextChangeAt).toISOString()
  };
}

function publicMessage(m) {
  if (!m) return null;
  return {
    id: m.id,
    fromUserId: m.from_user_id,
    toUserId: m.to_user_id,
    mensagem: m.mensagem,
    tipoPombo: m.tipo_pombo,
    velocidade: m.velocidade,
    distancia: m.distancia,
    tempoChegada: Number(m.tempo_chegada),
    fromLat: m.from_lat,
    fromLng: m.from_lng,
    toLat: m.to_lat,
    toLng: m.to_lng,
    status: m.status,
    createdAt: m.created_at,
    entregueEm: m.entregue_em,
    fromUsername: m.from_username,
    toUsername: m.to_username
  };
}

function publicPombo(p) {
  return {
    id: p.id,
    tipo: p.tipo,
    nome: p.nome,
    velocidade: p.velocidade,
    multiplicadorMoedas: p.multiplicador_moedas,
    custoMoedas: p.custo_moedas,
    emoji: p.emoji,
    descricao: p.descricao
  };
}

// Atualiza mensagens cujo tempo de chegada já passou -> "entregue"
async function atualizarStatusMensagens() {
  await pool.query(`
    UPDATE messages
    SET status = 'entregue', entregue_em = NOW()
    WHERE status = 'voando'
      AND (EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000) >= tempo_chegada
  `);
}

// Esconde o texto da mensagem de quem NÃO é o remetente enquanto o pombo ainda está voando.
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

// Envolve rotas async pra erros caírem no handler de erro do Express
function wrap(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ------------------------------------------------------------
// ROTAS - USUÁRIOS
// ------------------------------------------------------------

// Registro
app.post('/api/users', wrap(async (req, res) => {
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

  const exists = await qOne('SELECT id FROM users WHERE username = $1', [username]);
  if (exists) {
    return res.status(409).json({ error: 'Esse username já existe.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const user = await qOne(
    `INSERT INTO users (username, password_hash, latitude, longitude, last_location_change)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [username, hash, latitude, longitude]
  );

  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
}));

// Login
app.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username e password são obrigatórios.' });
  }
  const user = await qOne('SELECT * FROM users WHERE username = $1', [username]);
  if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
}));

// Listar usuários (para escolher destinatário)
app.get('/api/users', authMiddleware, wrap(async (req, res) => {
  const users = await q('SELECT * FROM users ORDER BY id ASC');
  res.json(users.map(publicUser));
}));

// Dados do usuário logado
app.get('/api/me', authMiddleware, wrap(async (req, res) => {
  const user = await qOne('SELECT * FROM users WHERE id = $1', [req.userId]);
  res.json(publicUser(user));
}));

// Atualizar localização (simulada) - respeita cooldown de 7 dias
app.put('/api/users/location', authMiddleware, wrap(async (req, res) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'latitude e longitude são obrigatórios.' });
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'Localização inválida.' });
  }

  const user = await qOne('SELECT * FROM users WHERE id = $1', [req.userId]);
  const lastChange = new Date(user.last_location_change || user.created_at).getTime();
  const nextChangeAt = lastChange + LOCATION_COOLDOWN_MS;
  const now = Date.now();

  if (now < nextChangeAt) {
    const faltamMs = nextChangeAt - now;
    const faltamHoras = Math.ceil(faltamMs / (60 * 60 * 1000));
    const faltamDias = Math.floor(faltamHoras / 24);
    const horasRestantes = faltamHoras % 24;
    const mensagem = faltamDias > 0
      ? `Você só pode trocar de localização novamente em ${faltamDias}d ${horasRestantes}h.`
      : `Você só pode trocar de localização novamente em ${faltamHoras}h.`;
    return res.status(429).json({
      error: mensagem,
      nextLocationChangeAt: new Date(nextChangeAt).toISOString()
    });
  }

  const updated = await qOne(
    `UPDATE users SET latitude = $1, longitude = $2, last_location_change = NOW()
     WHERE id = $3 RETURNING *`,
    [latitude, longitude, req.userId]
  );
  res.json(publicUser(updated));
}));

// Comprar/desbloquear um pombo com moedas
app.post('/api/pombos/desbloquear', authMiddleware, wrap(async (req, res) => {
  const { tipo } = req.body;
  const pombo = await qOne('SELECT * FROM pombos WHERE tipo = $1', [tipo]);
  if (!pombo) return res.status(404).json({ error: 'Pombo não encontrado.' });

  const user = await qOne('SELECT * FROM users WHERE id = $1', [req.userId]);
  const desbloqueados = JSON.parse(user.pombos_desbloqueados || '[]');

  if (desbloqueados.includes(tipo)) {
    return res.status(400).json({ error: 'Você já desbloqueou esse pombo.' });
  }
  if (user.moedas < pombo.custo_moedas) {
    return res.status(400).json({ error: 'Moedas insuficientes.', necessario: pombo.custo_moedas, atual: user.moedas });
  }

  desbloqueados.push(tipo);
  const updated = await qOne(
    `UPDATE users SET moedas = moedas - $1, pombos_desbloqueados = $2 WHERE id = $3 RETURNING *`,
    [pombo.custo_moedas, JSON.stringify(desbloqueados), req.userId]
  );
  res.json(publicUser(updated));
}));

// ------------------------------------------------------------
// ROTAS - POMBOS (tipos disponíveis)
// ------------------------------------------------------------
app.get('/api/pombos', wrap(async (req, res) => {
  const pombos = await q('SELECT * FROM pombos ORDER BY velocidade ASC');
  res.json(pombos.map(publicPombo));
}));

// ------------------------------------------------------------
// ROTAS - MENSAGENS
// ------------------------------------------------------------

// Enviar mensagem (envia um pombo)
app.post('/api/messages', authMiddleware, wrap(async (req, res) => {
  await atualizarStatusMensagens();

  const { toUserId, mensagem, tipoPombo } = req.body;
  if (!toUserId || !mensagem || !tipoPombo) {
    return res.status(400).json({ error: 'toUserId, mensagem e tipoPombo são obrigatórios.' });
  }
  if (mensagem.length > 500) {
    return res.status(400).json({ error: 'Mensagem muito longa (máx 500 caracteres).' });
  }

  const fromUser = await qOne('SELECT * FROM users WHERE id = $1', [req.userId]);
  const toUser = await qOne('SELECT * FROM users WHERE id = $1', [toUserId]);
  if (!toUser) return res.status(404).json({ error: 'Destinatário não encontrado.' });
  if (toUser.id === fromUser.id) return res.status(400).json({ error: 'Você não pode mandar pombo pra si mesmo.' });

  // Regra: só 1 pombo voando por vez (por remetente)
  const jaVoando = await qOne(
    `SELECT id FROM messages WHERE from_user_id = $1 AND status = 'voando'`,
    [req.userId]
  );
  if (jaVoando) {
    return res.status(409).json({ error: 'Você já tem um pombo voando! Espere ele chegar antes de mandar outro.' });
  }

  const desbloqueados = JSON.parse(fromUser.pombos_desbloqueados || '[]');
  const pombo = await qOne('SELECT * FROM pombos WHERE tipo = $1', [tipoPombo]);
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

  const novaMsgRow = await qOne(
    `INSERT INTO messages
      (from_user_id, to_user_id, mensagem, tipo_pombo, velocidade, distancia, tempo_chegada,
       from_lat, from_lng, to_lat, to_lng, status, entregue_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, ${entregaInstantanea ? 'NOW()' : 'NULL'})
     RETURNING *`,
    [
      req.userId, toUserId, mensagem, tipoPombo, pombo.velocidade, distancia, tempoChegada,
      fromUser.latitude, fromUser.longitude, toUser.latitude, toUser.longitude, status
    ]
  );

  // Recompensa em moedas por enviar (multiplicador do pombo escolhido)
  const moedasGanhas = Math.max(1, Math.round(2 * pombo.multiplicador_moedas));
  await pool.query('UPDATE users SET moedas = moedas + $1 WHERE id = $2', [moedasGanhas, req.userId]);

  res.status(201).json({ mensagem: publicMessage(novaMsgRow), moedasGanhas });
}));

// Mensagens trocadas com um usuário específico (histórico do chat)
app.get('/api/messages/:userId', authMiddleware, wrap(async (req, res) => {
  await atualizarStatusMensagens();
  const otherId = parseInt(req.params.userId, 10);
  const msgs = await q(
    `SELECT * FROM messages
     WHERE (from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1)
     ORDER BY created_at ASC`,
    [req.userId, otherId]
  );
  res.json(sanitizeMessages(msgs.map(publicMessage), req.userId));
}));

// Todas as mensagens "voando" no momento (pra mapa mundi / feed público)
app.get('/api/messages/status/voando', authMiddleware, wrap(async (req, res) => {
  await atualizarStatusMensagens();
  const msgs = await q(`
    SELECT m.*, uf.username as from_username, ut.username as to_username
    FROM messages m
    JOIN users uf ON uf.id = m.from_user_id
    JOIN users ut ON ut.id = m.to_user_id
    WHERE m.status = 'voando'
    ORDER BY m.created_at DESC
  `);
  res.json(msgs.map(publicMessage));
}));

// Feed público de TODAS as mensagens em trânsito ou recentes (todo mundo pode ver quem manda pra quem, sem o texto)
app.get('/api/feed', authMiddleware, wrap(async (req, res) => {
  await atualizarStatusMensagens();
  const msgs = await q(`
    SELECT m.id, m.from_user_id, m.to_user_id, m.tipo_pombo, m.velocidade, m.distancia,
           m.tempo_chegada, m.from_lat, m.from_lng, m.to_lat, m.to_lng, m.status, m.created_at, m.entregue_em,
           uf.username as from_username, ut.username as to_username
    FROM messages m
    JOIN users uf ON uf.id = m.from_user_id
    JOIN users ut ON ut.id = m.to_user_id
    ORDER BY m.created_at DESC
    LIMIT 200
  `);
  // feed público não expõe texto de mensagem em nenhum caso
  res.json(msgs.map(m => {
    const pub = publicMessage(m);
    delete pub.mensagem;
    return pub;
  }));
}));

// Minhas mensagens pendentes (recebidas, ainda voando, endereçadas a mim)
app.get('/api/messages/pendentes/minhas', authMiddleware, wrap(async (req, res) => {
  await atualizarStatusMensagens();
  const msgs = await q(`
    SELECT m.*, uf.username as from_username
    FROM messages m
    JOIN users uf ON uf.id = m.from_user_id
    WHERE m.to_user_id = $1 AND m.status = 'voando'
    ORDER BY m.created_at DESC
  `, [req.userId]);
  res.json(sanitizeMessages(msgs.map(publicMessage), req.userId));
}));

// Lista de conversas (chats) do usuário logado, com última mensagem
app.get('/api/chats', authMiddleware, wrap(async (req, res) => {
  await atualizarStatusMensagens();
  const msgs = await q(`
    SELECT m.*, uf.username as from_username, ut.username as to_username
    FROM messages m
    JOIN users uf ON uf.id = m.from_user_id
    JOIN users ut ON ut.id = m.to_user_id
    WHERE m.from_user_id = $1 OR m.to_user_id = $1
    ORDER BY m.created_at DESC
  `, [req.userId]);

  const chatsMap = {};
  for (const row of msgs) {
    const m = publicMessage(row);
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
}));

// ------------------------------------------------------------
// HEALTHCHECK (para o UptimeRobot)
// ------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pombo-correio-backend', time: new Date().toISOString() });
});
app.get('/api/health', wrap(async (req, res) => {
  await atualizarStatusMensagens();
  res.json({ status: 'ok', time: new Date().toISOString() });
}));

// ------------------------------------------------------------
// Handler de erro genérico (evita o processo cair silenciosamente)
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

// ------------------------------------------------------------
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🐦 Pombo Correio backend rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Falha ao inicializar o banco de dados:', err);
    process.exit(1);
  });
