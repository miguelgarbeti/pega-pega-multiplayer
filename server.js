'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;

// --- Configurações do Jogo e Física (Autoridade do Servidor) ---
const CONFIG = {
  VIEW_WIDTH: 960,
  VIEW_HEIGHT: 600,
  PLAYER_RADIUS: 18,
  FLAG_RADIUS: 28,
  TAG_MARGIN: 8, // Margem justa para evitar falhas quando jogadores andam juntos
  SPEED_RUNNER: 245,
  SPEED_TAGGER: 270,
  TICK_RATE: 30, // Simulação fixa: 30 Hz
  BROADCAST_RATE: 25, // Envio de estado: 25 Hz (40ms) para menor latência visual
  MAX_PLAYERS_PER_ROOM: 8,
  MIN_PLAYERS_TO_START: 2,
  ROUND_DURATION_SEC: 75,
  ROUND_END_PAUSE_MS: 5000,
  TAG_COOLDOWN_MS: 1200,
  START_IMMUNITY_MS: 2000,
  SURVIVAL_POINTS_PER_SEC: 2,
  FLAG_CAPTURE_POINTS: 100,
  TAG_BONUS_POINTS: 35,
  MAX_INPUTS_PER_SEC: 90,
};

const TICK_DT = 1 / CONFIG.TICK_RATE;
const TICK_INTERVAL_MS = 1000 / CONFIG.TICK_RATE;
const BROADCAST_INTERVAL_MS = 1000 / CONFIG.BROADCAST_RATE;

