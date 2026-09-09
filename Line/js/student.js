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

let introSeenForTs = null;       // 이번 활동(activityStartedAt)에 대해 조건 확인 화면을 이미 봤는지
let lastRenderedQuestionIndex = null;
let pendingChoice = null;        // 아직 "확정"을 누르지 않은 임시 선택

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
  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('join-code').value.trim();
    const number = document.getElementById('join-number').value.trim();
    setJoinError('');
    if (!/^\d{4}$/.test(code)) { setJoinError('방 번호 4자리를 정확히 입력해주세요.'); return; }
    if (!number) { setJoinError('학번을 입력해주세요.'); return; }
    startJoin(code, number);
  });

  document.getElementById('btn-intro-continue').addEventListener('click', () => {
    if (lastState) introSeenForTs = lastState.activityStartedAt;
    renderFromState();
  });

  document.getElementById('btn-toggle-condition').addEventListener('click', () => {
    const pop = document.getElementById('condition-popover');
    pop.style.display = (pop.style.display === 'none' || !pop.style.display) ? '' : 'none';
  });

  document.getElementById('btn-choice-back').addEventListener('click', () => selectChoice('back'));
  document.getElementById('btn-choice-forward').addEventListener('click', () => selectChoice('forward'));
  document.getElementById('btn-confirm-choice').addEventListener('click', confirmChoice);

  window.addEventListener('beforeunload', () => {
    if (myPeer) myPeer.destroy();
  });

  const saved = loadStudentSession();
  if (saved && saved.roomCode && saved.studentKey) {
    document.getElementById('join-code').value = saved.roomCode;
    document.getElementById('join-number').value = saved.number || '';
    startJoin(saved.roomCode, saved.number || saved.studentKey, saved.studentKey);
  }
});

function startJoin(roomCode, number, existingKey) {
  myRoomCode = roomCode;
  myNumber = number;
  myStudentKey = existingKey || sanitizeKey(number);
  reconnectAttempts = 0;

  document.getElementById('room-code-chip').textContent = roomCode;
  showView('waiting');
  document.getElementById('waiting-number').textContent = number;

  if (myPeer) {
    try { myPeer.destroy(); } catch (e) {}
  }
  myPeer = new Peer();

  myPeer.on('open', () => connectToHost());

  myPeer.on('error', err => {
    console.error('Peer error:', err);
    handleConnectFailure();
  });
}

function connectToHost() {
  if (myConn) {
    try { myConn.close(); } catch (e) {}
  }
  myConn = myPeer.connect(peerIdFor(myRoomCode), { reliable: true });

  myConn.on('open', () => {
    reconnectAttempts = 0;
    myConn.send({ type: 'join', studentKey: myStudentKey, number: myNumber });
    saveStudentSession(myRoomCode, myStudentKey, myNumber);
  });

  myConn.on('data', msg => {
    if (!msg || !msg.type) return;
    if (msg.type === 'state') {
      lastState = msg;
      renderFromState();
    } else if (msg.type === 'roomDeleted') {
      handleRoomDeleted();
    }
  });

  myConn.on('close', () => {
    scheduleReconnect();
  });

  myConn.on('error', err => {
    console.error('연결 오류:', err);
    scheduleReconnect();
  });
}

function handleConnectFailure() {
  scheduleReconnect();
}

function handleRoomDeleted() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (myConn) { try { myConn.close(); } catch (e) {} }
  if (myPeer) { try { myPeer.destroy(); } catch (e) {} }
  clearStudentSession();
  lastState = null;
  document.getElementById('join-code').value = '';
  document.getElementById('join-number').value = '';
  showView('join');
  setJoinError('선생님이 활동방을 종료했습니다. 새로 입장해주세요.');
}

function scheduleReconnect() {
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

  renderConditionList('condition-popover-list', state.me.conditions);

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
  document.getElementById('label-back').textContent = q.backLabel;
  document.getElementById('label-forward').textContent = q.forwardLabel;

  const backBtn = document.getElementById('btn-choice-back');
  const fwdBtn = document.getElementById('btn-choice-forward');
  const confirmBtn = document.getElementById('btn-confirm-choice');
  const grid = document.getElementById('choice-grid');
  const note = document.getElementById('answered-note');

  grid.style.display = '';

  const alreadyAnswered = state.me.responses && state.me.responses[state.questionIndex];

  if (alreadyAnswered) {
    backBtn.disabled = true;
    fwdBtn.disabled = true;
    confirmBtn.style.display = 'none';
    backBtn.classList.toggle('selected', alreadyAnswered.choice === 'back');
    fwdBtn.classList.toggle('selected', alreadyAnswered.choice === 'forward');
    note.style.display = '';
  } else {
    backBtn.disabled = false;
    fwdBtn.disabled = false;
    confirmBtn.style.display = '';
    confirmBtn.disabled = !pendingChoice;
    backBtn.classList.toggle('selected', pendingChoice === 'back');
    fwdBtn.classList.toggle('selected', pendingChoice === 'forward');
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

  document.getElementById('btn-choice-back').disabled = true;
  document.getElementById('btn-choice-forward').disabled = true;
  document.getElementById('btn-confirm-choice').disabled = true;

  myConn.send({ type: 'respond', questionIndex: idx, choice });
}

function renderEnded(state) {
  document.getElementById('final-position').textContent = describePosition(state.me.position || 0);
  renderConditionList('final-condition-list', state.me.conditions);
}
