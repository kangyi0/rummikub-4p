const $ = id => document.getElementById(id);

let session = {
  room: localStorage.getItem('rummi.room') || '',
  playerId: localStorage.getItem('rummi.playerId') || '',
};
let serverState = null;
let draft = null;
let eventSource = null;
let dragging = null;
let stateReceivedAt = Date.now();
let handOrder = [];
let lastSoundTurnNumber = null;
let audioCtx = null;
let moveHistory = [];
let pointerDrag = null;
let pointerDropTarget = null;
let lastGameNumber = null;

function handOrderKey() {
  return session.room && session.playerId ? `rummi.handOrder.${session.room}.${session.playerId}` : '';
}

function loadHandOrder() {
  const key = handOrderKey();
  if (!key) return handOrder = [];
  try { handOrder = JSON.parse(localStorage.getItem(key) || '[]'); }
  catch (_) { handOrder = []; }
}

function saveHandOrder() {
  const key = handOrderKey();
  if (key) localStorage.setItem(key, JSON.stringify(handOrder));
}

function clearHandOrder() {
  const key = handOrderKey();
  if (key) localStorage.removeItem(key);
  handOrder = [];
}

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}

function playTurnSound() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  [660, 880].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.11);
    gain.gain.exponentialRampToValueAtTime(0.13, now + i * 0.11 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.14);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + i * 0.11);
    osc.stop(now + i * 0.11 + 0.15);
  });
}

document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

function setScreen(name) {
  for (const id of ['lobby', 'waiting', 'game']) $(id).classList.toggle('hidden', id !== name);
}

function setMessage(text, type = '') {
  const el = $('message');
  el.textContent = text || '';
  el.className = `message ${type}`;
}

async function api(url, body) {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '서버 오류가 발생했습니다.');
  return data;
}

function saveSession(code, playerId) {
  session = { room: code, playerId };
  localStorage.setItem('rummi.room', code);
  localStorage.setItem('rummi.playerId', playerId);
  loadHandOrder();
}