// --- Variedade de Mapas Maiores (1600 x 1000) ---
const MAPS = [
  {
    id: 'ruinas_centrais',
    name: 'Ruínas Centrais',
    width: 1600,
    height: 1000,
    theme: {
      bg: '#0f172a',
      grid: 'rgba(148, 163, 184, 0.07)',
      obsFill: '#1e293b',
      obsStroke: '#475569',
    },
    obstacles: [
      { x: 220, y: 170, w: 180, h: 64 },
      { x: 1200, y: 170, w: 180, h: 64 },
      { x: 220, y: 766, w: 180, h: 64 },
      { x: 1200, y: 766, w: 180, h: 64 },
      { x: 520, y: 310, w: 72, h: 380 },
      { x: 1008, y: 310, w: 72, h: 380 },
      { x: 720, y: 160, w: 160, h: 56 },
      { x: 720, y: 784, w: 160, h: 56 },
    ],
    spawns: [
      { x: 90, y: 90 },
      { x: 1510, y: 910 },
      { x: 1510, y: 90 },
      { x: 90, y: 910 },
      { x: 800, y: 80 },
      { x: 800, y: 920 },
      { x: 90, y: 500 },
      { x: 1510, y: 500 },
    ],
    flagPoints: [
      { x: 800, y: 500 },
      { x: 310, y: 500 },
      { x: 1290, y: 500 },
      { x: 800, y: 280 },
      { x: 800, y: 720 },
      { x: 140, y: 280 },
      { x: 1460, y: 720 },
    ],
  },
  {
    id: 'labirinto_tatico',
    name: 'Labirinto Tático',
    width: 1600,
    height: 1000,
    theme: {
      bg: '#091521',
      grid: 'rgba(56, 189, 248, 0.06)',
      obsFill: '#12263a',
      obsStroke: '#0284c7',
    },
    obstacles: [
      // Paredes em L externas sem becos sem saída
      { x: 200, y: 180, w: 220, h: 52 },
      { x: 200, y: 232, w: 52, h: 170 },
      { x: 1180, y: 180, w: 220, h: 52 },
      { x: 1348, y: 232, w: 52, h: 170 },
      { x: 200, y: 768, w: 220, h: 52 },
      { x: 200, y: 598, w: 52, h: 170 },
      { x: 1180, y: 768, w: 220, h: 52 },
      { x: 1348, y: 598, w: 52, h: 170 },
      // Núcleo com múltiplas passagens
      { x: 640, y: 270, w: 320, h: 52 },
      { x: 640, y: 678, w: 320, h: 52 },
      { x: 470, y: 420, w: 56, h: 160 },
      { x: 1074, y: 420, w: 56, h: 160 },
    ],
    spawns: [
      { x: 100, y: 100 },
      { x: 1500, y: 900 },
      { x: 1500, y: 100 },
      { x: 100, y: 900 },
      { x: 800, y: 120 },
      { x: 800, y: 880 },
      { x: 100, y: 500 },
      { x: 1500, y: 500 },
    ],
    flagPoints: [
      { x: 800, y: 500 },
      { x: 350, y: 340 },
      { x: 1250, y: 340 },
      { x: 350, y: 660 },
      { x: 1250, y: 660 },
      { x: 800, y: 170 },
      { x: 800, y: 830 },
    ],
  },
  {
    id: 'complexo_cruzado',
    name: 'Complexo Cruzado',
    width: 1600,
    height: 1000,
    theme: {
      bg: '#13111c',
      grid: 'rgba(192, 132, 252, 0.06)',
      obsFill: '#231c35',
      obsStroke: '#7e22ce',
    },
    obstacles: [
      // Quatro grandes quadrantes com corredores amplos no meio e bordas
      { x: 260, y: 200, w: 340, h: 160 },
      { x: 1000, y: 200, w: 340, h: 160 },
      { x: 260, y: 640, w: 340, h: 160 },
      { x: 1000, y: 640, w: 340, h: 160 },
      // Pilar central quebrando linha reta
      { x: 752, y: 452, w: 96, h: 96 },
    ],
    spawns: [
      { x: 100, y: 500 },
      { x: 1500, y: 500 },
      { x: 800, y: 90 },
      { x: 800, y: 910 },
      { x: 120, y: 100 },
      { x: 1480, y: 900 },
      { x: 1480, y: 100 },
      { x: 120, y: 900 },
    ],
    flagPoints: [
      { x: 800, y: 280 },
      { x: 800, y: 720 },
      { x: 430, y: 500 },
      { x: 1170, y: 500 },
      { x: 140, y: 280 },
      { x: 1460, y: 720 },
      { x: 1460, y: 280 },
      { x: 140, y: 720 },
    ],
  },
  {
    id: 'arquipelago_torres',
    name: 'Ilhas e Torres',
    width: 1600,
    height: 1000,
    theme: {
      bg: '#0c1a17',
      grid: 'rgba(52, 211, 153, 0.06)',
      obsFill: '#132a24',
      obsStroke: '#059669',
    },
    obstacles: [
      { x: 240, y: 220, w: 100, h: 100 },
      { x: 540, y: 140, w: 100, h: 100 },
      { x: 960, y: 140, w: 100, h: 100 },
      { x: 1260, y: 220, w: 100, h: 100 },
      { x: 380, y: 450, w: 120, h: 100 },
      { x: 740, y: 440, w: 120, h: 120 },
      { x: 1100, y: 450, w: 120, h: 100 },
      { x: 240, y: 680, w: 100, h: 100 },
      { x: 540, y: 760, w: 100, h: 100 },
      { x: 960, y: 760, w: 100, h: 100 },
      { x: 1260, y: 680, w: 100, h: 100 },
    ],
    spawns: [
      { x: 90, y: 500 },
      { x: 1510, y: 500 },
      { x: 120, y: 110 },
      { x: 1480, y: 890 },
      { x: 1480, y: 110 },
      { x: 120, y: 890 },
      { x: 800, y: 90 },
      { x: 800, y: 910 },
    ],
    flagPoints: [
      { x: 800, y: 240 },
      { x: 800, y: 760 },
      { x: 590, y: 500 },
      { x: 1010, y: 500 },
      { x: 290, y: 500 },
      { x: 1310, y: 500 },
      { x: 800, y: 80 },
      { x: 800, y: 920 },
    ],
  },
];

const MAPS_BY_ID = new Map(MAPS.map((m) => [m.id, m]));

