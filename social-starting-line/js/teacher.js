/* ============================================================
   teacher.js — WebRTC(PeerJS) 버전
   교사 브라우저가 "호스트" 역할을 하며, 방 상태 전체를
   이 기기의 localStorage 에 저장합니다. 외부 서버/DB 없음.
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-create-room').addEventListener('click', createRoom);
  document.getElementById('btn-rejoin-room').addEventListener('click', rejoinRoom);
  document.getElementById('excel-input').addEventListener('change', handleExcelUpload);
  document.getElementById('btn-start-activity').addEventListener('click', startActivity);
  document.getElementById('btn-next-question').addEventListener('click', nextQuestion);

  const lastCode = loadLastTeacherCode();
  if (lastCode) {
    document.getElementById('rejoin-code').value = lastCode;
  }

  window.addEventListener('beforeunload', () => {
    if (peer) peer.destroy();
  });
});

// ---------- 방 생성 / 재입장 ----------

function createRoom(attemptsLeft) {
  attemptsLeft = attemptsLeft === undefined ? 5 : attemptsLeft;
  const code = generateRoomCode();
  room = {
    status: 'waiting',
    createdAt: Date.now(),
    currentQuestionIndex: -1,
    config: { conditions: DEFAULT_CONDITIONS, questions: DEFAULT_QUESTIONS },
    students: {}
  };
  hostRoom(code, {
    isNewRoom: true,
    attemptsLeft: attemptsLeft
  });
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
    // 신호 서버와의 연결만 끊긴 상태 - 재연결 시도 (기존 데이터 연결에는 영향 없음)
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
  conn.on('open', () => {
    // 별도 처리 없음 - 첫 데이터 메시지(join)를 기다림
  });
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
    if (msg.questionIndex !== idx) return; // 이미 지나간 질문에 대한 응답은 무시
    const student = room.students[key];
    if (student.responses && student.responses[idx]) return; // 중복 응답 방지

    const questions = (room.config && room.config.questions) || DEFAULT_QUESTIONS;
    const q = questions[idx];
    if (!q) return;

    const delta = msg.choice === 'back' ? q.backDelta : q.forwardDelta;
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
  document.getElementById('cond-count').textContent = (cfg.conditions || []).length;
  document.getElementById('q-count').textContent = (cfg.questions || []).length;
}

function handleExcelUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('excel-status');

  if (room && room.status !== 'waiting') {
    statusEl.textContent = '활동이 이미 시작되어 설정을 바꿀 수 없습니다.';
    statusEl.classList.remove('ready');
    return;
  }

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const parsed = parseConfigWorkbook(workbook);

      if (!parsed.conditions.length && !parsed.questions.length) {
        statusEl.textContent = '엑셀에서 조건/질문을 읽지 못했습니다. 시트 이름과 열 이름을 확인해주세요 (conditions, questions).';
        statusEl.classList.remove('ready');
        return;
      }

      room.config = {
        conditions: parsed.conditions.length ? parsed.conditions : DEFAULT_CONDITIONS,
        questions: parsed.questions.length ? parsed.questions : DEFAULT_QUESTIONS
      };
      persist();

      statusEl.textContent = `업로드 완료 · 조건 ${room.config.conditions.length}개, 질문 ${room.config.questions.length}개 적용됨`;
      statusEl.classList.add('ready');
      renderWaiting();
    } catch (err) {
      console.error(err);
      statusEl.textContent = '엑셀 파일을 읽는 중 오류가 발생했습니다. 파일 형식을 확인해주세요.';
      statusEl.classList.remove('ready');
    }
  };
  reader.readAsArrayBuffer(file);
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
  persist();
  renderRoom();
  broadcastAll();
}

function renderActive() {
  const questions = (room.config && room.config.questions) || DEFAULT_QUESTIONS;
  const idx = room.currentQuestionIndex;
  const q = questions[idx] || { text: '(질문 없음)', backLabel: '', forwardLabel: '', backDelta: 0, forwardDelta: 0 };

  document.getElementById('q-index-label').textContent = `질문 ${idx + 1} / ${questions.length}`;
  document.getElementById('q-text').textContent = q.text;
  document.getElementById('q-back-effect').textContent = `${q.backLabel} (${q.backDelta > 0 ? '+' : ''}${q.backDelta}칸)`;
  document.getElementById('q-forward-effect').textContent = `${q.forwardLabel} (${q.forwardDelta > 0 ? '+' : ''}${q.forwardDelta}칸)`;

  const students = room.students || {};
  renderTrack(students, idx);
  renderStatusLists(students, idx);

  const nextBtn = document.getElementById('btn-next-question');
  nextBtn.textContent = (idx >= questions.length - 1) ? '활동 종료하기' : '다음 질문으로 →';

  const total = Object.keys(students).length;
  const answered = Object.keys(students).filter(k => students[k].responses && students[k].responses[idx]).length;
  document.getElementById('progress-note').textContent = `${answered} / ${total}명 응답 완료`;
}

function renderTrack(students, currentQuestionIndex) {
  const track = document.getElementById('track');
  track.querySelectorAll('.tick, .tick-label, .student-dot').forEach(el => el.remove());

  const max = 10;
  for (let i = -max; i <= max; i++) {
    if (i === 0) continue;
    const pct = 50 + (i / max) * 45;
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = pct + '%';
    track.appendChild(tick);
    if (i % 5 === 0) {
      const lbl = document.createElement('div');
      lbl.className = 'tick-label';
      lbl.style.left = pct + '%';
      lbl.textContent = i > 0 ? '+' + i : i;
      track.appendChild(lbl);
    }
  }

  const keys = Object.keys(students || {});
  const groups = {};
  keys.forEach(k => {
    const pos = clampPosition(students[k].position || 0);
    groups[pos] = groups[pos] || [];
    groups[pos].push(k);
  });

  Object.keys(groups).forEach(posStr => {
    const pos = Number(posStr);
    const pct = 50 + (pos / max) * 45;
    groups[posStr].forEach((key, i) => {
      const student = students[key];
      const answered = currentQuestionIndex >= 0 && student.responses && student.responses[currentQuestionIndex];
      const dot = document.createElement('div');
      dot.className = 'student-dot ' + (answered ? 'answered' : 'pending');
      dot.style.left = pct + '%';
      dot.style.top = (40 - i * 15) + 'px';
      dot.style.background = DOT_COLORS[Math.abs(hashCode(key)) % DOT_COLORS.length];
      dot.textContent = student.number || key;
      dot.addEventListener('mouseenter', e => showTooltip(e, student));
      dot.addEventListener('mousemove', moveTooltip);
      dot.addEventListener('mouseleave', hideTooltip);
      track.appendChild(dot);
    });
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
  if (nextIdx >= questions.length) {
    room.status = 'ended';
  } else {
    room.currentQuestionIndex = nextIdx;
  }
  persist();
  renderRoom();
  broadcastAll();
}

function renderEnded() {
  const students = room.students || {};
  const keys = Object.keys(students);
  keys.sort((a, b) => (students[b].position || 0) - (students[a].position || 0));

  document.getElementById('final-list').innerHTML = keys.map(k => {
    const s = students[k];
    return `<div class="final-row"><span>${escapeHtml(s.number || k)}</span><span><strong>${s.position || 0}</strong>칸</span></div>`;
  }).join('') || '<div class="empty-note">학생 데이터가 없습니다</div>';
}
