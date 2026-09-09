/* ============================================================
   teacher.js — WebRTC(PeerJS) 버전
   교사 브라우저가 "호스트" 역할을 하며, 방 상태 전체를
   이 기기의 localStorage 에 저장합니다. 외부 서버/DB 없음.
   조건/질문은 같은 폴더의 config.xlsx 파일에서 자동으로 불러옵니다.
   ============================================================ */

let peer = null;                 // 나의 PeerJS 인스턴스 (호스트)
let currentRoomCode = null;
let room = null;                 // 방 상태 (메모리 + localStorage)
let liveConnections = {};        // studentKey -> DataConnection (현재 연결된 학생만)

const DOT_COLORS = ['#E8B84B', '#4FA8C9', '#D9705A', '#7FB86B', '#B08BD1', '#E7907C', '#5FA394', '#C9974B'];

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

function showView(name) {
  ['create', 'waiting', 'active', 'ended'].forEach(v => {
    document.getElementById('view-' + v).style.display = (v === name) ? '' : 'none';
  });
  document.getElementById('topbar-room').style.display = (name === 'create') ? 'none' : '';
}

function showConnWarning(msg) {
  const el = document.getElementById('conn-warning');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  } else {
    alert(msg);
  }
}
function hideConnWarning() {
  const el = document.getElementById('conn-warning');
  if (el) el.style.display = 'none';
}

function on(id, event, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn('요소를 찾을 수 없습니다:', id);
    return;
  }
  el.addEventListener(event, handler);
}

document.addEventListener('DOMContentLoaded', () => {
  on('btn-create-room', 'click', () => createRoom());
  on('btn-rejoin-room', 'click', rejoinRoom);
  on('btn-start-activity', 'click', startActivity);
  on('btn-next-question', 'click', nextQuestion);
  on('btn-end-activity', 'click', endActivity);
  on('btn-delete-room', 'click', deleteRoom);

  const lastCode = loadLastTeacherCode();
  if (lastCode) {
    document.getElementById('rejoin-code').value = lastCode;
  }

  window.addEventListener('beforeunload', () => {
    if (peer) peer.destroy();
  });
});

// ---------- config.xlsx 자동 로드 ----------
async function loadConfigFromFile() {
  try {
    const resp = await fetch('config.xlsx', { cache: 'no-store' });
    if (!resp.ok) throw new Error('config.xlsx not found');
    const buf = await resp.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const parsed = parseConfigWorkbook(workbook);
    return {
      conditions: parsed.conditions.length ? parsed.conditions : DEFAULT_CONDITIONS,
      questions: parsed.questions.length ? parsed.questions : DEFAULT_QUESTIONS
    };
  } catch (e) {
    console.warn('config.xlsx 를 불러오지 못해 기본 예시 데이터를 사용합니다.', e);
    return { conditions: DEFAULT_CONDITIONS, questions: DEFAULT_QUESTIONS };
  }
}

// ---------- 방 생성 / 재입장 ----------

async function createRoom(attemptsLeft) {
  attemptsLeft = attemptsLeft === undefined ? 5 : attemptsLeft;
  const code = generateRoomCode();
  const config = await loadConfigFromFile();
  room = {
    status: 'waiting',
    createdAt: Date.now(),
    currentQuestionIndex: -1,
    config: config,
    students: {}
  };
  hostRoom(code, { isNewRoom: true, attemptsLeft: attemptsLeft });
}

function rejoinRoom() {
  const raw = document.getElementById('rejoin-code').value.trim();
  const errEl = document.getElementById('rejoin-error');
  errEl.textContent = '';
  if (!/^\d{4}$/.test(raw)) {
    errEl.textContent = '방 번호 4자리를 입력해주세요.';
    return;
  }
  const saved = loadTeacherRoomState(raw);
  if (!saved) {
    errEl.textContent = '이 기기에 저장된 방 정보를 찾을 수 없습니다. (다른 기기/브라우저에서 만든 방은 이어받을 수 없습니다)';
    return;
  }
  room = saved;
  hostRoom(raw, { isNewRoom: false });
}