const PLAYER_COLORS = [
  '#38bdf8', // Azul claro
  '#34d399', // Verde esmeralda
  '#fbbf24', // Âmbar
  '#c084fc', // Roxo
  '#fb7185', // Rosa
  '#2dd4bf', // Turquesa
  '#f97316', // Laranja
  '#a3e635', // Lima
];

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
const publicDir = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : fs.existsSync(path.join(__dirname, 'Public', 'index.html'))
    ? path.join(__dirname, 'Public')
    : null;

if (publicDir) {
  app.use(express.static(publicDir));
} else {
  // Fallback seguro caso index.html, style.css e game.js tenham sido enviados na raiz
  const flatAssets = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/style.css': 'style.css',
    '/game.js': 'game.js',
  };
  for (const [route, file] of Object.entries(flatAssets)) {
    app.get(route, (req, res, next) => {
      const target = path.join(__dirname, file);
      if (fs.existsSync(target)) {
        return res.sendFile(target);
      }
      return next();
    });
  }
}

app.get('/', (req, res) => {
  res
    .status(404)
    .send('Arquivo public/index.html não encontrado no deploy. Verifique se a pasta public foi enviada para o GitHub.');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingInterval: 10000,
  pingTimeout: 5000,
});

/** @type {Map<string, object>} */
const rooms = new Map();

// --- Utilitários e Validação ---

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round1(val) {
  return Math.round(val * 10) / 10;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Jogador';
  const cleaned = raw.replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Jogador';
}

function sanitizeRoomCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) return null;
  return code;
}

function sanitizeMapSelection(raw) {
  if (raw === 'random') return 'random';
  if (typeof raw === 'string' && MAPS_BY_ID.has(raw)) return raw;
  return 'random';
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < 5; i += 1) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function isValidInputPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const { seq, up, down, left, right } = payload;
  if (!Number.isInteger(seq) || seq < 0 || seq > 1e9) return false;
  if (
    typeof up !== 'boolean' ||
    typeof down !== 'boolean' ||
    typeof left !== 'boolean' ||
    typeof right !== 'boolean'
  ) {
    return false;
  }
  return true;
}

// --- Física Compartilhada (Círculo vs Limites e Obstáculos AABB) ---

function resolveCircleObstacles(player, map) {
  const r = CONFIG.PLAYER_RADIUS;
  const obstacles = map.obstacles;

  for (let i = 0; i < obstacles.length; i += 1) {
    const rect = obstacles[i];
    const closestX = clamp(player.x, rect.x, rect.x + rect.w);
    const closestY = clamp(player.y, rect.y, rect.y + rect.h);
    const dx = player.x - closestX;
    const dy = player.y - closestY;
    const distSq = dx * dx + dy * dy;

    if (distSq < r * r) {
      if (distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const overlap = r - dist;
        player.x += (dx / dist) * overlap;
        player.y += (dy / dist) * overlap;
      } else {
        const leftPen = player.x - rect.x;
        const rightPen = rect.x + rect.w - player.x;
        const topPen = player.y - rect.y;
        const bottomPen = rect.y + rect.h - player.y;
        const minPen = Math.min(leftPen, rightPen, topPen, bottomPen);
        if (minPen === leftPen) player.x = rect.x - r;
        else if (minPen === rightPen) player.x = rect.x + rect.w + r;
        else if (minPen === topPen) player.y = rect.y - r;
        else player.y = rect.y + rect.h + r;
      }
    }
  }

  player.x = clamp(player.x, r, map.width - r);
  player.y = clamp(player.y, r, map.height - r);
}

function stepPlayerPhysics(player, speed, dt, map = MAPS[0]) {
  let vx = (player.input.right ? 1 : 0) - (player.input.left ? 1 : 0);
  let vy = (player.input.down ? 1 : 0) - (player.input.up ? 1 : 0);

  if (vx !== 0 && vy !== 0) {
    const invSqrt2 = Math.SQRT1_2;
    vx *= invSqrt2;
    vy *= invSqrt2;
  }

  const prevX = player.x;
  const prevY = player.y;
  player.prevX = prevX;
  player.prevY = prevY;

  player.x += vx * speed * dt;
  player.y += vy * speed * dt;

  // Garantia estrita de velocidade máxima e limites
  const maxStep = speed * dt + 0.01;
  const stepDx = player.x - prevX;
  const stepDy = player.y - prevY;
  const stepDist = Math.hypot(stepDx, stepDy);
  if (stepDist > maxStep) {
    player.x = prevX + (stepDx / stepDist) * maxStep;
    player.y = prevY + (stepDy / stepDist) * maxStep;
  }

  resolveCircleObstacles(player, map);
}

