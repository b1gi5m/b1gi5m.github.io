/* ============================================================
   student.js — WebRTC(PeerJS) 버전
   ============================================================ */

let myPeer = null;
let myConn = null;
let myRoomCode = null;
let myStudentKey = null;
let myNumber = null;
let lastState = null;      // 호스트로부터 마지막으로 받은 상태
let reconnectAttempts = 0;
let reconnectTimer = null;
let heartbeatTimer = null;      // 좀비 연결(겉으론 열려있지만 실제론 끊긴 상태) 감지 + 상태 재동기화용
let connGeneration = 0;         // 매 연결 시도마다 증가 - 오래된 연결의 뒤늦은 이벤트를 무시하기 위함
let shuttingDown = false;       // 방 삭제 등으로 "의도적으로" 연결을 끊는 중인지 여부

let introSeenForTs = null;       // 이번 활동(activityStartedAt)에 대해 조건 확인 화면을 이미 봤는지
let lastRenderedQuestionIndex = null;
let pendingChoice = null;        // 아직 "확정"을 누르지 않은 임시 선택

// 요소가 없어도 나머지 리스너 등록이 멈추지 않도록 안전하게 바인딩
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn('요소를 찾을 수 없습니다:', id);
    return;
  }
  el.addEventListener(event, handler);
}

function showView(name) {
  ['join', 'waiting', 'active', 'ended'].forEach(v => {
    document.getElementById('view-' + v).style.display = (v === name) ? '' : 'none';
  });
  document.getElementById('topbar-room').style.display = (name === 'join') ? 'none' : '';
}

function setJoinError(msg) {
  document.getElementById('join-error').textContent = msg || '';
}

document.addEventListener('DOMContentLoaded', () => {
  on('btn-join', 'click', () => {
    const code = document.getElementById('join-code').value.trim();
    const number = document.getElementById('join-number').value.trim();
    setJoinError('');
    if (!/^\d{4}$/.test(code)) { setJoinError('방 번호 4자리를 정확히 입력해주세요.'); return; }
    if (!number) { setJoinError('학번을 입력해주세요.'); return; }
    startJoin(code, number);
  });

  on('btn-intro-continue', 'click', () => {
    if (lastState) introSeenForTs = lastState.activityStartedAt;
    renderFromState();
  });

  on('btn-choice-1', 'click', () => selectChoice('choice1'));
  on('btn-choice-2', 'click', () => selectChoice('choice2'));
  on('btn-confirm-choice', 'click', confirmChoice);

  window.addEventListener('beforeunload', () => {
    stopHeartbeat();
    if (myPeer) myPeer.destroy();
  });

  // 화면이 꺼져있거나 다른 앱으로 전환되어 있는 동안에는 모바일 브라우저가 타이머와
  // 네트워크 연결을 강제로 멈추는 경우가 많습니다. 그 사이의 연결 상태는 신뢰할 수
  // 없으므로, 화면이 다시 보이는 순간 무조건 처음부터 다시 연결합니다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handleBecameVisible();
  });
  window.addEventListener('pageshow', () => {
    if (document.visibilityState === 'visible') handleBecameVisible();
  });

  const saved = loadStudentSession();
  if (saved && saved.roomCode && saved.studentKey) {
    document.getElementById('join-code').value = saved.roomCode;
    document.getElementById('join-number').value = saved.number || '';
    startJoin(saved.roomCode, saved.number || saved.studentKey, saved.studentKey);
  }
});

function handleBecameVisible() {
  if (shuttingDown) return;
  if (!myRoomCode || !myStudentKey) return; // 아직 입장 전이면 할 일 없음
  reconnectAttempts = 0;
  startJoin(myRoomCode, myNumber, myStudentKey);
}

function startJoin(roomCode, number, existingKey) {
  shuttingDown = false;
  myRoomCode = roomCode;
  myNumber = number;
  myStudentKey = existingKey || sanitizeKey(number);
  reconnectAttempts = 0;
  introSeenForTs = null;
  lastRenderedQuestionIndex = null;
  pendingChoice = null;
  stopHeartbeat();

  document.getElementById('room-code-chip').textContent = roomCode;
  showView('waiting');
  document.getElementById('waiting-number').textContent = number;

  connGeneration++; // 이전 연결/피어의 뒤늦은 이벤트를 모두 무효화
  const myGen = connGeneration;
  if (myPeer) {
    try { myPeer.destroy(); } catch (e) {}
  }
  myPeer = new Peer();

  // 피어 연결 자체가 성공도 실패도 하지 않고 그냥 멈춰버리는 경우(네트워크 차단 등)를
  // 대비한 안전장치 - 일정 시간 안에 열리지 않으면 실패로 간주하고 재시도합니다.
  const openTimeout = setTimeout(() => {
    if (myGen !== connGeneration || shuttingDown) return;
    console.warn('피어 연결이 시간 내에 열리지 않아 다시 시도합니다.');
    try { myPeer.destroy(); } catch (e) {}
    scheduleReconnect();
  }, 9000);

  myPeer.on('open', () => {
    clearTimeout(openTimeout);
    if (myGen !== connGeneration || shuttingDown) return;
    connectToHost();
  });

  myPeer.on('error', err => {
    clearTimeout(openTimeout);
    if (myGen !== connGeneration || shuttingDown) return;
    console.error('Peer error:', err);
    handleConnectFailure();
  });
}