function hostRoom(code, opts) {
  hideConnWarning();
  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
  liveConnections = {};

  peer = new Peer(peerIdFor(code));

  peer.on('open', () => {
    currentRoomCode = code;
    document.getElementById('room-code-chip').textContent = code;
    document.getElementById('room-code-big').textContent = code;
    saveTeacherRoomState(code, room);
    renderRoom();
  });

  peer.on('connection', conn => setupIncomingConnection(conn));

  peer.on('disconnected', () => {
    try { peer.reconnect(); } catch (e) {}
  });

  peer.on('error', err => {
    console.error('Peer error:', err);
    if (err.type === 'unavailable-id') {
      if (opts && opts.isNewRoom && opts.attemptsLeft > 0) {
        createRoom(opts.attemptsLeft - 1);
      } else if (opts && opts.isNewRoom) {
        showConnWarning('방 번호를 배정하는 데 계속 실패했습니다. 잠시 후 다시 시도해주세요.');
      } else {
        showConnWarning('이미 같은 방 번호로 열려있는 창이 있는 것 같습니다. 이전 창을 닫고 다시 시도해주세요.');
      }
    } else if (err.type === 'browser-incompatible') {
      showConnWarning('이 브라우저는 WebRTC를 지원하지 않습니다. 최신 크롬/엣지 브라우저를 사용해주세요.');
    } else {
      showConnWarning('연결 중 문제가 발생했습니다: ' + err.type);
    }
  });
}

function setupIncomingConnection(conn) {
  conn.on('data', msg => handleStudentMessage(conn, msg));
  conn.on('close', () => {
    if (conn.studentKey && liveConnections[conn.studentKey] === conn) {
      delete liveConnections[conn.studentKey];
    }
  });
  conn.on('error', err => console.error('연결 오류:', err));
}

function persist() {
  if (currentRoomCode) saveTeacherRoomState(currentRoomCode, room);
}

function handleStudentMessage(conn, msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'join' || msg.type === 'requestState') {
    const key = sanitizeKey(msg.studentKey || msg.number);
    conn.studentKey = key;
    liveConnections[key] = conn;

    if (!room.students[key]) {
      room.students[key] = {
        number: msg.number || key,
        joinedAt: Date.now(),
        conditions: {},
        position: 0,
        responses: {}
      };
    }
    persist();
    renderRoom();
    sendStateTo(key);
    return;
  }

  if (msg.type === 'respond') {
    const key = conn.studentKey;
    if (!key || !room.students[key]) return;
    if (room.status !== 'active') return;

    const idx = room.currentQuestionIndex;
    if (msg.questionIndex !== idx) return;
    const student = room.students[key];
    if (student.responses && student.responses[idx]) return;

    const questions = (room.config && room.config.questions) || DEFAULT_QUESTIONS;
    const q = questions[idx];
    if (!q) return;

    const delta = msg.choice === 'choice1' ? q.choice1Delta : q.choice2Delta;
    if (!student.responses) student.responses = {};
    student.responses[idx] = { choice: msg.choice, delta, respondedAt: Date.now() };
    student.position = clampPosition((student.position || 0) + delta);

    persist();
    renderRoom();
    sendStateTo(key);
  }
}

function buildStatePayload(key) {
  const student = room.students[key] || { number: key, conditions: {}, position: 0, responses: {} };
  const questions = (room.config && room.config.questions) || DEFAULT_QUESTIONS;
  const idx = room.currentQuestionIndex;
  return {
    type: 'state',
    status: room.status,
    questionIndex: idx,
    totalQuestions: questions.length,
    question: questions[idx] || null,
    activityStartedAt: room.activityStartedAt || null,
    me: {
      number: student.number,
      conditions: student.conditions || {},
      position: student.position || 0,
      responses: student.responses || {}
    }
  };
}

function sendStateTo(key) {
  const conn = liveConnections[key];
  if (conn && conn.open) {
    conn.send(buildStatePayload(key));
  }
}

