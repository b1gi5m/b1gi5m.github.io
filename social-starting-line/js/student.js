/* ============================================================
   student.js — WebRTC(PeerJS) 버전
   교사 브라우저(호스트)에 직접 데이터 연결을 맺어 상태를 주고받습니다.
   ============================================================ */

let myPeer = null;
let myConn = null;
let myRoomCode = null;
let myStudentKey = null;
let myNumber = null;
let lastState = null;   // 호스트로부터 마지막으로 받은 상태
let reconnectAttempts = 0;
let reconnectTimer = null;

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

  document.getElementById('btn-choice-back').addEventListener('click', () => submitChoice('back'));
  document.getElementById('btn-choice-forward').addEventListener('click', () => submitChoice('forward'));

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
  myPeer = new Peer(); // 임의의 학생용 ID (호스트 ID만 상대방이 알면 됨)

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
    if (msg && msg.type === 'state') {
      lastState = msg;
      renderFromState();
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

function scheduleReconnect() {
  if (reconnectTimer) return; // 이미 재시도 예약됨
  reconnectAttempts++;

  if (reconnectAttempts > 8) {
    setJoinErrorOnActiveView('선생님 화면과 연결할 수 없습니다. 방 번호를 다시 확인하거나, 선생님이 방을 열어두었는지 확인해주세요.');
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
      // peer 자체가 죽은 경우 처음부터 다시
      startJoin(myRoomCode, myNumber, myStudentKey);
    }
  }, delay);
}

function setJoinErrorOnActiveView(msg) {
  // 활동 화면에서 연결이 끊겼을 때 표시할 공간이 없으므로 콘솔에도 남김
  console.warn(msg);
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
    renderActive(state);
  } else if (state.status === 'ended') {
    showView('ended');
    renderEnded(state);
  }
}

function renderActive(state) {
  renderConditionList('condition-list', state.me.conditions);
  document.getElementById('my-position').textContent = describePosition(state.me.position || 0);

  const q = state.question;
  if (!q) {
    document.getElementById('q-index-label').textContent = '';
    document.getElementById('q-text').textContent = '질문을 기다리는 중입니다...';
    document.getElementById('choice-grid').style.display = 'none';
    document.getElementById('answered-note').style.display = 'none';
    return;
  }

  document.getElementById('q-index-label').textContent = `질문 ${state.questionIndex + 1} / ${state.totalQuestions}`;
  document.getElementById('q-text').textContent = q.text;
  document.getElementById('label-back').textContent = q.backLabel;
  document.getElementById('label-forward').textContent = q.forwardLabel;
  document.querySelector('#btn-choice-back .c-dir').textContent =
    q.backDelta === 0 ? '이동 없음' : (q.backDelta > 0 ? `${q.backDelta}칸 앞으로` : `${Math.abs(q.backDelta)}칸 뒤로`);
  document.querySelector('#btn-choice-forward .c-dir').textContent =
    q.forwardDelta === 0 ? '이동 없음' : (q.forwardDelta > 0 ? `${q.forwardDelta}칸 앞으로` : `${Math.abs(q.forwardDelta)}칸 뒤로`);

  const alreadyAnswered = state.me.responses && state.me.responses[state.questionIndex];
  const grid = document.getElementById('choice-grid');
  const note = document.getElementById('answered-note');
  const backBtn = document.getElementById('btn-choice-back');
  const fwdBtn = document.getElementById('btn-choice-forward');

  grid.style.display = '';
  backBtn.disabled = !!alreadyAnswered;
  fwdBtn.disabled = !!alreadyAnswered;
  backBtn.classList.toggle('selected', !!(alreadyAnswered && alreadyAnswered.choice === 'back'));
  fwdBtn.classList.toggle('selected', !!(alreadyAnswered && alreadyAnswered.choice === 'forward'));
  note.style.display = alreadyAnswered ? '' : 'none';
}

function submitChoice(choice) {
  if (!lastState || lastState.status !== 'active' || !myConn || !myConn.open) return;
  const idx = lastState.questionIndex;
  const already = lastState.me.responses && lastState.me.responses[idx];
  if (already) return;

  // 낙관적으로 즉시 버튼 잠금 (호스트 응답이 오면 최종 확정됨)
  document.getElementById('btn-choice-back').disabled = true;
  document.getElementById('btn-choice-forward').disabled = true;

  myConn.send({ type: 'respond', questionIndex: idx, choice });
}

function renderEnded(state) {
  document.getElementById('final-position').textContent = describePosition(state.me.position || 0);
  renderConditionList('final-condition-list', state.me.conditions);
}