// --- Distância mínima contínua entre dois jogadores durante o tick ---
function minDistanceSqInTick(p1, p2) {
  const p1MidX = ((p1.prevX ?? p1.x) + p1.x) * 0.5;
  const p1MidY = ((p1.prevY ?? p1.y) + p1.y) * 0.5;
  const p2MidX = ((p2.prevX ?? p2.x) + p2.x) * 0.5;
  const p2MidY = ((p2.prevY ?? p2.y) + p2.y) * 0.5;

  const endDistSq = (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2;
  const midDistSq = (p1MidX - p2MidX) ** 2 + (p1MidY - p2MidY) ** 2;
  return Math.min(endDistSq, midDistSq);
}

// --- Gerenciamento de Mapas, Bandeiras, Salas e Rodadas ---

function pickNextMap(room) {
  if (room.mapSelection !== 'random' && MAPS_BY_ID.has(room.mapSelection)) {
    return MAPS_BY_ID.get(room.mapSelection);
  }
  const candidates =
    MAPS.length > 1 && room.map
      ? MAPS.filter((m) => m.id !== room.map.id)
      : MAPS;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickNextFlag(map, previousFlag = null) {
  const points = map.flagPoints;
  let candidates = points;

  if (previousFlag) {
    // Prefere pontos distantes da bandeira anterior (>= 450px) para incentivar corrida
    const farPoints = points.filter(
      (pt) => Math.hypot(pt.x - previousFlag.x, pt.y - previousFlag.y) >= 450
    );
    if (farPoints.length > 0) {
      candidates = farPoints;
    } else {
      candidates = points.filter(
        (pt) => pt.x !== previousFlag.x || pt.y !== previousFlag.y
      );
    }
  }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)] || points[0];
  return {
    x: chosen.x,
    y: chosen.y,
    radius: CONFIG.FLAG_RADIUS,
  };
}

function isPointClearOfObstacles(x, y, margin, map) {
  for (let i = 0; i < map.obstacles.length; i += 1) {
    const rect = map.obstacles[i];
    const cx = clamp(x, rect.x, rect.x + rect.w);
    const cy = clamp(y, rect.y, rect.y + rect.h);
    if (Math.hypot(x - cx, y - cy) < margin) {
      return false;
    }
  }
  return true;
}

function pickRandomSafePosition(map, avoidPlayer) {
  const pad = CONFIG.PLAYER_RADIUS + 24;
  const clearRadius = CONFIG.PLAYER_RADIUS + 6;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const x = pad + Math.random() * (map.width - pad * 2);
    const y = pad + Math.random() * (map.height - pad * 2);
    if (!isPointClearOfObstacles(x, y, clearRadius, map)) continue;
    if (avoidPlayer && Math.hypot(x - avoidPlayer.x, y - avoidPlayer.y) < 260) {
      continue;
    }
    return { x, y };
  }

  // Fallback: escolhe o spawn mais distante de quem pegou
  const spawns = map.spawns;
  if (!avoidPlayer) {
    const s = spawns[Math.floor(Math.random() * spawns.length)];
    return { x: s.x, y: s.y };
  }
  const sorted = [...spawns].sort(
    (a, b) =>
      Math.hypot(b.x - avoidPlayer.x, b.y - avoidPlayer.y) -
      Math.hypot(a.x - avoidPlayer.x, a.y - avoidPlayer.y)
  );
  const topCandidates = sorted.slice(0, Math.min(3, sorted.length));
  const chosen = topCandidates[Math.floor(Math.random() * topCandidates.length)];
  return { x: chosen.x, y: chosen.y };
}