function clearSession() {
  const key = handOrderKey();
  if (key) localStorage.removeItem(key);
  localStorage.removeItem('rummi.room');
  localStorage.removeItem('rummi.playerId');
  session = { room: '', playerId: '' };
  handOrder = [];
}

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/events?room=${encodeURIComponent(session.room)}&player=${encodeURIComponent(session.playerId)}`);
  eventSource.addEventListener('session-ended', e => {
    let message = '게임 세션이 종료되었습니다.';
    try { message = JSON.parse(e.data).message || message; } catch (_) {}
    if (eventSource) eventSource.close();
    eventSource = null;
    clearSession();
    serverState = null;
    draft = null;
    moveHistory = [];
    setScreen('lobby');
    alert(message);
  });
  eventSource.addEventListener('player-removed', e => {
    let message = '현재 방에서 제외되었습니다.';
    try { message = JSON.parse(e.data).message || message; } catch (_) {}
    if (eventSource) eventSource.close();
    eventSource = null;
    clearSession();
    serverState = null;
    draft = null;
    moveHistory = [];
    setScreen('lobby');
    alert(message);
  });
  eventSource.onmessage = e => {
    const state = JSON.parse(e.data);
    const changedTurn = serverState && serverState.turnNumber !== state.turnNumber;
    const changedGame = serverState && serverState.gameNumber !== state.gameNumber;
    serverState = state;
    stateReceivedAt = Date.now();
    if (changedGame) {
      clearHandOrder();
      moveHistory = [];
      lastSoundTurnNumber = null;
    }
    if (!draft || changedGame || changedTurn || state.turnPlayerId !== state.me.id) resetDraft();
    render();
  };
  eventSource.onerror = () => setMessage('서버 연결을 다시 시도하고 있습니다...', 'error');
}

function resetDraft() {
  if (!serverState) return;
  moveHistory = [];
  const handMap = new Map(serverState.me.hand.map(t => [t.id, t]));
  const orderedHand = [];
  for (const id of handOrder) {
    if (handMap.has(id)) {
      orderedHand.push({ ...handMap.get(id) });
      handMap.delete(id);
    }
  }
  for (const tile of serverState.me.hand) {
    if (handMap.has(tile.id)) {
      orderedHand.push({ ...tile });
      handMap.delete(tile.id);
    }
  }
  handOrder = orderedHand.map(t => t.id);
  saveHandOrder();
  draft = {
    hand: orderedHand,
    table: serverState.table.map(m => m.map(t => ({ ...t }))),
  };
}

function isMyTurn() {
  return serverState && serverState.status === 'playing' && serverState.turnPlayerId === serverState.me.id;
}

function canonicalTable(table) {
  return table
    .map(meld => meld.map(t => t.id).sort().join(','))
    .sort();
}

function hasDraftChanges() {
  if (!draft || !serverState) return false;
  const draftHand = draft.hand.map(t => t.id).sort();
  const serverHand = serverState.me.hand.map(t => t.id).sort();
  if (JSON.stringify(draftHand) !== JSON.stringify(serverHand)) return true;
  return JSON.stringify(canonicalTable(draft.table)) !== JSON.stringify(canonicalTable(serverState.table));
}

function snapshotDraft() {
  if (!draft) return null;
  return {
    hand: draft.hand.map(t => ({ ...t })),
    table: draft.table.map(m => m.map(t => ({ ...t }))),
  };
}

function rememberMove() {
  const snap = snapshotDraft();
  if (!snap) return;
  moveHistory.push(snap);
  // A turn cannot realistically need an unlimited undo history.
  if (moveHistory.length > 100) moveHistory.shift();
}

function undoLastMove() {
  if (!isMyTurn() || !moveHistory.length) return;
  draft = moveHistory.pop();
  renderDraft();
  updateActionButtons();
  setMessage('직전 한 수를 원위치로 되돌렸습니다.', 'ok');
}

function colorRank(c) {
  return ({ red: 0, blue: 1, yellow: 2, black: 3, joker: 4 })[c] ?? 9;
}

function isValidGroup(meld) {
  if (meld.length < 3 || meld.length > 4) return false;
  const non = meld.filter(t => !t.joker);
  if (!non.length) return false;
  if (!non.every(t => t.value === non[0].value)) return false;
  return new Set(non.map(t => t.color)).size === non.length;
}

function isValidRun(meld) {
  if (meld.length < 3 || meld.length > 13) return false;
  const non = meld.filter(t => !t.joker);
  if (!non.length) return false;
  if (!non.every(t => t.color === non[0].color)) return false;
  const vals = non.map(t => t.value);
  if (new Set(vals).size !== vals.length) return false;
  const n = meld.length;
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const startMin = Math.max(1, maxV - n + 1);
  const startMax = Math.min(minV, 14 - n);
  return startMin <= startMax;
}

function isValidMeld(m) { return isValidGroup(m) || isValidRun(m); }

function sortMeldForDisplay(meld) {
  const copy = [...meld];
  if (copy.length < 2) return copy;

  if (isValidRun(copy)) {
    const non = copy.filter(t => !t.joker);
    const jokers = copy.filter(t => t.joker);
    const n = copy.length;
    const vals = non.map(t => t.value);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
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

function sortDraftTable() {
  if (!draft) return;
  draft.table = draft.table.map(sortMeldForDisplay);
}

function clearPointerDropHighlight() {
  if (pointerDropTarget) pointerDropTarget.classList.remove('dragover');
  pointerDropTarget = null;
}

function pointerTargetAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const target = hit.closest('.meld, #newMeldZone, #hand');
  if (!target || target.classList.contains('hidden')) return null;
  return target;
}

function updatePointerDropTarget(x, y) {
  const target = pointerTargetAt(x, y);
  if (target === pointerDropTarget) return;
  clearPointerDropHighlight();
  pointerDropTarget = target;
  if (pointerDropTarget) pointerDropTarget.classList.add('dragover');
}

function movePointerGhost(x, y) {
  if (!pointerDrag?.ghost) return;
  pointerDrag.ghost.style.transform = `translate3d(${Math.round(x + 10)}px, ${Math.round(y + 10)}px, 0)`;
}

function startPointerVisualDrag(e) {
  if (!pointerDrag || pointerDrag.started) return;
  const { sourceEl, tile, origin } = pointerDrag;
  dragging = { ...origin, tileId: tile.id };
  const rect = sourceEl.getBoundingClientRect();
  const ghost = sourceEl.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.classList.remove('previous-changed', 'previous-added', 'locked', 'pointer-draggable');
  ghost.classList.add('pointer-drag-ghost');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.setAttribute('aria-hidden', 'true');
  document.body.appendChild(ghost);
  pointerDrag.started = true;
  pointerDrag.ghost = ghost;
  sourceEl.classList.add('dragging', 'pointer-dragging');
  movePointerGhost(e.clientX, e.clientY);
  updatePointerDropTarget(e.clientX, e.clientY);
}

function finishPointerDrag() {
  if (!pointerDrag) return;
  clearPointerDropHighlight();
  if (pointerDrag.ghost) pointerDrag.ghost.remove();
  if (pointerDrag.sourceEl) pointerDrag.sourceEl.classList.remove('dragging', 'pointer-dragging');
  dragging = null;
  pointerDrag = null;
}

function completePointerDrop(target) {
  if (!target || !dragging) return;
  if (target.id === 'newMeldZone') {
    moveTileToNewMeld();
    return;
  }
  if (target.id === 'hand') {
    returnTileToHand();
    return;
  }
  if (target.classList.contains('meld')) {
    const index = Number(target.dataset.meldIndex);
    if (Number.isInteger(index)) moveTileToMeld(index);
  }
}

function addPointerDragHandlers(el, tile, origin, movable) {
  if (!movable) return;
  el.classList.add('pointer-draggable');
  el.draggable = false;
  el.setAttribute('draggable', 'false');
  el.addEventListener('dragstart', e => e.preventDefault());
  el.addEventListener('contextmenu', e => e.preventDefault());

  el.addEventListener('pointerdown', e => {
    if (!isMyTurn() || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointerDrag) finishPointerDrag();

    pointerDrag = {
      pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      startX: e.clientX,
      startY: e.clientY,
      sourceEl: el,
      tile,
      origin,
      started: false,
      ghost: null,
    };

    // Prevent native browser drag, text selection and touch panning from
    // competing with the game drag gesture. The rest of the page can still
    // scroll when the gesture starts outside a movable tile.
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  }, { passive: false });
}

// One Pointer Events path is used for mouse, touch and pen. This avoids the
// HTML5 drag-and-drop conflicts seen on iPadOS and Windows touch devices.
document.addEventListener('pointermove', e => {
  if (!pointerDrag || pointerDrag.pointerId !== e.pointerId) return;
  const dx = e.clientX - pointerDrag.startX;
  const dy = e.clientY - pointerDrag.startY;
  const threshold = pointerDrag.pointerType === 'mouse' ? 4 : 8;

  if (!pointerDrag.started && Math.hypot(dx, dy) >= threshold) {
    startPointerVisualDrag(e);
  }
  if (!pointerDrag.started) return;

  e.preventDefault();
  movePointerGhost(e.clientX, e.clientY);
  updatePointerDropTarget(e.clientX, e.clientY);
}, { passive: false, capture: true });

document.addEventListener('pointerup', e => {
  if (!pointerDrag || pointerDrag.pointerId !== e.pointerId) return;
  const sourceEl = pointerDrag.sourceEl;
  const started = pointerDrag.started;
  const target = started ? pointerTargetAt(e.clientX, e.clientY) : null;

  if (started) {
    e.preventDefault();
    completePointerDrop(target);
  }
  try { sourceEl.releasePointerCapture(e.pointerId); } catch (_) {}
  finishPointerDrag();
}, { passive: false, capture: true });

document.addEventListener('pointercancel', e => {
  if (!pointerDrag || pointerDrag.pointerId !== e.pointerId) return;
  finishPointerDrag();
}, { capture: true });

window.addEventListener('blur', () => finishPointerDrag());

function makeTile(tile, origin) {
  const el = document.createElement('div');
  el.className = `tile ${tile.joker ? 'joker' : tile.color}`;
  el.textContent = tile.joker ? 'JOKER' : tile.value;
  el.title = tile.joker ? '조커' : `${tile.color} ${tile.value}`;
  el.dataset.id = tile.id;

  if (origin.type === 'table' && serverState?.lastTurnDelta && serverState.lastTurnDelta.actorId !== serverState.me.id && isMyTurn()) {
    const delta = serverState.lastTurnDelta;
    if ((delta.changedTileIds || []).includes(tile.id)) el.classList.add('previous-changed');
    if ((delta.addedTileIds || []).includes(tile.id)) el.classList.add('previous-added');
  }

  const originalHandIds = new Set(serverState?.me?.hand?.map(t => t.id) || []);
  const lockedTable = origin.type === 'table' && serverState && !serverState.me.initialDone && !originalHandIds.has(tile.id);
  const movable = isMyTurn() && !lockedTable && serverState.status === 'playing';
  el.draggable = false;
  el.setAttribute('draggable', 'false');
  if (!movable) el.classList.add('locked');
  addPointerDragHandlers(el, tile, origin, movable);
  return el;
}

function moveTileToMeld(targetIndex) {
  if (!dragging || !draft || !isMyTurn()) return;
  if (dragging.type === 'table' && dragging.meldIndex === targetIndex) return;
  if (!serverState.me.initialDone && targetIndex < serverState.table.length) {
    setMessage('첫 등록 전에는 기존 테이블 묶음에 타일을 붙일 수 없습니다.', 'error');
    return;
  }

  let tile;
  if (dragging.type === 'hand') {
    const i = draft.hand.findIndex(t => t.id === dragging.tileId);
    if (i < 0) return;
    // 실제 이동이 가능한 것이 확인된 뒤에만 undo 스냅샷을 남긴다.
    rememberMove();
    [tile] = draft.hand.splice(i, 1);
  } else {
    const fromMyHandThisTurn = new Set(serverState.me.hand.map(t => t.id)).has(dragging.tileId);
    if (!serverState.me.initialDone && !fromMyHandThisTurn) return;
    const src = draft.table[dragging.meldIndex];
    if (!src) return;
    const i = src.findIndex(t => t.id === dragging.tileId);
    if (i < 0) return;
    rememberMove();
    [tile] = src.splice(i, 1);
    if (src.length === 0) {
      draft.table.splice(dragging.meldIndex, 1);
      if (dragging.meldIndex < targetIndex) targetIndex--;
    }
  }
  if (!draft.table[targetIndex]) draft.table[targetIndex] = [];
  draft.table[targetIndex].push(tile);
  renderDraft();
}

function moveTileToNewMeld() {
  if (!dragging || !draft || !isMyTurn()) return;

  let tile;
  if (dragging.type === 'hand') {
    const i = draft.hand.findIndex(t => t.id === dragging.tileId);
    if (i < 0) return;
    // 새 묶음을 만드는 동작 자체도 하나의 undo 가능한 수로 기록한다.
    rememberMove();
    [tile] = draft.hand.splice(i, 1);
  } else {
    const fromMyHandThisTurn = new Set(serverState.me.hand.map(t => t.id)).has(dragging.tileId);
    if (!serverState.me.initialDone && !fromMyHandThisTurn) return;
    const src = draft.table[dragging.meldIndex];
    if (!src) return;
    const i = src.findIndex(t => t.id === dragging.tileId);
    if (i < 0) return;
    rememberMove();
    [tile] = src.splice(i, 1);
    if (src.length === 0) draft.table.splice(dragging.meldIndex, 1);
  }
  draft.table.push([tile]);
  renderDraft();
}

function returnTileToHand() {
  if (!dragging || dragging.type !== 'table' || !draft || !isMyTurn()) return;
  // Only tiles that came from this player's hand during this draft may return to hand.
  const originalHandIds = new Set(serverState.me.hand.map(t => t.id));
  if (!originalHandIds.has(dragging.tileId)) {
    setMessage('기존 테이블 타일은 내 패로 가져올 수 없습니다.', 'error');
    return;
  }
  const src = draft.table[dragging.meldIndex];
  const i = src.findIndex(t => t.id === dragging.tileId);
  if (i < 0) return;
  rememberMove();
  const [tile] = src.splice(i, 1);
  if (src.length === 0) draft.table.splice(dragging.meldIndex, 1);
  draft.hand.push(tile);
  renderDraft();
}

function addDropHandlers(el, fn) {
  // hand / 새 묶음 영역은 renderDraft() 때마다 재사용되므로 addEventListener를
  // 누적하면 한 번의 drop이 여러 번 실행되어 undo 기록이 중복될 수 있다.
  // 이벤트 프로퍼티를 교체하는 방식으로 항상 핸들러를 하나만 유지한다.
  el.ondragover = e => {
    if (dragging) {
      e.preventDefault();
      el.classList.add('dragover');
    }
  };
  el.ondragleave = () => el.classList.remove('dragover');
  el.ondrop = e => {
    e.preventDefault();
    el.classList.remove('dragover');
    fn();
  };
}

function renderDraft() {
  if (!serverState || !draft) return;
  sortDraftTable();
  const table = $('table');
  table.innerHTML = '';
  draft.table.forEach((meld, mi) => {
    const box = document.createElement('div');
    box.className = `meld ${isValidMeld(meld) ? 'valid' : 'invalid'}`;
    box.dataset.meldIndex = String(mi);
    addDropHandlers(box, () => moveTileToMeld(mi));
    meld.forEach(tile => box.appendChild(makeTile(tile, { type: 'table', meldIndex: mi })));
    table.appendChild(box);
  });
  if (!draft.table.length) {
    const empty = document.createElement('div');
    empty.className = 'small';
    empty.textContent = '아직 테이블에 놓인 타일이 없습니다.';
    table.appendChild(empty);
  }

  const hand = $('hand');
  hand.innerHTML = '';
  draft.hand.forEach(tile => hand.appendChild(makeTile(tile, { type: 'hand' })));
  addDropHandlers(hand, returnTileToHand);

  const newZone = $('newMeldZone');
  newZone.classList.toggle('hidden', !isMyTurn());
  addDropHandlers(newZone, moveTileToNewMeld);
  updateActionButtons();
}

function formatTurnLimit(sec) {
  if (!sec) return '제한 없음';
  if (sec < 60) return `${sec}초`;
  if (sec % 60 === 0) return `${sec / 60}분`;
  return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}


function playerLabel(player) {
  if (!player) return '플레이어';
  const badges = [];
  if (player.isMe) badges.push('나');
  if (player.isHost) badges.push('방장');
  if (player.isAI) badges.push('AI');
  return badges.length ? `${player.name} (${badges.join(' · ')})` : player.name;
}

function currentPlayer() {
  return serverState?.players?.find(p => p.id === serverState.turnPlayerId) || null;
}

function renderPlayerCards(container, players, waiting = false) {
  container.innerHTML = '';
  for (const player of players || []) {
    const card = document.createElement('div');
    card.className = 'player-chip';
    if (player.id === serverState?.turnPlayerId && !waiting) card.classList.add('current');
    if (player.isMe) card.classList.add('me');
    const name = document.createElement('strong');
    name.textContent = playerLabel(player);
    const meta = document.createElement('span');
    meta.textContent = waiting ? `자리 ${player.seat}` : `${player.handCount}장${player.initialDone ? ' · 등록완료' : ''}`;
    card.append(name, meta);
    container.appendChild(card);
  }
}

function updateAiCountOptions() {
  const max = Number($('createMaxPlayers')?.value || 2);
  const sel = $('createAiCount');
  if (!sel) return;
  for (const option of sel.options) option.disabled = Number(option.value) > max - 1;
  if (Number(sel.value) > max - 1) sel.value = String(max - 1);
}

function updateActionButtons() {
  const myTurn = isMyTurn();
  $('undoMoveBtn').disabled = !myTurn || moveHistory.length === 0;
  $('resetBtn').disabled = !myTurn;
  $('drawBtn').disabled = !myTurn || serverState.poolCount === 0;
  $('commitBtn').disabled = !myTurn;
  $('passBtn').classList.toggle('hidden', serverState.poolCount !== 0);
  $('passBtn').disabled = !myTurn;
  const isHost = !!serverState?.me?.isHost;
  $('newGameBtn').classList.toggle('hidden', !isHost);
  $('newGameBtn').disabled = !isHost;
  $('stopGameBtn').classList.toggle('hidden', !isHost);
  $('stopGameBtn').disabled = !isHost;
}

function updateTurnClock() {
  const el = $('turnClock');
  if (!el || !serverState) return;
  el.className = 'turn-clock';
  if (serverState.status !== 'playing') {
    el.textContent = serverState.status === 'finished' ? '게임 종료' : '--:--';
    return;
  }
  if (!serverState.turnDeadline || !serverState.turnLimitSec) {
    el.textContent = '시간 제한 없음';
    el.classList.add('unlimited');
    return;
  }
  const estimatedServerNow = serverState.serverNow + (Date.now() - stateReceivedAt);
  const remainingMs = Math.max(0, serverState.turnDeadline - estimatedServerNow);
  const totalSec = Math.ceil(remainingMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  el.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (totalSec <= 10) el.classList.add('danger');
  else if (totalSec <= 20) el.classList.add('warning');
}

function render() {
  if (!serverState) return;
  if (serverState.status === 'playing') {
    if (lastSoundTurnNumber !== null && serverState.turnNumber !== lastSoundTurnNumber) playTurnSound();
    lastSoundTurnNumber = serverState.turnNumber;
  }
  if (serverState.status === 'waiting') {
    setScreen('waiting');
    $('roomCodeBig').textContent = serverState.code;
    $('waitingTimerInfo').textContent = `턴 제한 시간: ${formatTurnLimit(serverState.turnLimitSec)}`;
    $('waitingRoomInfo').textContent = `사람 ${serverState.humanCount ?? serverState.players.filter(p => !p.isAI).length} / ${serverState.humanSlots ?? '-'}명 · AI ${serverState.aiCount ?? serverState.players.filter(p => p.isAI).length}명 · 총 ${serverState.players.length}명`;
    renderPlayerCards($('waitingPlayers'), serverState.players, true);
    const startBtn = $('startGameBtn');
    const isHost = !!serverState.me.isHost;
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = !serverState.canStart;
    $('endSessionBtn').classList.toggle('hidden', !isHost);
    $('waitingHostNote').textContent = isHost
      ? (serverState.canStart ? '방장입니다. 설정한 참가자가 모두 모였습니다. 게임 시작을 누르세요.' : `사람 참가자 ${serverState.humanSlots ?? 1}명이 모두 들어오고 총 2명 이상이어야 시작할 수 있습니다.`)
      : '방장이 게임을 시작할 때까지 기다려 주세요.';
    return;
  }
  setScreen('game');
  $('roomCode').textContent = serverState.code;
  $('meName').textContent = serverState.me.name;
  $('myCount').textContent = serverState.me.handCount;
  $('playerCount').textContent = serverState.players?.length || 0;
  $('poolCount').textContent = serverState.poolCount;
  $('turnLimitText').textContent = formatTurnLimit(serverState.turnLimitSec);
  renderPlayerCards($('playersBar'), serverState.players, false);

  const banner = $('turnBanner');
  banner.className = 'turn-banner';
  const active = currentPlayer();
  if (serverState.status === 'finished') {
    const won = serverState.winnerId === serverState.me.id;
    const winner = serverState.players?.find(p => p.id === serverState.winnerId);
    banner.textContent = won ? '🎉 승리했습니다!' : `게임 종료 — ${winner?.name || '다른 플레이어'} 승리`;
    banner.classList.add('win');
  } else if (isMyTurn()) {
    banner.textContent = serverState.me.initialDone ? '내 차례 — 타일을 내려놓거나 테이블을 재배치하세요.' : '내 차례 — 첫 등록은 내 패로 30점 이상이어야 합니다.';
  } else {
    banner.textContent = `${active?.name || '다른 플레이어'} 차례${active?.isAI ? ' 🤖' : ''} — 두는 중입니다.`;
    banner.classList.add('their-turn');
  }

  const delta = serverState.lastTurnDelta;
  const actor = serverState.players?.find(p => p.id === delta?.actorId);
  const showDelta = isMyTurn() && delta && delta.actorId !== serverState.me.id && ((delta.changedTileIds || []).length || (delta.addedTileIds || []).length);
  if (showDelta) {
    $('tableHelp').innerHTML = `<span class="change-legend"><span><i class="legend-swatch changed"></i>${actor?.name || '직전 플레이어'}가 재배치</span><span><i class="legend-swatch added"></i>${actor?.name || '직전 플레이어'}가 새로 냄</span></span>`;
  } else {
    $('tableHelp').textContent = !serverState.me.initialDone
      ? '첫 등록 전에는 기존 테이블을 움직일 수 없습니다.'
      : '타일을 끌어서 묶음 사이를 옮길 수 있습니다.';
  }

  updateActionButtons();

  if (!draft) resetDraft();
  renderDraft();
  updateTurnClock();
}

$('createBtn').onclick = async () => {
  try {
    const out = await api('/api/create', {
      name: $('createName').value,
      turnLimitSec: Number($('createTurnLimit').value),
      maxPlayers: Number($('createMaxPlayers').value),
      aiCount: Number($('createAiCount').value),
    });
    saveSession(out.code, out.playerId);
    serverState = out.state;
    stateReceivedAt = Date.now();
    resetDraft();
    render();
    connectEvents();
  } catch (e) { alert(e.message); }
};

$('joinBtn').onclick = async () => {
  try {
    const out = await api('/api/join', { name: $('joinName').value, code: $('joinCode').value });
    saveSession(out.code, out.playerId);
    serverState = out.state;
    stateReceivedAt = Date.now();
    resetDraft();
    render();
    connectEvents();
  } catch (e) { alert(e.message); }
};

$('copyCodeBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(serverState.code);
    $('copyCodeBtn').textContent = '복사됨!';
    setTimeout(() => $('copyCodeBtn').textContent = '방 코드 복사', 1200);
  } catch (_) {
    alert(`방 코드: ${serverState.code}`);
  }
};


$('copyLinkBtn').onclick = async () => {
  const invite = new URL(location.href);
  invite.search = '';
  invite.searchParams.set('room', serverState.code);
  try {
    await navigator.clipboard.writeText(invite.toString());
    $('copyLinkBtn').textContent = '링크 복사됨!';
    setTimeout(() => $('copyLinkBtn').textContent = '초대 링크 복사', 1200);
  } catch (_) {
    prompt('이 링크를 함께 플레이할 사람에게 보내세요.', invite.toString());
  }
};

$('startGameBtn').onclick = async () => {
  try {
    const out = await api('/api/action', { room: session.room, playerId: session.playerId, type: 'start' });
    serverState = out;
    stateReceivedAt = Date.now();
    lastSoundTurnNumber = null;
    resetDraft();
    render();
    setMessage('게임을 시작했습니다.', 'ok');
  } catch (e) {
    alert(e.message);
  }
};

function updateNewGameConfigOptions() {
  const humansNow = serverState?.players?.filter(p => !p.isAI).length || 1;
  const humanSel = $('newHumanCount');
  const aiSel = $('newAiCount');
  if (!humanSel || !aiSel) return;
  for (const option of humanSel.options) option.disabled = false;
  const humanCount = Number(humanSel.value);
  for (const option of aiSel.options) option.disabled = humanCount + Number(option.value) > 4;
  if (humanCount + Number(aiSel.value) > 4) aiSel.value = String(Math.max(0, 4 - humanCount));
  $('newGameConfigNote').textContent = `현재 접속 중인 사람은 ${humansNow}명입니다. 사람 수를 줄이면 방장을 제외한 뒤늦게 들어온 참가자부터 방에서 나가게 됩니다. 사람+AI 합계는 2~4명이어야 합니다.`;
}

$('newGameBtn').onclick = () => {
  if (!serverState?.me?.isHost) return;
  const humansNow = serverState.players.filter(p => !p.isAI).length;
  $('newHumanCount').value = String(Math.max(humansNow, serverState.humanSlots || humansNow));
  $('newAiCount').value = String(serverState.aiCount ?? serverState.players.filter(p => p.isAI).length);
  $('newTurnLimit').value = String(serverState.turnLimitSec || 0);
  updateNewGameConfigOptions();
  $('newGameDialog').showModal();
};

$('newHumanCount').addEventListener('change', updateNewGameConfigOptions);
$('cancelNewGameBtn').onclick = () => $('newGameDialog').close();
$('newGameForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!serverState?.me?.isHost) return;
  const humanSlots = Number($('newHumanCount').value);
  const aiCount = Number($('newAiCount').value);
  const turnLimitSec = Number($('newTurnLimit').value);
  if (humanSlots + aiCount < 2 || humanSlots + aiCount > 4) {
    return alert('사람과 AI를 합쳐 2~4명으로 설정해 주세요.');
  }
  try {
    const out = await api('/api/action', {
      room: session.room,
      playerId: session.playerId,
      type: 'reconfigure',
      humanSlots,
      aiCount,
      turnLimitSec,
    });
    $('newGameDialog').close();
    clearHandOrder();
    serverState = out;
    stateReceivedAt = Date.now();
    lastSoundTurnNumber = null;
    resetDraft();
    render();
    setMessage('새 게임 설정을 적용했습니다. 대기실에서 참가자를 확인한 뒤 시작하세요.', 'ok');
  } catch (e2) {
    alert(e2.message);
  }
});

async function endCurrentSession() {
  if (!serverState?.me?.isHost) return;
  if (!confirm('현재 게임 세션을 완전히 종료할까요?\n이 방 코드는 더 이상 사용할 수 없습니다.')) return;
  try {
    const out = await api('/api/action', { room: session.room, playerId: session.playerId, type: 'endSession' });
    if (eventSource) eventSource.close();
    eventSource = null;
    clearSession();
    serverState = null;
    draft = null;
    moveHistory = [];
    setScreen('lobby');
    alert(out.message || '게임 세션이 종료되었습니다.');
  } catch (e) {
    alert(e.message);
  }
}

$('stopGameBtn').onclick = endCurrentSession;
$('endSessionBtn').onclick = endCurrentSession;

$('undoMoveBtn').onclick = undoLastMove;

$('resetBtn').onclick = () => { resetDraft(); renderDraft(); setMessage('이번 턴의 변경을 모두 되돌렸습니다.', 'ok'); };

$('drawBtn').onclick = async () => {
  if (!isMyTurn()) return;
  if (hasDraftChanges()) {
    if (!confirm('이번 턴에 옮긴 타일을 모두 되돌리고 1장을 뽑을까요?')) return;
  }
  try {
    await api('/api/action', { room: session.room, playerId: session.playerId, type: 'draw' });
    setMessage('타일을 1장 뽑고 턴을 넘겼습니다.', 'ok');
  } catch (e) { setMessage(e.message, 'error'); }
};

$('passBtn').onclick = async () => {
  try {
    await api('/api/action', { room: session.room, playerId: session.playerId, type: 'pass' });
    setMessage('패스했습니다.', 'ok');
  } catch (e) { setMessage(e.message, 'error'); }
};

$('commitBtn').onclick = async () => {
  try {
    const out = await api('/api/action', {
      room: session.room,
      playerId: session.playerId,
      type: 'commit',
      hand: draft.hand.map(t => t.id),
      table: draft.table.map(m => m.map(t => t.id)),
    });
    serverState = out;
    stateReceivedAt = Date.now();
    resetDraft();
    render();
    setMessage('정상적으로 등록하고 턴을 넘겼습니다.', 'ok');
  } catch (e) {
    setMessage(e.message, 'error');
  }
};

$('sortColorBtn').onclick = () => {
  draft.hand.sort((a, b) => colorRank(a.color) - colorRank(b.color) || a.value - b.value);
  handOrder = draft.hand.map(t => t.id);
  saveHandOrder();
  renderDraft();
};
$('sortNumberBtn').onclick = () => {
  draft.hand.sort((a, b) => (a.joker - b.joker) || a.value - b.value || colorRank(a.color) - colorRank(b.color));
  handOrder = draft.hand.map(t => t.id);
  saveHandOrder();
  renderDraft();
};

$('createMaxPlayers').addEventListener('change', updateAiCountOptions);
updateAiCountOptions();

$('rulesBtn').onclick = () => $('rulesDialog').showModal();
$('closeRulesBtn').onclick = () => $('rulesDialog').close();

(async function resume() {
  const inviteCode = new URLSearchParams(location.search).get('room');
  if (inviteCode) $('joinCode').value = inviteCode.toUpperCase();
  if (!session.room || !session.playerId) return setScreen('lobby');
  loadHandOrder();
  try {
    serverState = await api(`/api/state?room=${encodeURIComponent(session.room)}&player=${encodeURIComponent(session.playerId)}`);
    stateReceivedAt = Date.now();
    resetDraft();
    render();
    connectEvents();
  } catch (_) {
    clearSession();
    setScreen('lobby');
  }
})();

setInterval(updateTurnClock, 250);

// Installable PWA support. On Android/Chromium we can show the native install
// prompt. On iPhone/iPad Safari, the button explains the Home Screen steps.
let deferredInstallPrompt = null;
function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function updateInstallButton() {
  const btn = $('installBtn');
  if (!btn) return;
  const canShow = !isStandaloneApp() && (deferredInstallPrompt || isIosDevice());
  btn.classList.toggle('hidden', !canShow);
}
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButton();
});
if ($('installBtn')) {
  $('installBtn').addEventListener('click', async () => {
    unlockAudio();
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (_) {}
      deferredInstallPrompt = null;
      updateInstallButton();
      return;
    }
    if (isIosDevice()) {
      alert('iPhone/iPad에서는 Safari의 공유 버튼(□↑)을 누른 뒤 “홈 화면에 추가”를 선택하세요.');
    }
  });
}
updateInstallButton();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