function broadcastAll() {
  Object.keys(liveConnections).forEach(sendStateTo);
}

function broadcastRoomDeleted() {
  Object.keys(liveConnections).forEach(key => {
    const conn = liveConnections[key];
    if (conn && conn.open) conn.send({ type: 'roomDeleted' });
  });
}

// ---------- 화면별 렌더링 ----------

function renderRoom() {
  if (!room) return;
  if (room.status === 'waiting') {
    showView('waiting');
    renderWaiting();
  } else if (room.status === 'active') {
    showView('active');
    renderActive();
  } else if (room.status === 'ended') {
    showView('ended');
    renderEnded();
  }
}

function renderWaiting() {
  const students = room.students || {};
  const keys = Object.keys(students);
  document.getElementById('student-count').textContent = keys.length;

  const grid = document.getElementById('roster-grid');
  if (keys.length === 0) {
    grid.innerHTML = '<div class="empty-note">아직 입장한 학생이 없습니다</div>';
  } else {
    grid.innerHTML = keys
      .sort((a, b) => (students[a].number || '').localeCompare(students[b].number || ''))
      .map(k => `<div class="roster-chip">${escapeHtml(students[k].number || k)}</div>`)
      .join('');
  }

  document.getElementById('btn-start-activity').disabled = keys.length === 0;

  const cfg = room.config || { conditions: [], questions: [] };
  document.getElementById('config-status').textContent =
    `조건 ${(cfg.conditions || []).length}개 · 질문 ${(cfg.questions || []).length}개 불러옴`;
}

function startActivity() {
  const students = room.students || {};
  const conditions = (room.config && room.config.conditions) || DEFAULT_CONDITIONS;

  Object.keys(students).forEach(key => {
    students[key].conditions = assignRandomConditions(conditions);
    students[key].position = 0;
    students[key].responses = {};
  });

  room.status = 'active';
  room.currentQuestionIndex = 0;
  room.activityStartedAt = Date.now();
  persist();
  renderRoom();
  broadcastAll();
}

function renderActive() {
  const questions = (room.config && room.config.questions) || DEFAULT_QUESTIONS;
  const idx = room.currentQuestionIndex;
  const q = questions[idx] || { text: '(질문 없음)' };

  document.getElementById('q-index-label').textContent = `질문 ${idx + 1} / ${questions.length}`;
  document.getElementById('q-text').textContent = q.text;

  const students = room.students || {};
  renderTrack('track', students, idx, true);
  renderStatusLists(students, idx);

  document.getElementById('btn-next-question').disabled = idx >= questions.length - 1;

  const total = Object.keys(students).length;
  const answered = Object.keys(students).filter(k => students[k].responses && students[k].responses[idx]).length;
  document.getElementById('progress-note').textContent = `${answered} / ${total}명 응답 완료`;
}

// 학생들의 현재 위치 격차가 좁을 때는 크게 벌려서, 격차가 넓어질수록 상대적으로
// 덜 벌어지도록 만드는 "탄력적" 스케일. (0에 가까운 변화도 항상 도드라져 보이게)
function computeDisplayExtent(students) {
  const MAX_POS = 10;      // 이론상 최대 위치 (clampPosition 범위와 동일)
  const MIN_WINDOW = 1.5;  // 학생들이 전부 같은 위치여도 최소한 이 정도는 벌려서 보여줌
  const EXPONENT = 0.5;    // 1보다 작을수록 "좁을 때 더 과장" 효과가 커짐

  let rawExtent = 0;
  Object.keys(students || {}).forEach(k => {
    const p = Math.abs(clampPosition(students[k].position || 0));
    if (p > rawExtent) rawExtent = p;
  });

  const t = Math.min(1, rawExtent / MAX_POS);
  return MIN_WINDOW + (MAX_POS - MIN_WINDOW) * Math.pow(t, EXPONENT);
}