function serializeMap(map) {
  return {
    id: map.id,
    name: map.name,
    width: map.width,
    height: map.height,
    theme: map.theme,
    obstacles: map.obstacles,
  };
}

function createRoom(code, mapSelection) {
  const initialMap =
    mapSelection !== 'random' && MAPS_BY_ID.has(mapSelection)
      ? MAPS_BY_ID.get(mapSelection)
      : MAPS[0];

  const room = {
    code,
    mapSelection,
    map: initialMap,
    flag: pickNextFlag(initialMap),
    status: 'waiting', // 'waiting' | 'playing' | 'round_end'
    players: new Map(),
    taggerId: null,
    tagImmuneUntil: 0,
    roundEndsAt: 0,
    roundResetAt: 0,
    lastRemainingSec: CONFIG.ROUND_DURATION_SEC,
    lastScoreBroadcastAt: 0,
    scoresDirty: false,
    scoreAccumulator: 0,
  };
  rooms.set(code, room);
  return room;
}

function getAvailableColor(room) {
  const used = new Set();
  for (const p of room.players.values()) {
    used.add(p.color);
  }
  return PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
}

function getSpawnPoint(map, index) {
  return map.spawns[index % map.spawns.length];
}

function serializePlayerMeta(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    x: round1(player.x),
    y: round1(player.y),
    score: Math.floor(player.score),
    captures: player.captures,
    wins: player.wins,
  };
}

function buildScoresMap(room) {
  const scores = {};
  for (const p of room.players.values()) {
    scores[p.id] = {
      s: Math.floor(p.score),
      c: p.captures,
      w: p.wins,
    };
  }
  return scores;
}

function buildClientConfig(room) {
  return {
    viewWidth: CONFIG.VIEW_WIDTH,
    viewHeight: CONFIG.VIEW_HEIGHT,
    playerRadius: CONFIG.PLAYER_RADIUS,
    speedRunner: CONFIG.SPEED_RUNNER,
    speedTagger: CONFIG.SPEED_TAGGER,
    maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
    roundDurationSec: CONFIG.ROUND_DURATION_SEC,
    map: serializeMap(room.map),
  };
}

function startRound(room, now) {
  const playerList = Array.from(room.players.values());
  if (playerList.length < CONFIG.MIN_PLAYERS_TO_START) {
    room.status = 'waiting';
    room.taggerId = null;
    return;
  }

  room.map = pickNextMap(room);
  room.flag = pickNextFlag(room.map);

  playerList.forEach((p, idx) => {
    const sp = getSpawnPoint(room.map, idx);
    p.x = sp.x;
    p.y = sp.y;
    p.prevX = sp.x;
    p.prevY = sp.y;
    p.score = 0;
    p.captures = 0;
    p.input = { up: false, down: false, left: false, right: false };
    p.dirty = true;
  });

  if (!room.taggerId || !room.players.has(room.taggerId)) {
    const chosen = playerList[Math.floor(Math.random() * playerList.length)];
    room.taggerId = chosen.id;
  }

  room.status = 'playing';
  room.roundEndsAt = now + CONFIG.ROUND_DURATION_SEC * 1000;
  room.tagImmuneUntil = now + CONFIG.START_IMMUNITY_MS;
  room.lastRemainingSec = CONFIG.ROUND_DURATION_SEC;
  room.scoresDirty = false;
  room.scoreAccumulator = 0;

  io.to(room.code).emit('game:round_start', {
    status: room.status,
    taggerId: room.taggerId,
    remainingSec: CONFIG.ROUND_DURATION_SEC,
    immuneMs: CONFIG.START_IMMUNITY_MS,
    map: serializeMap(room.map),
    flag: room.flag,
    players: playerList.map(serializePlayerMeta),
  });
}

function endRound(room, now) {
  room.status = 'round_end';
  room.roundResetAt = now + CONFIG.ROUND_END_PAUSE_MS;

  const ranking = Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: Math.floor(p.score),
      captures: p.captures,
      isTagger: p.id === room.taggerId,
    }));

  const winner = ranking[0] || null;
  if (winner && room.players.has(winner.id)) {
    room.players.get(winner.id).wins += 1;
  }

  io.to(room.code).emit('game:round_end', {
    winner,
    ranking,
    scores: buildScoresMap(room),
    nextRoundInMs: CONFIG.ROUND_END_PAUSE_MS,
  });
}

