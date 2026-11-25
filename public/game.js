(() => {
  'use strict';

  const socket = io();

  // --- Constantes de Sincronização no Cliente ---
  const SIM_TICK_RATE = 30;
  const FIXED_DT = 1 / SIM_TICK_RATE;
  const INTERP_DELAY_MS = 75; // Buffer enxuto (25Hz = 40ms/tick) reduzindo defasagem visual
  const MAX_EXTRAPOLATION_MS = 70;
  const SNAPSHOT_BUFFER_SIZE = 16;

  // --- Elementos da UI ---
  const lobbyScreen = document.getElementById('lobby-screen');
  const gameScreen = document.getElementById('game-screen');
  const playerNameInput = document.getElementById('player-name');
  const mapSelectInput = document.getElementById('map-select');
  const roomCodeInput = document.getElementById('room-code');
  const btnCreate = document.getElementById('btn-create');
  const btnJoin = document.getElementById('btn-join');
  const lobbyError = document.getElementById('lobby-error');

  const hudRoomCode = document.getElementById('hud-room-code');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const hudMapName = document.getElementById('hud-map-name');
  const hudStatus = document.getElementById('hud-status');
  const hudTaggerBanner = document.getElementById('hud-tagger-banner');
  const hudTaggerName = document.getElementById('hud-tagger-name');
  const hudTimer = document.getElementById('hud-timer');
  const btnMute = document.getElementById('btn-mute');
  const btnLeave = document.getElementById('btn-leave');

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const eventToast = document.getElementById('event-toast');
  const arenaOverlay = document.getElementById('arena-overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlaySubtitle = document.getElementById('overlay-subtitle');
  const overlayRanking = document.getElementById('overlay-ranking');
  const playerListEl = document.getElementById('player-list');
  const playerCountEl = document.getElementById('player-count');

  // --- Estado da Sessão e Jogo ---
  let config = {
    viewWidth: 960,
    viewHeight: 600,
    playerRadius: 18,
    speedRunner: 245,
    speedTagger: 270,
    maxPlayers: 8,
    roundDurationSec: 75,
    map: {
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
      obstacles: [],
    },
  };

  let inRoom = false;
  let roomCode = '';
  let localPlayerId = null;
  let roomStatus = 'waiting';
  let taggerId = null;
  let tagImmuneUntil = 0;
  let remainingSec = 75;
  let roomFlag = null;
  let flagCaptureFlash = null; // { x, y, until }

  const camera = { x: 0, y: 0 };

  /** @type {Map<string, object>} */
  const players = new Map();

  // Estado de predição e reconciliação do jogador local
  const keysPressed = new Set();
  const currentInput = { up: false, down: false, left: false, right: false };
  let inputSeq = 0;
  let pendingInputs = [];
  let simAccumulator = 0;
  let lastFrameTime = performance.now();
  let lastLocalInputSent = { up: false, down: false, left: false, right: false };

  let toastTimeout = null;
  let muted = false;
  let audioCtx = null;

  // --- Áudio Sintético (Web Audio API, sem arquivos externos) ---
  function playTone(freq, durationSec, type = 'sine', volume = 0.08) {
    if (muted) return;
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audioCtx.currentTime + durationSec
      );
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + durationSec);
    } catch {
      // Ignora caso áudio esteja bloqueado pelo navegador
    }
  }

  // --- Utilitários de Física (idênticos ao servidor para predição fiel) ---
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function resolveCircleObstacles(pos) {
    const r = config.playerRadius;
    const map = config.map;
    const obstacles = map.obstacles;

    for (let i = 0; i < obstacles.length; i += 1) {
      const rect = obstacles[i];
      const closestX = clamp(pos.x, rect.x, rect.x + rect.w);
      const closestY = clamp(pos.y, rect.y, rect.y + rect.h);
      const dx = pos.x - closestX;
      const dy = pos.y - closestY;
      const distSq = dx * dx + dy * dy;

      if (distSq < r * r) {
        if (distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          const overlap = r - dist;
          pos.x += (dx / dist) * overlap;
          pos.y += (dy / dist) * overlap;
        } else {
          const leftPen = pos.x - rect.x;
          const rightPen = rect.x + rect.w - pos.x;
          const topPen = pos.y - rect.y;
          const bottomPen = rect.y + rect.h - pos.y;
          const minPen = Math.min(leftPen, rightPen, topPen, bottomPen);
          if (minPen === leftPen) pos.x = rect.x - r;
          else if (minPen === rightPen) pos.x = rect.x + rect.w + r;
          else if (minPen === topPen) pos.y = rect.y - r;
          else pos.y = rect.y + rect.h + r;
        }
      }
    }

    pos.x = clamp(pos.x, r, map.width - r);
    pos.y = clamp(pos.y, r, map.height - r);
  }

  function stepPlayerPhysics(pos, input, speed, dt) {
    let vx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let vy = (input.down ? 1 : 0) - (input.up ? 1 : 0);

    if (vx !== 0 && vy !== 0) {
      const invSqrt2 = Math.SQRT1_2;
      vx *= invSqrt2;
      vy *= invSqrt2;
    }

    pos.x += vx * speed * dt;
    pos.y += vy * speed * dt;
    resolveCircleObstacles(pos);
  }

  // --- Gerenciamento de Entradas ---
  function syncInputFlags() {
    currentInput.up =
      keysPressed.has('ArrowUp') || keysPressed.has('KeyW');
    currentInput.down =
      keysPressed.has('ArrowDown') || keysPressed.has('KeyS');
    currentInput.left =
      keysPressed.has('ArrowLeft') || keysPressed.has('KeyA');
    currentInput.right =
      keysPressed.has('ArrowRight') || keysPressed.has('KeyD');
  }

  window.addEventListener('keydown', (e) => {
    if (!inRoom) return;
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(
        e.code
      )
    ) {
      e.preventDefault();
    }
    keysPressed.add(e.code);
    syncInputFlags();
  });

  window.addEventListener('keyup', (e) => {
    keysPressed.delete(e.code);
    syncInputFlags();
  });

  window.addEventListener('blur', () => {
    keysPressed.clear();
    syncInputFlags();
    if (inRoom) {
      sendInputToServer({ up: false, down: false, left: false, right: false });
    }
  });

  function sendInputToServer(input) {
    inputSeq += 1;
    const payload = {
      seq: inputSeq,
      up: input.up,
      down: input.down,
      left: input.left,
      right: input.right,
    };
    socket.emit('player:input', payload);
    lastLocalInputSent = { ...input };
    return inputSeq;
  }

  // --- Helpers de Estado e UI ---
  function showLobbyError(msg) {
    lobbyError.textContent = msg || '';
  }

  function showToast(text, duration = 2200) {
    eventToast.textContent = text;
    eventToast.classList.remove('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      eventToast.classList.add('hidden');
    }, duration);
  }

  function createClientPlayer(meta) {
    const now = performance.now();
    return {
      id: meta.id,
      name: meta.name,
      color: meta.color,
      score: meta.score || 0,
      captures: meta.captures || 0,
      wins: meta.wins || 0,
      x: meta.x,
      y: meta.y,
      prevX: meta.x,
      prevY: meta.y,
      renderX: meta.x,
      renderY: meta.y,
      snapshots: [{ t: now, x: meta.x, y: meta.y }],
    };
  }

  function centerCameraImmediate() {
    const localPlayer = players.get(localPlayerId);
    if (!localPlayer) return;
    const maxCamX = Math.max(0, config.map.width - config.viewWidth);
    const maxCamY = Math.max(0, config.map.height - config.viewHeight);
    camera.x = clamp(localPlayer.renderX - config.viewWidth / 2, 0, maxCamX);
    camera.y = clamp(localPlayer.renderY - config.viewHeight / 2, 0, maxCamY);
  }

  function enterRoom(data) {
    inRoom = true;
    roomCode = data.code;
    localPlayerId = data.playerId;
    config = data.config;

    canvas.width = config.viewWidth;
    canvas.height = config.viewHeight;

    roomStatus = data.roomState.status;
    taggerId = data.roomState.taggerId;
    remainingSec = data.roomState.remainingSec;
    tagImmuneUntil = performance.now() + (data.roomState.immuneMs || 0);
    roomFlag = data.roomState.flag || null;
    flagCaptureFlash = null;

    players.clear();
    data.roomState.players.forEach((p) => {
      players.set(p.id, createClientPlayer(p));
    });

    pendingInputs = [];
    inputSeq = 0;
    keysPressed.clear();
    syncInputFlags();
    centerCameraImmediate();

    lobbyScreen.classList.remove('active');
    gameScreen.classList.add('active');
    hudRoomCode.textContent = roomCode;
    updateHUD();
    renderPlayerList();
  }

  function exitToLobby() {
    inRoom = false;
    roomCode = '';
    localPlayerId = null;
    roomFlag = null;
    players.clear();
    pendingInputs = [];
    keysPressed.clear();
    syncInputFlags();
    gameScreen.classList.remove('active');
    lobbyScreen.classList.add('active');
    arenaOverlay.classList.add('hidden');
  }

  function updateHUD() {
    hudMapName.textContent = config.map ? config.map.name : '—';
    hudTimer.textContent = `${remainingSec}s`;
    hudTimer.classList.toggle('urgent', roomStatus === 'playing' && remainingSec <= 10);

    if (roomStatus === 'waiting') {
      hudStatus.textContent = 'Aguardando jogadores...';
      hudStatus.className = 'status-pill waiting';
      hudTaggerBanner.classList.add('hidden');
      arenaOverlay.classList.remove('hidden');
      overlayTitle.textContent = 'Aguardando jogadores';
      overlaySubtitle.textContent = `Compartilhe o código ${roomCode} para iniciar (mínimo 2 jogadores).`;
      overlayRanking.innerHTML = '';
    } else if (roomStatus === 'playing') {
      hudStatus.textContent = 'Pique-Bandeira em andamento';
      hudStatus.className = 'status-pill playing';
      const tagger = players.get(taggerId);
      if (tagger) {
        hudTaggerBanner.classList.remove('hidden');
        hudTaggerName.textContent =
          tagger.id === localPlayerId ? `${tagger.name} (VOCÊ!)` : tagger.name;
      } else {
        hudTaggerBanner.classList.add('hidden');
      }
      arenaOverlay.classList.add('hidden');
    } else if (roomStatus === 'round_end') {
      hudStatus.textContent = 'Fim da rodada';
      hudStatus.className = 'status-pill waiting';
    }
  }

  function applyScoresMap(scores) {
    if (!scores) return;
    for (const [id, val] of Object.entries(scores)) {
      const p = players.get(id);
      if (p) {
        p.score = val.s;
        p.captures = val.c ?? p.captures;
        p.wins = val.w;
      }
    }
  }

  function renderPlayerList() {
    playerCountEl.textContent = `${players.size}/${config.maxPlayers}`;
    const sorted = Array.from(players.values()).sort((a, b) => b.score - a.score);

    playerListEl.innerHTML = '';
    for (const p of sorted) {
      const li = document.createElement('li');
      const isTagger = roomStatus === 'playing' && p.id === taggerId;
      li.className = `player-item${isTagger ? ' is-tagger' : ''}`;

      const info = document.createElement('div');
      info.className = 'player-info';

      const dot = document.createElement('span');
      dot.className = 'player-dot';
      dot.style.backgroundColor = p.color;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'player-name';
      nameSpan.textContent = p.name;

      info.appendChild(dot);
      info.appendChild(nameSpan);

      const badges = document.createElement('div');
      badges.className = 'badges';
      if (p.id === localPlayerId) {
        const b = document.createElement('span');
        b.className = 'badge badge-you';
        b.textContent = 'VOCÊ';
        badges.appendChild(b);
      }
      if (isTagger) {
        const b = document.createElement('span');
        b.className = 'badge badge-tagger';
        b.textContent = 'PEGADOR';
        badges.appendChild(b);
      }
      info.appendChild(badges);

      const scoreBox = document.createElement('div');
      scoreBox.className = 'player-score';
      scoreBox.textContent = `${p.score} pts`;
      const subSpan = document.createElement('span');
      subSpan.className = 'player-sub';
      subSpan.textContent = `${p.captures} band. • ${p.wins} vit.`;
      scoreBox.appendChild(subSpan);

      li.appendChild(info);
      li.appendChild(scoreBox);
      playerListEl.appendChild(li);
    }
  }

  // --- Eventos de Botões ---
  btnCreate.addEventListener('click', () => {
    showLobbyError('');
    btnCreate.disabled = true;
    socket.emit(
      'room:create',
      { name: playerNameInput.value, mapId: mapSelectInput.value },
      (res) => {
        btnCreate.disabled = false;
        if (!res || !res.ok) {
          showLobbyError((res && res.error) || 'Não foi possível criar a sala.');
          return;
        }
        enterRoom(res);
      }
    );
  });

  function joinRoomAction() {
    showLobbyError('');
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) {
      showLobbyError('Digite o código da sala.');
      return;
    }
    btnJoin.disabled = true;
    socket.emit('room:join', { name: playerNameInput.value, code }, (res) => {
      btnJoin.disabled = false;
      if (!res || !res.ok) {
        showLobbyError((res && res.error) || 'Não foi possível entrar na sala.');
        return;
      }
      enterRoom(res);
    });
  }

  btnJoin.addEventListener('click', joinRoomAction);
  roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoomAction();
  });

  btnCopyCode.addEventListener('click', async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      btnCopyCode.textContent = 'Copiado!';
      setTimeout(() => {
        btnCopyCode.textContent = 'Copiar';
      }, 1500);
    } catch {
      showToast(`Código: ${roomCode}`);
    }
  });

  btnMute.addEventListener('click', () => {
    muted = !muted;
    btnMute.textContent = muted ? 'Som: OFF' : 'Som: ON';
  });

  btnLeave.addEventListener('click', () => {
    socket.emit('room:leave');
    exitToLobby();
  });

  // --- Eventos Socket.io ---
  socket.on('room:player_joined', ({ player }) => {
    if (!inRoom) return;
    players.set(player.id, createClientPlayer(player));
    showToast(`${player.name} entrou na sala!`);
    renderPlayerList();
  });

  socket.on('room:player_left', ({ playerId, playerName, status, taggerId: nextTagger }) => {
    if (!inRoom) return;
    players.delete(playerId);
    roomStatus = status;
    taggerId = nextTagger;
    showToast(`${playerName} saiu da sala.`);
    updateHUD();
    renderPlayerList();
  });

  socket.on('game:round_start', (data) => {
    if (!inRoom) return;
    roomStatus = data.status;
    taggerId = data.taggerId;
    remainingSec = data.remainingSec;
    tagImmuneUntil = performance.now() + (data.immuneMs || 0);
    if (data.map) config.map = data.map;
    roomFlag = data.flag || null;
    flagCaptureFlash = null;
    pendingInputs = [];

    data.players.forEach((meta) => {
      const existing = players.get(meta.id);
      if (existing) {
        existing.score = meta.score;
        existing.captures = meta.captures || 0;
        existing.wins = meta.wins;
        existing.x = meta.x;
        existing.y = meta.y;
        existing.prevX = meta.x;
        existing.prevY = meta.y;
        existing.renderX = meta.x;
        existing.renderY = meta.y;
        existing.snapshots = [{ t: performance.now(), x: meta.x, y: meta.y }];
      } else {
        players.set(meta.id, createClientPlayer(meta));
      }
    });

    centerCameraImmediate();

    const tagger = players.get(taggerId);
    if (tagger) {
      showToast(`Mapa: ${config.map.name} • ${tagger.name} é o PEGADOR!`);
    }
    playTone(520, 0.16, 'triangle');
    updateHUD();
    renderPlayerList();
  });

  socket.on('game:tag', ({ newTaggerId, newTaggerPos, reason, immuneMs, scores }) => {
    if (!inRoom) return;
    taggerId = newTaggerId;
    tagImmuneUntil = performance.now() + (immuneMs || 0);
    applyScoresMap(scores);

    const newTagger = players.get(newTaggerId);
    if (newTagger && newTaggerPos) {
      newTagger.x = newTaggerPos.x;
      newTagger.y = newTaggerPos.y;
      newTagger.prevX = newTaggerPos.x;
      newTagger.prevY = newTaggerPos.y;
      newTagger.renderX = newTaggerPos.x;
      newTagger.renderY = newTaggerPos.y;
      if (newTaggerId === localPlayerId) {
        pendingInputs = [];
        centerCameraImmediate();
      } else {
        newTagger.snapshots = [
          { t: performance.now(), x: newTaggerPos.x, y: newTaggerPos.y },
        ];
      }
    }

    if (newTagger) {
      const msg =
        reason === 'disconnect'
          ? `Pegador saiu! ${newTagger.name} agora é o PEGADOR!`
          : `${newTagger.name} foi pego e teleportado!`;
      showToast(msg);
    }

    playTone(newTaggerId === localPlayerId ? 240 : 660, 0.18, 'sawtooth', 0.07);
    updateHUD();
    renderPlayerList();
  });

  socket.on('game:flag_captured', ({ capturerId, capturerName, points, flag, scores }) => {
    if (!inRoom) return;
    if (roomFlag) {
      flagCaptureFlash = {
        x: roomFlag.x,
        y: roomFlag.y,
        until: performance.now() + 550,
      };
    }
    roomFlag = flag;
    applyScoresMap(scores);

    const who = capturerId === localPlayerId ? 'Você' : capturerName;
    showToast(`${who} capturou a bandeira! (+${points} pts)`);
    playTone(capturerId === localPlayerId ? 880 : 587, 0.16, 'sine', 0.09);
    renderPlayerList();
  });

  socket.on('game:round_end', ({ winner, ranking, scores }) => {
    if (!inRoom) return;
    roomStatus = 'round_end';
    applyScoresMap(scores);

    updateHUD();
    renderPlayerList();

    arenaOverlay.classList.remove('hidden');
    overlayTitle.textContent = winner
      ? `Fim da Rodada! Vencedor: ${winner.name}`
      : 'Fim da Rodada!';
    overlaySubtitle.textContent = 'Próxima rodada começando em instantes...';

    overlayRanking.innerHTML = '';
    ranking.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = `rank-row${idx === 0 ? ' winner' : ''}`;
      const left = document.createElement('span');
      left.textContent = `${idx + 1}º ${entry.name} (${entry.captures} band.)${
        entry.isTagger ? ' • Pegador' : ''
      }`;
      const right = document.createElement('strong');
      right.textContent = `${entry.score} pts`;
      row.appendChild(left);
      row.appendChild(right);
      overlayRanking.appendChild(row);
    });

    playTone(440, 0.25, 'sine');
  });

  socket.on('game:state', (payload) => {
    if (!inRoom) return;
    const now = performance.now();

    if (typeof payload.rem === 'number') {
      remainingSec = payload.rem;
      hudTimer.textContent = `${remainingSec}s`;
      hudTimer.classList.toggle('urgent', roomStatus === 'playing' && remainingSec <= 10);
    }

    if (payload.sc) {
      applyScoresMap(payload.sc);
      renderPlayerList();
    }

    if (!Array.isArray(payload.p)) return;

    for (let i = 0; i < payload.p.length; i += 1) {
      const [id, sx, sy, ackSeq] = payload.p[i];
      const p = players.get(id);
      if (!p) continue;

      if (id === localPlayerId) {
        pendingInputs = pendingInputs.filter((item) => item.seq > ackSeq);
        const reconciled = { x: sx, y: sy };
        for (let j = 0; j < pendingInputs.length; j += 1) {
          const item = pendingInputs[j];
          stepPlayerPhysics(reconciled, item.input, item.speed, FIXED_DT);
        }

        const errX = reconciled.x - p.x;
        const errY = reconciled.y - p.y;
        const errDist = Math.hypot(errX, errY);

        if (errDist > 75) {
          p.x = reconciled.x;
          p.y = reconciled.y;
          p.prevX = reconciled.x;
          p.prevY = reconciled.y;
        } else if (errDist > 3 || (errDist > 0.5 && pendingInputs.length === 0)) {
          p.x += errX * 0.25;
          p.y += errY * 0.25;
        }
      } else {
        const snaps = p.snapshots;
        const lastSnap = snaps[snaps.length - 1];
        if (lastSnap && now - lastSnap.t > 100) {
          snaps.push({ t: now - 40, x: lastSnap.x, y: lastSnap.y });
        }
        snaps.push({ t: now, x: sx, y: sy });
        if (snaps.length > SNAPSHOT_BUFFER_SIZE) {
          snaps.splice(0, snaps.length - SNAPSHOT_BUFFER_SIZE);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    if (inRoom) {
      showToast('Conexão perdida com o servidor. Tentando reconectar...', 4000);
    }
  });

  // --- Loop Principal (Simulação Local Fixa + Interpolação + Câmera + Renderização) ---

  function updateLocalSimulation(dt) {
    const localPlayer = players.get(localPlayerId);
    if (!localPlayer || roomStatus === 'round_end') return;

    simAccumulator = Math.min(simAccumulator + dt, FIXED_DT * 4);

    while (simAccumulator >= FIXED_DT) {
      simAccumulator -= FIXED_DT;
      localPlayer.prevX = localPlayer.x;
      localPlayer.prevY = localPlayer.y;

      const isMoving =
        currentInput.up ||
        currentInput.down ||
        currentInput.left ||
        currentInput.right;
      const inputChanged =
        currentInput.up !== lastLocalInputSent.up ||
        currentInput.down !== lastLocalInputSent.down ||
        currentInput.left !== lastLocalInputSent.left ||
        currentInput.right !== lastLocalInputSent.right;

      if (isMoving || inputChanged) {
        const isTagger =
          roomStatus === 'playing' && localPlayerId === taggerId;
        const speed = isTagger ? config.speedTagger : config.speedRunner;
        const seq = sendInputToServer(currentInput);

        stepPlayerPhysics(localPlayer, currentInput, speed, FIXED_DT);
        pendingInputs.push({
          seq,
          input: { ...currentInput },
          speed,
        });
      }
    }

    const alpha = simAccumulator / FIXED_DT;
    localPlayer.renderX =
      localPlayer.prevX + (localPlayer.x - localPlayer.prevX) * alpha;
    localPlayer.renderY =
      localPlayer.prevY + (localPlayer.y - localPlayer.prevY) * alpha;
  }

  function interpolateRemotePlayers(now) {
    const renderTime = now - INTERP_DELAY_MS;

    for (const p of players.values()) {
      if (p.id === localPlayerId) continue;
      const snaps = p.snapshots;
      if (snaps.length === 0) continue;

      if (renderTime <= snaps[0].t) {
        p.renderX = snaps[0].x;
        p.renderY = snaps[0].y;
        continue;
      }

      const last = snaps[snaps.length - 1];
      if (renderTime >= last.t) {
        if (snaps.length >= 2) {
          const prev = snaps[snaps.length - 2];
          const dtSnap = last.t - prev.t;
          if (dtSnap > 0 && dtSnap <= 100) {
            const extra = Math.min(renderTime - last.t, MAX_EXTRAPOLATION_MS);
            const ratio = extra / dtSnap;
            p.renderX = last.x + (last.x - prev.x) * ratio;
            p.renderY = last.y + (last.y - prev.y) * ratio;
            continue;
          }
        }
        p.renderX = last.x;
        p.renderY = last.y;
        continue;
      }

      for (let i = snaps.length - 1; i >= 1; i -= 1) {
        const s0 = snaps[i - 1];
        const s1 = snaps[i];
        if (s0.t <= renderTime && renderTime <= s1.t) {
          const span = s1.t - s0.t;
          const t = span > 0 ? (renderTime - s0.t) / span : 1;
          p.renderX = s0.x + (s1.x - s0.x) * t;
          p.renderY = s0.y + (s1.y - s0.y) * t;
          break;
        }
      }
    }
  }

  function updateCamera(dt) {
    const localPlayer = players.get(localPlayerId);
    if (!localPlayer) return;

    const maxCamX = Math.max(0, config.map.width - config.viewWidth);
    const maxCamY = Math.max(0, config.map.height - config.viewHeight);
    const targetX = clamp(localPlayer.renderX - config.viewWidth / 2, 0, maxCamX);
    const targetY = clamp(localPlayer.renderY - config.viewHeight / 2, 0, maxCamY);

    const smooth = 1 - Math.exp(-12 * Math.min(dt, 0.05));
    camera.x += (targetX - camera.x) * smooth;
    camera.y += (targetY - camera.y) * smooth;
  }

  function drawFlag(now) {
    if (!roomFlag) return;
    const { x, y, radius } = roomFlag;
    const pulse = 1 + Math.sin(now * 0.006) * 0.12;

    // Zona luminosa de captura
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius * pulse, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.16)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Base da bandeira
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#fde68a';
    ctx.fill();

    // Haste e flâmula animada
    const wave = Math.sin(now * 0.008) * 3;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 34);
    ctx.stroke();

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(x + 1, y - 34);
    ctx.lineTo(x + 24, y - 26 + wave);
    ctx.lineTo(x + 1, y - 16);
    ctx.closePath();
    ctx.fill();

    // Rótulo
    ctx.font = '800 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fde68a';
    ctx.fillText('BANDEIRA', x, y + radius + 4);
    ctx.restore();
  }

  function drawFlagIndicator() {
    if (!roomFlag || roomStatus !== 'playing') return;
    const vw = config.viewWidth;
    const vh = config.viewHeight;
    const screenX = roomFlag.x - camera.x;
    const screenY = roomFlag.y - camera.y;

    // Só desenha seta se a bandeira estiver fora da visão da câmera
    if (screenX >= 24 && screenX <= vw - 24 && screenY >= 24 && screenY <= vh - 24) {
      return;
    }

    const cx = vw / 2;
    const cy = vh / 2;
    const angle = Math.atan2(screenY - cy, screenX - cx);
    const pad = 34;
    const ix = clamp(cx + Math.cos(angle) * (vw / 2 - pad), pad, vw - pad);
    const iy = clamp(cy + Math.sin(angle) * (vh / 2 - pad), pad, vh - pad);

    const distMeters = Math.round(Math.hypot(screenX - cx, screenY - cy) / 20);

    ctx.save();
    ctx.translate(ix, iy);
    ctx.rotate(angle);
    ctx.fillStyle = '#fbbf24';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-9, -9);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-9, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fde68a';
    ctx.fillText(`${distMeters}m`, ix, iy + 18);
    ctx.restore();
  }

  function drawMinimap(now) {
    const map = config.map;
    const mmW = 192;
    const mmH = Math.round((map.height / map.width) * mmW);
    const mmX = config.viewWidth - mmW - 14;
    const mmY = config.viewHeight - mmH - 14;
    const scaleX = mmW / map.width;
    const scaleY = mmH / map.height;

    ctx.save();
    ctx.fillStyle = 'rgba(11, 17, 32, 0.82)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(mmX, mmY, mmW, mmH, 8);
    ctx.fill();
    ctx.stroke();

    // Retângulo da câmera atual no minimapa
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      mmX + camera.x * scaleX,
      mmY + camera.y * scaleY,
      config.viewWidth * scaleX,
      config.viewHeight * scaleY
    );

    // Obstáculos
    ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
    for (let i = 0; i < map.obstacles.length; i += 1) {
      const obs = map.obstacles[i];
      ctx.fillRect(
        mmX + obs.x * scaleX,
        mmY + obs.y * scaleY,
        Math.max(2, obs.w * scaleX),
        Math.max(2, obs.h * scaleY)
      );
    }

    // Bandeira no minimapa
    if (roomFlag) {
      const fx = mmX + roomFlag.x * scaleX;
      const fy = mmY + roomFlag.y * scaleY;
      const pulseR = 4 + Math.sin(now * 0.01) * 1.2;
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(fx, fy, pulseR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Jogadores no minimapa
    for (const p of players.values()) {
      const px = mmX + p.renderX * scaleX;
      const py = mmY + p.renderY * scaleY;
      const isTagger = roomStatus === 'playing' && p.id === taggerId;
      const isLocal = p.id === localPlayerId;

      ctx.fillStyle = isTagger ? '#ef4444' : p.color;
      ctx.beginPath();
      ctx.arc(px, py, isLocal ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();

      if (isLocal) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawArena(now) {
    const map = config.map;
    const vw = config.viewWidth;
    const vh = config.viewHeight;
    const theme = map.theme || {
      bg: '#0f172a',
      grid: 'rgba(148, 163, 184, 0.07)',
      obsFill: '#1e293b',
      obsStroke: '#475569',
    };

    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, vw, vh);

    // --- Mundo com deslocamento de câmera ---
    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Grade tática do mapa
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    const gridSize = 64;
    ctx.beginPath();
    for (let x = gridSize; x < map.width; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, map.height);
    }
    for (let y = gridSize; y < map.height; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(map.width, y);
    }
    ctx.stroke();

    // Borda da arena
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.25)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, map.width, map.height);

    // Efeito visual de captura anterior
    if (flagCaptureFlash && now < flagCaptureFlash.until) {
      const progress = 1 - (flagCaptureFlash.until - now) / 550;
      ctx.save();
      ctx.beginPath();
      ctx.arc(flagCaptureFlash.x, flagCaptureFlash.y, 28 + progress * 55, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(251, 191, 36, ${1 - progress})`;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    }

    // Bandeira
    drawFlag(now);

    // Obstáculos
    for (let i = 0; i < map.obstacles.length; i += 1) {
      const obs = map.obstacles[i];
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.roundRect(obs.x + 4, obs.y + 6, obs.w, obs.h, 8);
      ctx.fill();

      ctx.fillStyle = theme.obsFill;
      ctx.strokeStyle = theme.obsStroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(obs.x, obs.y, obs.w, obs.h, 8);
      ctx.fill();
      ctx.stroke();
    }

    // Jogadores
    const r = config.playerRadius;
    const isImmune = now < tagImmuneUntil;

    for (const p of players.values()) {
      const x = p.renderX;
      const y = p.renderY;
      const isTagger = roomStatus === 'playing' && p.id === taggerId;
      const isLocal = p.id === localPlayerId;

      if (isTagger) {
        const pulse = 1 + Math.sin(now * 0.009) * 0.14;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r * 1.45 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = isImmune
          ? 'rgba(245, 158, 11, 0.22)'
          : 'rgba(239, 68, 68, 0.26)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = isImmune ? '#fbbf24' : '#ef4444';
        ctx.lineWidth = 2.5;
        if (isImmune) ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.arc(x, y + 3, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = isTagger ? '#ef4444' : p.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = isLocal ? 3 : 2;
      ctx.strokeStyle = isLocal ? '#ffffff' : 'rgba(15, 23, 42, 0.85)';
      ctx.stroke();

      if (isTagger) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PEGA', x, y);
      }

      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = isTagger ? `★ ${p.name}` : p.name;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
      const textWidth = ctx.measureText(label).width;
      ctx.fillRect(x - textWidth / 2 - 5, y - r - 23, textWidth + 10, 17);

      ctx.fillStyle = isTagger ? '#fecaca' : '#f8fafc';
      ctx.fillText(label, x, y - r - 8);
    }

    ctx.restore();

    // --- HUD sobreposto no Canvas (seta da bandeira + minimapa) ---
    drawFlagIndicator();
    drawMinimap(now);
  }

  function gameLoop(now) {
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    if (inRoom) {
      updateLocalSimulation(dt);
      interpolateRemotePlayers(now);
      updateCamera(dt);
      drawArena(now);
    }

    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);
})();