function renderTrack(trackId, students, currentQuestionIndex, showStatus) {
  const track = document.getElementById(trackId);
  if (!track) return;
  track.querySelectorAll('.student-dot').forEach(el => el.remove());

  const keys = Object.keys(students || {}).sort(); // 매 렌더링마다 같은 순서 유지 -> 가로 위치 고정
  const n = keys.length;
  const displayExtent = computeDisplayExtent(students);

  keys.forEach((key, i) => {
    const student = students[key];
    const pos = clampPosition(student.position || 0);
    const xPct = n <= 1 ? 50 : (8 + (i / (n - 1)) * 84);
    const normalized = displayExtent > 0 ? pos / displayExtent : 0;
    const yPct = 50 - normalized * 42;

    const answered = showStatus && currentQuestionIndex >= 0 && student.responses && student.responses[currentQuestionIndex];
    const dot = document.createElement('div');
    dot.className = 'student-dot' + (showStatus ? (answered ? ' answered' : ' pending') : '');
    dot.style.left = xPct + '%';
    dot.style.top = yPct + '%';
    dot.style.background = DOT_COLORS[Math.abs(hashCode(key)) % DOT_COLORS.length];
    dot.addEventListener('mouseenter', e => showTooltip(e, student));
    dot.addEventListener('mousemove', moveTooltip);
    dot.addEventListener('mouseleave', hideTooltip);
    track.appendChild(dot);
  });
}

function renderStatusLists(students, currentQuestionIndex) {
  const keys = Object.keys(students || {});
  const pending = keys.filter(k => !(students[k].responses && students[k].responses[currentQuestionIndex]));
  const answered = keys.filter(k => students[k].responses && students[k].responses[currentQuestionIndex]);

  document.getElementById('pending-count').textContent = pending.length;
  document.getElementById('answered-count').textContent = answered.length;

  document.getElementById('pending-list').innerHTML = pending
    .map(k => `<span class="chip pending">${escapeHtml(students[k].number || k)}</span>`).join('') ||
    '<span class="empty-note">없음</span>';
  document.getElementById('answered-list').innerHTML = answered
    .map(k => `<span class="chip answered">${escapeHtml(students[k].number || k)}</span>`).join('') ||
    '<span class="empty-note">없음</span>';
}

function showTooltip(e, student) {
  const tip = document.getElementById('tooltip');
  const conditions = student.conditions || {};
  const rows = Object.keys(conditions).map(c => `${escapeHtml(c)}: <strong>${escapeHtml(conditions[c])}</strong>`).join('<br/>');
  tip.innerHTML = `<div class="t-title">학번 ${escapeHtml(student.number || '')}</div>${rows || '조건 미배정'}`;
  tip.style.display = 'block';
  moveTooltip(e);
}
function moveTooltip(e) {
  const tip = document.getElementById('tooltip');
  tip.style.left = (e.clientX + 14) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
}
function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}

function nextQuestion() {
  const questions = (room.config && room.config.questions) || DEFAULT_QUESTIONS;
  const nextIdx = room.currentQuestionIndex + 1;
  if (nextIdx >= questions.length) return;
  room.currentQuestionIndex = nextIdx;
  persist();
  renderRoom();
  broadcastAll();
}

function endActivity() {
  room.status = 'ended';
  persist();
  renderRoom();
  broadcastAll();
}

function renderEnded() {
  const students = room.students || {};
  renderTrack('track-ended', students, -1, false);
}

function deleteRoom() {
  if (!confirm('정말 이 방을 삭제할까요? 삭제하면 되돌릴 수 없고, 접속해있던 학생들은 초기 화면으로 돌아갑니다.')) {
    return;
  }
  broadcastRoomDeleted();

  if (currentRoomCode) {
    localStorage.removeItem(teacherRoomStorageKey(currentRoomCode));
    if (loadLastTeacherCode() === currentRoomCode) {
      localStorage.removeItem('ssl_last_teacher_code');
    }
  }

  if (peer) {
    try { peer.destroy(); } catch (e) {}
    peer = null;
  }
  liveConnections = {};
  room = null;
  currentRoomCode = null;

  document.getElementById('rejoin-code').value = '';
  showView('create');
}