function handlePlayerLeave(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  socket.data.roomCode = null;
  socket.leave(roomCode);

  if (!room || !room.players.has(socket.id)) return;

  const leavingPlayer = room.players.get(socket.id);
  const wasTagger = room.taggerId === socket.id;
  room.players.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  let newTaggerId = room.taggerId;
  let newStatus = room.status;

  if (room.players.size < CONFIG.MIN_PLAYERS_TO_START) {
    room.status = 'waiting';
    room.taggerId = null;
    newTaggerId = null;
    newStatus = 'waiting';
  } else if (wasTagger) {
    const remaining = Array.from(room.players.values());
    const nextTagger = remaining[Math.floor(Math.random() * remaining.length)];
    room.taggerId = nextTagger.id;
    room.tagImmuneUntil = Date.now() + CONFIG.TAG_COOLDOWN_MS;
    newTaggerId = nextTagger.id;

    io.to(room.code).emit('game:tag', {
      newTaggerId: nextTagger.id,
      previousTaggerId: leavingPlayer.id,
      reason: 'disconnect',
      immuneMs: CONFIG.TAG_COOLDOWN_MS,
      scores: buildScoresMap(room),
    });
  }

  io.to(room.code).emit('room:player_left', {
    playerId: socket.id,
    playerName: leavingPlayer.name,
    status: newStatus,
    taggerId: newTaggerId,
  });
}

// --- Eventos Socket.io ---

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.inputWindowStart = Date.now();
  socket.data.inputCount = 0;

  socket.on('room:create', (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    if (socket.data.roomCode) {
      handlePlayerLeave(socket);
    }

    const name = sanitizeName(payload && payload.name);
    const mapSelection = sanitizeMapSelection(payload && payload.mapId);
    const code = generateRoomCode();
    const room = createRoom(code, mapSelection);

    const sp = getSpawnPoint(room.map, 0);
    const player = {
      id: socket.id,
      name,
      color: getAvailableColor(room),
      x: sp.x,
      y: sp.y,
      prevX: sp.x,
      prevY: sp.y,
      score: 0,
      captures: 0,
      wins: 0,
      input: { up: false, down: false, left: false, right: false },
      lastSeq: 0,
      dirty: true,
      lastSentX: sp.x,
      lastSentY: sp.y,
      lastSentSeq: 0,
    };

    room.players.set(socket.id, player);
    socket.data.roomCode = code;
    socket.join(code);

    respond({
      ok: true,
      code,
      playerId: socket.id,
      config: buildClientConfig(room),
      roomState: {
        status: room.status,
        taggerId: room.taggerId,
        remainingSec: CONFIG.ROUND_DURATION_SEC,
        immuneMs: 0,
        flag: room.flag,
        players: [serializePlayerMeta(player)],
      },
    });
  });

  socket.on('room:join', (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    const code = sanitizeRoomCode(payload && payload.code);
    if (!code) {
      return respond({ ok: false, error: 'Código de sala inválido.' });
    }

    const room = rooms.get(code);
    if (!room) {
      return respond({ ok: false, error: 'Sala não encontrada.' });
    }

    if (room.players.size >= CONFIG.MAX_PLAYERS_PER_ROOM) {
      return respond({
        ok: false,
        error: `Sala cheia (máximo de ${CONFIG.MAX_PLAYERS_PER_ROOM} jogadores).`,
      });
    }

    if (socket.data.roomCode) {
      handlePlayerLeave(socket);
    }

    const name = sanitizeName(payload && payload.name);
    const sp = getSpawnPoint(room.map, room.players.size);
    const player = {
      id: socket.id,
      name,
      color: getAvailableColor(room),
      x: sp.x,
      y: sp.y,
      prevX: sp.x,
      prevY: sp.y,
      score: 0,
      captures: 0,
      wins: 0,
      input: { up: false, down: false, left: false, right: false },
      lastSeq: 0,
      dirty: true,
      lastSentX: sp.x,
      lastSentY: sp.y,
      lastSentSeq: 0,
    };

    room.players.set(socket.id, player);
    socket.data.roomCode = code;
    socket.join(code);

    const now = Date.now();
    const remainingSec =
      room.status === 'playing'
        ? Math.max(0, Math.ceil((room.roundEndsAt - now) / 1000))
        : CONFIG.ROUND_DURATION_SEC;

    respond({
      ok: true,
      code,
      playerId: socket.id,
      config: buildClientConfig(room),
      roomState: {
        status: room.status,
        taggerId: room.taggerId,
        remainingSec,
        immuneMs: Math.max(0, room.tagImmuneUntil - now),
        flag: room.flag,
        players: Array.from(room.players.values()).map(serializePlayerMeta),
      },
    });

    socket.to(code).emit('room:player_joined', {
      player: serializePlayerMeta(player),
    });

    if (
      room.status === 'waiting' &&
      room.players.size >= CONFIG.MIN_PLAYERS_TO_START
    ) {
      startRound(room, now);
    }
  });

  socket.on('room:leave', () => {
    handlePlayerLeave(socket);
  });

  socket.on('player:input', (payload) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const now = Date.now();
    if (now - socket.data.inputWindowStart >= 1000) {
      socket.data.inputWindowStart = now;
      socket.data.inputCount = 0;
    }
    socket.data.inputCount += 1;
    if (socket.data.inputCount > CONFIG.MAX_INPUTS_PER_SEC) {
      return;
    }

    if (!isValidInputPayload(payload)) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    if (payload.seq < player.lastSeq) return;

    player.lastSeq = payload.seq;
    player.input.up = payload.up;
    player.input.down = payload.down;
    player.input.left = payload.left;
    player.input.right = payload.right;
  });

  socket.on('disconnect', () => {
    handlePlayerLeave(socket);
  });
});

