const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function uid(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 100; tries++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function normalizeTurnLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(15, Math.min(600, Math.round(n)));
}

function normalizeMaxPlayers(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 2;
  return Math.max(2, Math.min(4, n));
}

function normalizeAiCount(value, maxPlayers) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.max(0, Math.min(maxPlayers - 1, n));
}

function makePlayer(name, isAI = false) {
  return {
    id: uid(),
    name,
    hand: [],
    initialDone: false,
    streams: new Set(),
    isAI,
  };
}

function makePool() {
  const colors = ['red', 'blue', 'yellow', 'black'];
  const tiles = [];
  let id = 1;
  for (let copy = 0; copy < 2; copy++) {
    for (const color of colors) {
      for (let value = 1; value <= 13; value++) {
        tiles.push({ id: `t${id++}`, color, value, joker: false });
      }
    }
  }
  tiles.push({ id: `t${id++}`, color: 'joker', value: 0, joker: true });
  tiles.push({ id: `t${id++}`, color: 'joker', value: 0, joker: true });
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

function cloneMelds(melds) {
  return melds.map(m => m.map(t => ({ ...t })));
}

function meldScore(meld) {
  const non = meld.filter(t => !t.joker);
  if (!isValidMeld(meld)) return 0;
  if (non.length === 0) return 0;
  const sameNumber = non.every(t => t.value === non[0].value);
  if (sameNumber) return non[0].value * meld.length;

  // For a run, choose the highest valid start. This gives a joker the value it
  // can legally represent and is favorable to the player for the initial 30.
  const n = meld.length;
  const vals = non.map(t => t.value);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const startMin = Math.max(1, maxV - n + 1);
  const startMax = Math.min(minV, 14 - n);
  if (startMin > startMax) return 0;
  const start = startMax;
  return n * (2 * start + n - 1) / 2;
}

function isValidGroup(meld) {
  if (meld.length < 3 || meld.length > 4) return false;
  const non = meld.filter(t => !t.joker);
  if (non.length === 0) return false;
  const number = non[0].value;
  if (!non.every(t => t.value === number)) return false;
  const colors = non.map(t => t.color);
  return new Set(colors).size === colors.length;
}

function isValidRun(meld) {
  if (meld.length < 3 || meld.length > 13) return false;
  const non = meld.filter(t => !t.joker);
  if (non.length === 0) return false;
  if (!non.every(t => t.color === non[0].color)) return false;
  const vals = non.map(t => t.value);
  if (new Set(vals).size !== vals.length) return false;
  const n = meld.length;
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const startMin = Math.max(1, maxV - n + 1);
  const startMax = Math.min(minV, 14 - n);
  return startMin <= startMax;
}

function isValidMeld(meld) {
  return isValidGroup(meld) || isValidRun(meld);
}

function colorRank(color) {
  return ({ red: 0, blue: 1, yellow: 2, black: 3, joker: 4 })[color] ?? 9;
}

// Keep every public-table meld in a predictable visual order.
// Runs are shown in ascending number order, with jokers placed in the number
// position they represent. Groups have the same number, so colors provide a
// stable secondary order and jokers appear last. Invalid in-progress melds
// still show ordinary numbered tiles from low to high.
function sortMeldForDisplay(meld) {
  const copy = meld.map(t => ({ ...t }));
  if (copy.length < 2) return copy;

  if (isValidRun(copy)) {
    const non = copy.filter(t => !t.joker);
    const jokers = copy.filter(t => t.joker);
    const n = copy.length;
    const vals = non.map(t => t.value);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const startMin = Math.max(1, maxV - n + 1);
    const startMax = Math.min(minV, 14 - n);
    const start = startMax;
    const byValue = new Map(non.map(t => [t.value, t]));
    let ji = 0;
    const ordered = [];
    for (let value = start; value < start + n; value++) {
      ordered.push(byValue.get(value) || jokers[ji++]);
    }
    return ordered;
  }

  if (isValidGroup(copy)) {
    return copy.sort((a, b) => {
      if (a.joker !== b.joker) return a.joker ? 1 : -1;
      return colorRank(a.color) - colorRank(b.color);
    });
  }

  return copy.sort((a, b) => {
    if (a.joker !== b.joker) return a.joker ? 1 : -1;
    return a.value - b.value || colorRank(a.color) - colorRank(b.color);
  });
}

function sortTableForDisplay(melds) {
  return melds.map(sortMeldForDisplay);
}

function flattenIds(melds) {
  return melds.flat().map(t => t.id);
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

function handSubset(proposedHand, oldHand) {
  const old = new Set(oldHand.map(t => t.id));
  const ids = proposedHand.map(t => t.id);
  return ids.length === new Set(ids).size && ids.every(id => old.has(id));
}

function exactPrefixMelds(proposed, old) {
  if (proposed.length < old.length) return false;
  for (let i = 0; i < old.length; i++) {
    const a = proposed[i].map(t => t.id);
    const b = old[i].map(t => t.id);
    if (a.length !== b.length || !a.every((id, j) => id === b[j])) return false;
  }
  return true;
}

function stateFor(room, playerId) {
  const me = room.players.find(p => p.id === playerId);
  if (!me) return null;
  const publicPlayers = room.players.map((p, index) => ({
    id: p.id,
    name: p.name,
    seat: index + 1,
    handCount: p.hand.length,
    initialDone: p.initialDone,
    isAI: !!p.isAI,
    isHost: p.id === room.hostPlayerId,
    isMe: p.id === me.id,
  }));
  const opponents = publicPlayers.filter(p => p.id !== me.id);
  return {
    code: room.code,
    status: room.status,
    turnPlayerId: room.turnPlayerId,
    turnNumber: room.turnNumber,
    turnLimitSec: room.turnLimitSec,
    turnDeadline: room.turnDeadline,
    serverNow: Date.now(),
    lastAction: room.lastAction,
    lastActionAt: room.lastActionAt,
    lastTurnDelta: room.lastTurnDelta,
    poolCount: room.pool.length,
    table: sortTableForDisplay(room.table),
    winnerId: room.winnerId,
    gameNumber: room.gameNumber,
    hostPlayerId: room.hostPlayerId,
    maxPlayers: room.maxPlayers,
    humanSlots: room.humanSlots ?? Math.max(1, room.maxPlayers - room.players.filter(p => p.isAI).length),
    aiCount: room.players.filter(p => p.isAI).length,
    humanCount: room.players.filter(p => !p.isAI).length,
    players: publicPlayers,
    canStart: room.status === 'waiting' && me.id === room.hostPlayerId
      && room.players.length >= 2
      && room.players.filter(p => !p.isAI).length >= (room.humanSlots ?? 1),
    me: {
      id: me.id,
      name: me.name,
      hand: me.hand,
      initialDone: me.initialDone,
      handCount: me.hand.length,
      isHost: me.id === room.hostPlayerId,
    },
    opponents,
    // Kept for backward compatibility with older clients.
    opponent: opponents[0] || null,
  };
}

function broadcast(room) {
  for (const player of room.players) {
    const payload = `data: ${JSON.stringify(stateFor(room, player.id))}\n\n`;
    for (const res of player.streams) {
      try { res.write(payload); } catch (_) {}
    }
  }
}

function createRoom(name, turnLimitSec = 60, maxPlayers = 2, aiCount = 0) {
  const code = roomCode();
  maxPlayers = normalizeMaxPlayers(maxPlayers);
  aiCount = normalizeAiCount(aiCount, maxPlayers);
  const player = makePlayer(name || '플레이어 1', false);
  const room = {
    code,
    status: 'waiting',
    hostPlayerId: player.id,
    maxPlayers,
    humanSlots: Math.max(1, maxPlayers - aiCount),
    players: [player],
    pool: makePool(),
    table: [],
    turnPlayerId: null,
    turnNumber: 0,
    turnLimitSec: normalizeTurnLimit(turnLimitSec),
    turnDeadline: null,
    lastAction: '방이 만들어졌습니다.',
    lastActionAt: Date.now(),
    lastTurnDelta: null,
    winnerId: null,
    gameNumber: 1,
    aiTimer: null,
    createdAt: Date.now(),
  };
  for (let i = 0; i < aiCount; i++) {
    room.players.push(makePlayer(`AI ${i + 1}`, true));
  }
  rooms.set(code, room);
  return { room, player };
}

function startRoom(room, actorName = '') {
  const humanCount = room.players.filter(p => !p.isAI).length;
  if (room.status !== 'waiting' || room.players.length < 2 || humanCount < (room.humanSlots ?? 1)) return false;
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.aiTimer = null;
  room.pool = makePool();
  room.table = [];
  room.winnerId = null;
  room.lastTurnDelta = null;
  room.turnDeadline = null;
  room.turnPlayerId = null;
  room.turnNumber = 0;
  for (const p of room.players) {
    p.hand = room.pool.splice(0, 14);
    p.initialDone = false;
  }
  room.status = 'playing';
  room.turnPlayerId = room.players[Math.floor(Math.random() * room.players.length)].id;
  room.turnNumber = 1;
  room.lastAction = actorName ? `${actorName}님이 게임을 시작했습니다.` : '게임을 시작했습니다.';
  room.lastActionAt = Date.now();
  startTurnClock(room);
  scheduleAITurn(room);
  return true;
}

function reconfigureRoom(room, humanSlots, aiCount, turnLimitSec, actorName = '') {
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.aiTimer = null;

  const humans = room.players.filter(p => !p.isAI);
  humanSlots = Math.max(1, Math.min(4, Math.round(Number(humanSlots) || 1)));
  aiCount = Math.max(0, Math.min(3, Math.round(Number(aiCount) || 0)));
  const total = humanSlots + aiCount;

  if (total < 2 || total > 4) {
    throw new Error('사람과 AI를 합쳐 2~4명으로 설정해 주세요.');
  }

  const host = humans.find(p => p.id === room.hostPlayerId);
  const others = humans.filter(p => p.id !== room.hostPlayerId);
  const orderedHumans = host ? [host, ...others] : humans;
  const keptHumans = orderedHumans.slice(0, humanSlots);
  const removedHumans = orderedHumans.slice(humanSlots);
  const removedPayload = `event: player-removed\ndata: ${JSON.stringify({ message: '방장이 새 게임의 사람 참가자 수를 줄여 현재 방에서 제외되었습니다.' })}\n\n`;
  for (const p of removedHumans) {
    for (const res of p.streams) {
      try { res.write(removedPayload); } catch (_) {}
      try { res.end(); } catch (_) {}
    }
    p.streams.clear();
  }

  room.players = keptHumans;
  for (let i = 0; i < aiCount; i++) room.players.push(makePlayer(`AI ${i + 1}`, true));
  room.humanSlots = humanSlots;
  room.maxPlayers = total;
  room.turnLimitSec = normalizeTurnLimit(turnLimitSec);
  room.gameNumber = (room.gameNumber || 1) + 1;
  room.pool = makePool();
  room.table = [];
  room.winnerId = null;
  room.lastTurnDelta = null;
  room.turnDeadline = null;
  room.turnPlayerId = null;
  room.turnNumber = 0;
  room.status = 'waiting';
  for (const p of room.players) {
    p.hand = [];
    p.initialDone = false;
  }
  room.lastAction = actorName
    ? `${actorName}님이 새 게임 설정을 변경했습니다.`
    : '새 게임 설정을 변경했습니다.';
  room.lastActionAt = Date.now();
}

function endRoomSession(room, actorName = '') {
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.aiTimer = null;
  const message = actorName
    ? `${actorName}님이 게임 세션을 종료했습니다.`
    : '게임 세션이 종료되었습니다.';
  const payload = `event: session-ended\ndata: ${JSON.stringify({ message })}\n\n`;
  for (const p of room.players) {
    for (const res of p.streams) {
      try { res.write(payload); } catch (_) {}
      try { res.end(); } catch (_) {}
    }
    p.streams.clear();
  }
  rooms.delete(room.code);
  return message;
}

function startTurnClock(room) {
  room.turnDeadline = room.turnLimitSec > 0 ? Date.now() + room.turnLimitSec * 1000 : null;
}

function nextTurn(room, actionText = '') {
  if (room.players.length) {
    const currentIndex = room.players.findIndex(p => p.id === room.turnPlayerId);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % room.players.length;
    room.turnPlayerId = room.players[nextIndex].id;
  }
  room.turnNumber++;
  if (actionText) {
    room.lastAction = actionText;
    room.lastActionAt = Date.now();
  }
  startTurnClock(room);
  scheduleAITurn(room);
}

function handleTurnTimeout(room) {
  if (room.status !== 'playing' || !room.turnDeadline || Date.now() < room.turnDeadline) return false;
  const player = room.players.find(p => p.id === room.turnPlayerId);
  if (!player) return false;

  // Draft moves exist only in the browser until a successful commit, so timing out
  // safely discards the draft. The player draws one tile when possible, otherwise passes.
  if (room.pool.length > 0) {
    player.hand.push(room.pool.pop());
    room.lastTurnDelta = { actorId: player.id, addedTileIds: [], changedTileIds: [] };
    nextTurn(room, `${player.name}님이 시간 초과로 타일 1장을 뽑고 턴을 넘겼습니다.`);
  } else {
    room.lastTurnDelta = { actorId: player.id, addedTileIds: [], changedTileIds: [] };
    nextTurn(room, `${player.name}님이 시간 초과로 자동 패스했습니다.`);
  }
  broadcast(room);
  return true;
}

function meldSignatureMap(melds) {
  const map = new Map();
  for (const meld of melds) {
    const sig = meld.map(t => t.id).sort().join('|');
    for (const tile of meld) map.set(tile.id, sig);
  }
  return map;
}

function computeTableDelta(oldTable, newTable, actorId) {
  const oldIds = new Set(flattenIds(oldTable));
  const newIds = new Set(flattenIds(newTable));
  const addedTileIds = [...newIds].filter(id => !oldIds.has(id));
  const before = meldSignatureMap(oldTable);
  const after = meldSignatureMap(newTable);
  const changedTileIds = [...oldIds].filter(id => newIds.has(id) && before.get(id) !== after.get(id));
  return { actorId, addedTileIds, changedTileIds };
}

function combinations(items, k) {
  const out = [];
  const pick = [];
  function walk(start) {
    if (pick.length === k) {
      out.push(pick.map(i => items[i]));
      return;
    }
    for (let i = start; i <= items.length - (k - pick.length); i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  }
  walk(0);
  return out;
}

// The AI intentionally favors simple, understandable play: it forms legal 3/4-tile
// melds from its own rack, then (after its initial 30) extends existing table melds.
function aiCandidateMelds(hand) {
  const out = [];
  const seen = new Set();
  for (const k of [3, 4]) {
    if (hand.length < k) continue;
    for (const combo of combinations(hand, k)) {
      if (!isValidMeld(combo)) continue;
      const key = combo.map(t => t.id).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(combo);
    }
  }
  return out.sort((a, b) => meldScore(b) - meldScore(a) || b.length - a.length);
}

function chooseDisjointMelds(hand, requireScore30) {
  const candidates = aiCandidateMelds(hand);
  let best = null;
  function dfs(index, used, chosen, score, count) {
    if ((!requireScore30 || score >= 30) && (!best || count > best.count || (count === best.count && score > best.score))) {
      best = { melds: chosen.map(m => m.slice()), score, count };
    }
    if (index >= candidates.length) return;
    for (let i = index; i < candidates.length; i++) {
      const meld = candidates[i];
      if (meld.some(t => used.has(t.id))) continue;
      const nextUsed = new Set(used);
      for (const t of meld) nextUsed.add(t.id);
      dfs(i + 1, nextUsed, [...chosen, meld], score + meldScore(meld), count + meld.length);
    }
  }
  dfs(0, new Set(), [], 0, 0);
  return best;
}

function takeTilesFromHand(hand, ids) {
  const set = new Set(ids);
  return hand.filter(t => !set.has(t.id));
}

function performAITurn(room) {
  if (room.status !== 'playing') return;
  const ai = room.players.find(p => p.id === room.turnPlayerId && p.isAI);
  if (!ai) return;

  const oldTable = cloneMelds(room.table);
  let table = cloneMelds(room.table);
  let hand = ai.hand.map(t => ({ ...t }));
  let playedAny = false;

  if (!ai.initialDone) {
    const choice = chooseDisjointMelds(hand, true);
    if (choice && choice.score >= 30 && choice.melds.length) {
      const ids = choice.melds.flat().map(t => t.id);
      table.push(...choice.melds.map(m => m.map(t => ({ ...t }))));
      hand = takeTilesFromHand(hand, ids);
      ai.initialDone = true;
      playedAny = true;
    }
  } else {
    // First, greedily extend existing table melds one tile at a time.
    let progress = true;
    while (progress) {
      progress = false;
      outer: for (let hi = 0; hi < hand.length; hi++) {
        for (let mi = 0; mi < table.length; mi++) {
          const candidate = [...table[mi], hand[hi]];
          if (isValidMeld(candidate)) {
            table[mi] = candidate;
            hand.splice(hi, 1);
            playedAny = true;
            progress = true;
            break outer;
          }
        }
      }
    }
    const choice = chooseDisjointMelds(hand, false);
    if (choice && choice.melds.length) {
      const ids = choice.melds.flat().map(t => t.id);
      table.push(...choice.melds.map(m => m.map(t => ({ ...t }))));
      hand = takeTilesFromHand(hand, ids);
      playedAny = true;
    }
  }

  if (playedAny && table.every(isValidMeld)) {
    room.table = sortTableForDisplay(table);
    ai.hand = hand;
    room.lastTurnDelta = computeTableDelta(oldTable, room.table, ai.id);
    if (ai.hand.length === 0) {
      room.status = 'finished';
      room.winnerId = ai.id;
      room.turnDeadline = null;
      room.lastAction = `${ai.name}가 모든 타일을 내려놓아 승리했습니다.`;
      room.lastActionAt = Date.now();
      broadcast(room);
      return;
    }
    nextTurn(room, `${ai.name}가 턴을 마쳤습니다.`);
  } else if (room.pool.length > 0) {
    ai.hand.push(room.pool.pop());
    room.lastTurnDelta = { actorId: ai.id, addedTileIds: [], changedTileIds: [] };
    nextTurn(room, `${ai.name}가 타일 1장을 뽑고 턴을 넘겼습니다.`);
  } else {
    room.lastTurnDelta = { actorId: ai.id, addedTileIds: [], changedTileIds: [] };
    nextTurn(room, `${ai.name}가 패스했습니다.`);
  }
  broadcast(room);
}

function scheduleAITurn(room) {
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.aiTimer = null;
  if (room.status !== 'playing') return;
  const ai = room.players.find(p => p.id === room.turnPlayerId && p.isAI);
  if (!ai) return;
  const expectedTurn = room.turnNumber;
  room.aiTimer = setTimeout(() => {
    room.aiTimer = null;
    if (room.status === 'playing' && room.turnNumber === expectedTurn && room.turnPlayerId === ai.id) {
      performAITurn(room);
    }
  }, 900);
}

function tileMapForRoom(room) {
  const map = new Map();
  for (const t of room.pool) map.set(t.id, t);
  for (const p of room.players) for (const t of p.hand) map.set(t.id, t);
  for (const t of room.table.flat()) map.set(t.id, t);
  return map;
}

function sanitizeProposedMelds(raw, map) {
  if (!Array.isArray(raw)) throw new Error('잘못된 테이블 데이터입니다.');
  return raw.map(m => {
    if (!Array.isArray(m) || m.length === 0) throw new Error('빈 묶음은 둘 수 없습니다.');
    return m.map(x => {
      const id = typeof x === 'string' ? x : x && x.id;
      const tile = map.get(id);
      if (!tile) throw new Error('알 수 없는 타일이 포함되어 있습니다.');
      return tile;
    });
  });
}

function sanitizeHand(raw, oldHand) {
  if (!Array.isArray(raw)) throw new Error('잘못된 패 데이터입니다.');
  const map = new Map(oldHand.map(t => [t.id, t]));
  return raw.map(x => {
    const id = typeof x === 'string' ? x : x && x.id;
    const tile = map.get(id);
    if (!tile) throw new Error('내 패에 없는 타일입니다.');
    return tile;
  });
}

function validateCommit(room, player, proposedTable, proposedHand) {
  const oldHand = player.hand;
  if (!handSubset(proposedHand, oldHand)) throw new Error('내 패의 구성이 올바르지 않습니다.');

  const playedIds = oldHand.map(t => t.id).filter(id => !proposedHand.some(t => t.id === id));
  if (playedIds.length === 0) throw new Error('적어도 한 개의 타일을 내려놓아야 합니다.');

  if (!proposedTable.every(isValidMeld)) {
    throw new Error('테이블의 모든 묶음은 유효한 그룹 또는 연속이어야 합니다.');
  }

  const oldTableIds = flattenIds(room.table);
  const proposedTableIds = flattenIds(proposedTable);
  const expectedTableIds = [...oldTableIds, ...playedIds];
  if (!sameIds(proposedTableIds, expectedTableIds)) {
    throw new Error('테이블 타일의 수가 맞지 않습니다. 기존 타일을 패로 가져가거나 타일을 잃어버릴 수 없습니다.');
  }

  if (!player.initialDone) {
    if (!exactPrefixMelds(proposedTable, room.table)) {
      throw new Error('첫 등록 전에는 기존 테이블을 재배치할 수 없습니다.');
    }
    const newMelds = proposedTable.slice(room.table.length);
    const newIds = flattenIds(newMelds);
    if (!sameIds(newIds, playedIds)) {
      throw new Error('첫 등록은 내 패의 타일만 사용해야 합니다.');
    }
    const score = newMelds.reduce((sum, m) => sum + meldScore(m), 0);
    if (score < 30) throw new Error(`첫 등록 합계가 ${score}점입니다. 30점 이상이어야 합니다.`);
  }
  return playedIds;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('요청이 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('JSON 형식이 올바르지 않습니다.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = path.normalize(rel).replace(/^\.\.(\/|\\)/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/manifest+json; charset=utf-8',
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/create') {
      const body = await readBody(req);
      const { room, player } = createRoom(
        String(body.name || '').trim().slice(0, 20),
        body.turnLimitSec,
        body.maxPlayers,
        body.aiCount
      );
      return json(res, 200, { code: room.code, playerId: player.id, state: stateFor(room, player.id) });
    }

    if (req.method === 'POST' && pathname === '/api/join') {
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: '방을 찾을 수 없습니다.' });
      if (room.status !== 'waiting') return json(res, 409, { error: '이미 시작된 방입니다.' });
      const currentHumans = room.players.filter(p => !p.isAI).length;
      const humanSlots = room.humanSlots ?? Math.max(1, room.maxPlayers - room.players.filter(p => p.isAI).length);
      if (currentHumans >= humanSlots) return json(res, 409, { error: '이 방의 사람 참가자 자리가 모두 찼습니다.' });
      const humanNumber = currentHumans + 1;
      const player = makePlayer(String(body.name || `플레이어 ${humanNumber}`).trim().slice(0, 20) || `플레이어 ${humanNumber}`, false);
      room.players.push(player);
      room.lastAction = `${player.name}님이 방에 들어왔습니다.`;
      room.lastActionAt = Date.now();
      broadcast(room);
      return json(res, 200, { code: room.code, playerId: player.id, state: stateFor(room, player.id) });
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      const playerId = url.searchParams.get('player');
      if (!room) return json(res, 404, { error: '방을 찾을 수 없습니다.' });
      const state = stateFor(room, playerId);
      if (!state) return json(res, 403, { error: '플레이어 정보가 올바르지 않습니다.' });
      return json(res, 200, state);
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      const playerId = url.searchParams.get('player');
      if (!room) return json(res, 404, { error: '방을 찾을 수 없습니다.' });
      const player = room.players.find(p => p.id === playerId);
      if (!player) return json(res, 403, { error: '플레이어 정보가 올바르지 않습니다.' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(stateFor(room, playerId))}\n\n`);
      player.streams.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
      }, 20000);
      req.on('close', () => {
        clearInterval(keepAlive);
        player.streams.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readBody(req);
      const room = rooms.get(String(body.room || '').toUpperCase());
      if (!room) return json(res, 404, { error: '방을 찾을 수 없습니다.' });
      const player = room.players.find(p => p.id === body.playerId);
      if (!player) return json(res, 403, { error: '플레이어 정보가 올바르지 않습니다.' });

      if (body.type === 'start') {
        if (player.id !== room.hostPlayerId) return json(res, 403, { error: '방장만 게임을 시작할 수 있습니다.' });
        if (room.status !== 'waiting') return json(res, 409, { error: '이미 게임이 시작되었습니다.' });
        if (room.players.length < 2) return json(res, 409, { error: '최소 2명이 있어야 게임을 시작할 수 있습니다.' });
        const humanCount = room.players.filter(p => !p.isAI).length;
        if (humanCount < (room.humanSlots ?? 1)) return json(res, 409, { error: `사람 참가자 ${room.humanSlots}명이 모두 들어와야 시작할 수 있습니다.` });
        startRoom(room, player.name);
        broadcast(room);
        return json(res, 200, stateFor(room, player.id));
      }

      if (body.type === 'reconfigure') {
        if (player.id !== room.hostPlayerId) return json(res, 403, { error: '방장만 새 게임 설정을 바꿀 수 있습니다.' });
        try {
          reconfigureRoom(room, body.humanSlots, body.aiCount, body.turnLimitSec, player.name);
        } catch (e) {
          return json(res, 400, { error: e.message || '새 게임 설정을 적용할 수 없습니다.' });
        }
        broadcast(room);
        return json(res, 200, stateFor(room, player.id));
      }

      if (body.type === 'endSession') {
        if (player.id !== room.hostPlayerId) return json(res, 403, { error: '방장만 세션을 종료할 수 있습니다.' });
        const message = endRoomSession(room, player.name);
        return json(res, 200, { ok: true, message });
      }

      handleTurnTimeout(room);
      if (room.status !== 'playing') return json(res, 409, { error: '현재 게임을 진행할 수 없습니다.' });
      if (room.turnPlayerId !== player.id) return json(res, 409, { error: '내 차례가 아니거나 제한 시간이 끝났습니다.' });

      if (body.type === 'draw') {
        if (room.pool.length === 0) return json(res, 409, { error: '더 이상 뽑을 타일이 없습니다. 패스 버튼을 사용하세요.' });
        player.hand.push(room.pool.pop());
        room.lastTurnDelta = { actorId: player.id, addedTileIds: [], changedTileIds: [] };
        nextTurn(room, `${player.name}님이 타일 1장을 뽑고 턴을 넘겼습니다.`);
        broadcast(room);
        return json(res, 200, stateFor(room, player.id));
      }

      if (body.type === 'pass') {
        if (room.pool.length > 0) return json(res, 409, { error: '타일이 남아 있을 때는 패스할 수 없습니다. 한 장을 뽑아주세요.' });
        room.lastTurnDelta = { actorId: player.id, addedTileIds: [], changedTileIds: [] };
        nextTurn(room, `${player.name}님이 패스했습니다.`);
        broadcast(room);
        return json(res, 200, stateFor(room, player.id));
      }

      if (body.type === 'commit') {
        const map = tileMapForRoom(room);
        const proposedTable = sanitizeProposedMelds(body.table, map);
        const proposedHand = sanitizeHand(body.hand, player.hand);
        validateCommit(room, player, proposedTable, proposedHand);
        const oldTable = cloneMelds(room.table);
        room.table = sortTableForDisplay(cloneMelds(proposedTable));
        room.lastTurnDelta = computeTableDelta(oldTable, room.table, player.id);
        player.hand = proposedHand.map(t => ({ ...t }));
        player.initialDone = true;
        if (player.hand.length === 0) {
          room.status = 'finished';
          room.winnerId = player.id;
          room.turnDeadline = null;
          room.lastAction = `${player.name}님이 모든 타일을 내려놓아 승리했습니다.`;
          room.lastActionAt = Date.now();
        } else {
          nextTurn(room, `${player.name}님이 턴을 마쳤습니다.`);
        }
        broadcast(room);
        return json(res, 200, stateFor(room, player.id));
      }

      return json(res, 400, { error: '알 수 없는 동작입니다.' });
    }

    if (serveStatic(req, res, pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    json(res, 400, { error: err.message || '요청 처리 중 오류가 발생했습니다.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`2-4 player Rummikub server running on http://localhost:${PORT}`);
});

// Server-authoritative turn timer. Browser countdowns are only visual;
// this loop is what actually advances an expired turn.
setInterval(() => {
  for (const room of rooms.values()) handleTurnTimeout(room);
}, 250).unref();

// Remove very old empty/finished rooms from memory.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 24 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 60 * 60 * 1000).unref();