function connectToHost() {
  stopHeartbeat();
  if (myConn) {
    try { myConn.close(); } catch (e) {}
  }
  connGeneration++;
  const myGen = connGeneration;
  myConn = myPeer.connect(peerIdFor(myRoomCode), { reliable: true });

  // 호스트와의 데이터 연결도 마찬가지로, 계속 멈춰있으면 재시도하도록 타임아웃을 둡니다.
  const connOpenTimeout = setTimeout(() => {
    if (myGen !== connGeneration || shuttingDown) return;
    console.warn('호스트 연결이 시간 내에 열리지 않아 다시 시도합니다.');
    scheduleReconnect();
  }, 9000);

  myConn.on('open', () => {
    clearTimeout(connOpenTimeout);
    if (myGen !== connGeneration || shuttingDown) return;
    reconnectAttempts = 0;
    myConn.send({ type: 'join', studentKey: myStudentKey, number: myNumber });
    saveStudentSession(myRoomCode, myStudentKey, myNumber);
    startHeartbeat();
  });

  myConn.on('data', msg => {
    if (myGen !== connGeneration || shuttingDown) return;
    if (!msg || !msg.type) return;
    if (msg.type === 'state') {
      lastState = msg;
      renderFromState();
    } else if (msg.type === 'roomDeleted') {
      handleRoomDeleted();
    }
  });

  myConn.on('close', () => {
    clearTimeout(connOpenTimeout);
    if (myGen !== connGeneration || shuttingDown) return;
    stopHeartbeat();
    scheduleReconnect();
  });

  myConn.on('error', err => {
    clearTimeout(connOpenTimeout);
    if (myGen !== connGeneration || shuttingDown) return;
    console.error('연결 오류:', err);
    stopHeartbeat();
    scheduleReconnect();
  });
}

// 겉으로는 "열려있음"으로 보이지만 실제로는 끊어진 좀비 연결을 감지하고,
// 혹시 놓친 상태 업데이트(예: 방 삭제, 질문 전환)가 있다면 주기적으로 다시 동기화합니다.
function startHeartbeat() {
  stopHeartbeat();
  const myGen = connGeneration;
  heartbeatTimer = setInterval(() => {
    if (shuttingDown || myGen !== connGeneration || !myConn) return;
    try {
      if (!myConn.open) throw new Error('connection not open');
      myConn.send({ type: 'requestState', studentKey: myStudentKey, number: myNumber });
    } catch (e) {
      console.warn('하트비트 전송 실패 - 연결이 끊어진 것으로 간주합니다.', e);
      stopHeartbeat();
      scheduleReconnect();
    }
  }, 5000);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function handleConnectFailure() {
  if (shuttingDown) return;
  scheduleReconnect();
}

function handleRoomDeleted() {
  shuttingDown = true;
  connGeneration++; // 지금 닫는 연결에서 뒤늦게 발생하는 close/error 이벤트를 전부 무시하게 함
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (myConn) { try { myConn.close(); } catch (e) {} }
  if (myPeer) { try { myPeer.destroy(); } catch (e) {} }
  myConn = null;
  myPeer = null;
  myRoomCode = null;
  myStudentKey = null;
  myNumber = null;
  clearStudentSession();
  lastState = null;
  document.getElementById('join-code').value = '';
  document.getElementById('join-number').value = '';
  showView('join');
  setJoinError('선생님이 활동방을 종료했습니다. 새로 입장해주세요.');
}

function scheduleReconnect() {
  if (shuttingDown) return;
  stopHeartbeat();
  if (reconnectTimer) return;
  reconnectAttempts++;

  if (reconnectAttempts > 8) {
    clearStudentSession();
    showView('join');
    setJoinError('연결이 끊어졌습니다. 방 번호와 학번을 확인하고 다시 입장해주세요.');
    return;
  }

  const delay = Math.min(2000 * reconnectAttempts, 8000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shuttingDown) return;
    if (myPeer && !myPeer.destroyed) {
      connectToHost();
    } else {
      startJoin(myRoomCode, myNumber, myStudentKey);
    }
  }, delay);
}