// --- Loop Fixo de Simulação (30 Hz) e Broadcast Enxuto (25 Hz) ---

function simulateTick(now) {
  for (const room of rooms.values()) {
    if (room.status === 'round_end') {
      if (now >= room.roundResetAt) {
        if (room.players.size >= CONFIG.MIN_PLAYERS_TO_START) {
          startRound(room, now);
        } else {
          room.status = 'waiting';
          room.taggerId = null;
        }
      }
      continue;
    }

    for (const player of room.players.values()) {
      const isTagger = room.status === 'playing' && player.id === room.taggerId;
      const speed = isTagger ? CONFIG.SPEED_TAGGER : CONFIG.SPEED_RUNNER;
      stepPlayerPhysics(player, speed, TICK_DT, room.map);
    }

    if (room.status !== 'playing') continue;

    // Pontuação leve de sobrevivência
    room.scoreAccumulator += TICK_DT;
    if (room.scoreAccumulator >= 0.5) {
      const pointsGain = CONFIG.SURVIVAL_POINTS_PER_SEC * room.scoreAccumulator;
      room.scoreAccumulator = 0;
      for (const player of room.players.values()) {
        if (player.id !== room.taggerId) {
          player.score += pointsGain;
        }
      }
      room.scoresDirty = true;
    }

    // 1. Detecção de colisão Pegador vs Fugitivos (com checagem contínua e margem justa)
    if (now >= room.tagImmuneUntil && room.taggerId) {
      const tagger = room.players.get(room.taggerId);
      if (tagger) {
        const tagRadius = CONFIG.PLAYER_RADIUS * 2 + CONFIG.TAG_MARGIN;
        const tagDistSq = tagRadius * tagRadius;
        for (const target of room.players.values()) {
          if (target.id === tagger.id) continue;
          if (minDistanceSqInTick(tagger, target) <= tagDistSq) {
            tagger.score += CONFIG.TAG_BONUS_POINTS;
            room.taggerId = target.id;
            room.tagImmuneUntil = now + CONFIG.TAG_COOLDOWN_MS;
            room.scoresDirty = true;

            // Teleporta quem foi pego para um lugar aleatório seguro do mapa
            const nextPos = pickRandomSafePosition(room.map, tagger);
            target.x = nextPos.x;
            target.y = nextPos.y;
            target.prevX = nextPos.x;
            target.prevY = nextPos.y;
            target.dirty = true;

            io.to(room.code).emit('game:tag', {
              newTaggerId: target.id,
              previousTaggerId: tagger.id,
              newTaggerPos: { x: round1(target.x), y: round1(target.y) },
              reason: 'tag',
              immuneMs: CONFIG.TAG_COOLDOWN_MS,
              scores: buildScoresMap(room),
            });
            break;
          }
        }
      }
    }

    // 2. Captura da Bandeira (Pique-Bandeira: corredores vão de encontro ao ponto)
    if (room.flag) {
      const captureRadius = CONFIG.PLAYER_RADIUS + room.flag.radius;
      const captureDistSq = captureRadius * captureRadius;
      for (const player of room.players.values()) {
        if (player.id === room.taggerId) continue; // Pegador não captura bandeira
        const dx = player.x - room.flag.x;
        const dy = player.y - room.flag.y;
        if (dx * dx + dy * dy <= captureDistSq) {
          player.score += CONFIG.FLAG_CAPTURE_POINTS;
          player.captures += 1;
          room.flag = pickNextFlag(room.map, room.flag);
          room.scoresDirty = true;

          io.to(room.code).emit('game:flag_captured', {
            capturerId: player.id,
            capturerName: player.name,
            points: CONFIG.FLAG_CAPTURE_POINTS,
            flag: room.flag,
            scores: buildScoresMap(room),
          });
          break;
        }
      }
    }

    // 3. Fim da rodada por tempo
    if (now >= room.roundEndsAt) {
      endRound(room, now);
    }
  }
}

function broadcastSnapshots(now) {
  for (const room of rooms.values()) {
    if (room.players.size === 0 || room.status === 'round_end') continue;

    const updates = [];
    for (const p of room.players.values()) {
      const rx = round1(p.x);
      const ry = round1(p.y);
      const moved = rx !== p.lastSentX || ry !== p.lastSentY;
      const seqChanged = p.lastSeq !== p.lastSentSeq;

      if (p.dirty || moved || seqChanged) {
        updates.push([p.id, rx, ry, p.lastSeq]);
        p.lastSentX = rx;
        p.lastSentY = ry;
        p.lastSentSeq = p.lastSeq;
        p.dirty = false;
      }
    }

    const payload = { ts: now };
    let hasData = false;

    if (updates.length > 0) {
      payload.p = updates;
      hasData = true;
    }

    if (room.status === 'playing') {
      const rem = Math.max(0, Math.ceil((room.roundEndsAt - now) / 1000));
      if (rem !== room.lastRemainingSec) {
        room.lastRemainingSec = rem;
        payload.rem = rem;
        hasData = true;
      }
      if (room.scoresDirty && now - room.lastScoreBroadcastAt >= 500) {
        payload.sc = buildScoresMap(room);
        room.scoresDirty = false;
        room.lastScoreBroadcastAt = now;
        hasData = true;
      }
    }

    if (hasData) {
      io.to(room.code).emit('game:state', payload);
    }
  }
}

let simTimer = null;
let netTimer = null;

function startLoops() {
  if (!simTimer) {
    simTimer = setInterval(() => simulateTick(Date.now()), TICK_INTERVAL_MS);
  }
  if (!netTimer) {
    netTimer = setInterval(
      () => broadcastSnapshots(Date.now()),
      BROADCAST_INTERVAL_MS
    );
  }
}

function stopLoops() {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
  if (netTimer) {
    clearInterval(netTimer);
    netTimer = null;
  }
}

if (require.main === module) {
  startLoops();
  server.listen(PORT, () => {
    console.log(`Servidor Pique-Bandeira rodando em http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  io,
  rooms,
  CONFIG,
  MAPS,
  startLoops,
  stopLoops,
  stepPlayerPhysics,
  minDistanceSqInTick,
  isValidInputPayload,
  sanitizeName,
  sanitizeRoomCode,
};