function renderConditionList(targetElId, conditions) {
  const el = document.getElementById(targetElId);
  const cats = Object.keys(conditions || {});
  if (cats.length === 0) {
    el.innerHTML = '<div class="empty-note">아직 배정된 조건이 없습니다</div>';
    return;
  }
  el.innerHTML = cats.map(cat => `
    <div class="condition-item">
      <span class="cat">${escapeHtml(cat)}</span>
      <span class="val">${escapeHtml(conditions[cat])}</span>
    </div>
  `).join('');
}

function renderConditionStrip(targetElId, conditions) {
  const el = document.getElementById(targetElId);
  const cats = Object.keys(conditions || {});
  if (cats.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = cats.map(cat =>
    `<span class="cond-chip">${escapeHtml(cat)} ${escapeHtml(conditions[cat])}</span>`
  ).join('');
}

function describePosition(pos) {
  if (pos === 0) return '출발선';
  return pos > 0 ? `출발선보다 ${pos}칸 앞` : `출발선보다 ${Math.abs(pos)}칸 뒤`;
}

function renderFromState() {
  const state = lastState;
  if (!state) return;

  if (state.status === 'waiting') {
    showView('waiting');
    document.getElementById('waiting-number').textContent = myNumber;
  } else if (state.status === 'active') {
    showView('active');
    if (introSeenForTs !== state.activityStartedAt) {
      showIntro(state);
    } else {
      showQuestion(state);
    }
  } else if (state.status === 'ended') {
    showView('ended');
    renderEnded(state);
  }
}

function showIntro(state) {
  document.getElementById('sub-intro').style.display = '';
  document.getElementById('sub-question').style.display = 'none';
  renderConditionList('condition-list-intro', state.me.conditions);
}

function showQuestion(state) {
  document.getElementById('sub-intro').style.display = 'none';
  document.getElementById('sub-question').style.display = '';

  renderConditionStrip('condition-strip', state.me.conditions);

  const q = state.question;
  if (!q) {
    document.getElementById('q-index-label').textContent = '';
    document.getElementById('q-text').textContent = '질문을 기다리는 중입니다...';
    document.getElementById('choice-grid').style.display = 'none';
    document.getElementById('btn-confirm-choice').style.display = 'none';
    document.getElementById('answered-note').style.display = 'none';
    return;
  }

  if (state.questionIndex !== lastRenderedQuestionIndex) {
    lastRenderedQuestionIndex = state.questionIndex;
    pendingChoice = null;
  }

  document.getElementById('q-index-label').textContent = `질문 ${state.questionIndex + 1} / ${state.totalQuestions}`;
  document.getElementById('q-text').textContent = q.text;
  document.getElementById('label-1').textContent = q.choice1Label;
  document.getElementById('label-2').textContent = q.choice2Label;

  const btn1 = document.getElementById('btn-choice-1');
  const btn2 = document.getElementById('btn-choice-2');
  const confirmBtn = document.getElementById('btn-confirm-choice');
  const grid = document.getElementById('choice-grid');
  const note = document.getElementById('answered-note');

  grid.style.display = '';

  const alreadyAnswered = state.me.responses && state.me.responses[state.questionIndex];

  if (alreadyAnswered) {
    btn1.disabled = true;
    btn2.disabled = true;
    confirmBtn.style.display = 'none';
    btn1.classList.toggle('selected', alreadyAnswered.choice === 'choice1');
    btn2.classList.toggle('selected', alreadyAnswered.choice === 'choice2');
    note.style.display = '';
  } else {
    btn1.disabled = false;
    btn2.disabled = false;
    confirmBtn.style.display = '';
    confirmBtn.disabled = !pendingChoice;
    btn1.classList.toggle('selected', pendingChoice === 'choice1');
    btn2.classList.toggle('selected', pendingChoice === 'choice2');
    note.style.display = 'none';
  }
}

function selectChoice(choice) {
  if (!lastState || lastState.status !== 'active') return;
  const idx = lastState.questionIndex;
  const already = lastState.me.responses && lastState.me.responses[idx];
  if (already) return;
  pendingChoice = choice;
  showQuestion(lastState);
}

function confirmChoice() {
  if (!pendingChoice) return;
  submitChoice(pendingChoice);
}

function submitChoice(choice) {
  if (!lastState || lastState.status !== 'active' || !myConn || !myConn.open) return;
  const idx = lastState.questionIndex;
  const already = lastState.me.responses && lastState.me.responses[idx];
  if (already) return;

  document.getElementById('btn-choice-1').disabled = true;
  document.getElementById('btn-choice-2').disabled = true;
  document.getElementById('btn-confirm-choice').disabled = true;

  myConn.send({ type: 'respond', questionIndex: idx, choice });
}

function renderEnded(state) {
  document.getElementById('final-position').textContent = describePosition(state.me.position || 0);
  renderConditionList('final-condition-list', state.me.conditions);
}
