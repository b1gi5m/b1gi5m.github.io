/* ============================================================
   student.js — WebRTC(PeerJS) 버전
   ============================================================ */

let myPeer = null;
let myConn = null;
let myRoomCode = null;
let myStudentKey = null;
let myNumber = null;
let myGender = null;       // 학생이 직접 입력한 성별 (무작위 아님)
let lastState = null;      // 호스트로부터 마지막으로 받은 상태
let reconnectAttempts = 0;
let reconnectTimer = null;
let heartbeatTimer = null;      // 좀비 연결(겉으론 열려있지만 실제론 끊긴 상태) 감지 + 상태 재동기화용
let connGeneration = 0;         // 매 연결 시도마다 증가 - 오래된 연결의 뒤늦은 이벤트를 무시하기 위함
let shuttingDown = false;       // 방 삭제 등으로 "의도적으로" 연결을 끊는 중인지 여부

let introSeenForTs = null;       // 이번 활동(activityStartedAt)에 대해 조건 확인 화면을 이미 봤는지
let lastRenderedQuestionIndex = null;
let confirmedQuestionIndex = null; // "제출 완료" 피드백을 이미 보여준 질문 인덱스 (중복 방지)
let pendingChoice = null;        // 아직 "확정"을 누르지 않은 임시 선택
let toastTimer = null;

// 요소가 없어도 나머지 리스너 등록이 멈추지 않도록 안전하게 바인딩
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn('요소를 찾을 수 없습니다:', id);
    return;
  }
  el.addEventListener(event, handler);
}

// 숫자가 아닌 문자는 입력 즉시 걸러냅니다.
function onDigitsOnly(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    const digitsOnly = el.value.replace(/\D/g, '');
    if (digitsOnly !== el.value) el.value = digitsOnly;
  });
}

// ---------- 새 질문 도착 / 제출 완료 피드백 ----------
function triggerFlash() {
  const el = document.getElementById('flash-overlay');
  if (!el) return;
  el.classList.remove('flash-alert');
  void el.offsetWidth; // 강제 리플로우 - 같은 애니메이션을 다시 재생하기 위함
  el.classList.add('flash-alert');
}
function showToast(msg, kind) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('success', kind === 'success');
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
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
  on('btn-gender-male', 'click', () => selectGender('남'));
  on('btn-gender-female', 'click', () => selectGender('여'));

  // 숫자만 입력되도록 실시간으로 걸러줍니다.
  onDigitsOnly('join-code');

  on('btn-join', 'click', () => {
    const code = document.getElementById('join-code').value.trim();
    const number = document.getElementById('join-number').value.trim();
    setJoinError('');
    if (!/^\d{4}$/.test(code)) { setJoinError('입장 코드 4자리를 정확히 입력해주세요.'); return; }
    if (!/^\d{1,2}$/.test(number)) { setJoinError('번호를 선택해주세요.'); return; }
    if (!myGender) { setJoinError('성별을 선택해주세요.'); return; }
    startJoin(code, number, null, myGender);
  });

  on('btn-leave-waiting', 'click', leaveToJoinScreen);

  on('btn-intro-continue', 'click', () => {
    if (!lastState) return;
    introSeenForTs = lastState.activityStartedAt;
    if (myConn && myConn.open) {
      myConn.send({ type: 'introConfirmed' });
    }
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
    if (saved.gender) selectGender(saved.gender);
    startJoin(saved.roomCode, saved.number || saved.studentKey, saved.studentKey, saved.gender);
  }
});

function selectGender(g) {
  myGender = g;
  const maleBtn = document.getElementById('btn-gender-male');
  const femaleBtn = document.getElementById('btn-gender-female');
  if (maleBtn) maleBtn.classList.toggle('selected', g === '남');
  if (femaleBtn) femaleBtn.classList.toggle('selected', g === '여');
}

function leaveToJoinScreen() {
  shuttingDown = true;
  connGeneration++;
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
  setJoinError('');
  showView('join');
  shuttingDown = false; // 다시 정상적으로 입장할 수 있도록 원복
}

function handleBecameVisible() {
  if (shuttingDown) return;
  if (!myRoomCode || !myStudentKey) return; // 아직 입장 전이면 할 일 없음
  reconnectAttempts = 0;
  startJoin(myRoomCode, myNumber, myStudentKey, myGender);
}

function startJoin(roomCode, number, existingKey, gender) {
  shuttingDown = false;
  myRoomCode = roomCode;
  myNumber = number;
  myStudentKey = existingKey || sanitizeKey(number);
  if (gender) myGender = gender;
  reconnectAttempts = 0;
  introSeenForTs = null;
  lastRenderedQuestionIndex = null;
  confirmedQuestionIndex = null;
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
    myConn.send({ type: 'join', studentKey: myStudentKey, number: myNumber, gender: myGender });
    saveStudentSession(myRoomCode, myStudentKey, myNumber, myGender);
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
    } else if (msg.type === 'roomFull') {
      handleRoomFull(msg.maxStudents);
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
      myConn.send({ type: 'requestState', studentKey: myStudentKey, number: myNumber, gender: myGender });
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

function handleRoomFull(max) {
  shuttingDown = true;
  connGeneration++;
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (myConn) { try { myConn.close(); } catch (e) {} }
  if (myPeer) { try { myPeer.destroy(); } catch (e) {} }
  myConn = null;
  myPeer = null;
  clearStudentSession();
  lastState = null;
  showView('join');
  setJoinError(`이 방은 정원(최대 ${max || '?'}명)이 가득 찼습니다. 선생님께 문의해주세요.`);
  shuttingDown = false;
}

function scheduleReconnect() {
  if (shuttingDown) return;
  stopHeartbeat();
  if (reconnectTimer) return;
  reconnectAttempts++;

  if (reconnectAttempts > 8) {
    clearStudentSession();
    showView('join');
    setJoinError('연결이 끊어졌습니다. 입장 코드와 내 번호를 확인하고 다시 입장해주세요.');
    return;
  }

  const delay = Math.min(2000 * reconnectAttempts, 8000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shuttingDown) return;
    if (myPeer && !myPeer.destroyed) {
      connectToHost();
    } else {
      startJoin(myRoomCode, myNumber, myStudentKey, myGender);
    }
  }, delay);
}

function describePosition(pos) {
  if (pos === 0) return '출발선';
  return pos > 0 ? `출발선보다 ${pos}칸 앞` : `출발선보다 ${Math.abs(pos)}칸 뒤`;
}

// 페르소나 모드면 완성된 배경 서사를, 실제 조건 모드면 안내 문구를 보여줍니다.
function renderNarrativeInto(targetElId, headingElId, state, headingPersona, headingSelf, bodySelf) {
  const el = document.getElementById(targetElId);
  const headingEl = headingElId ? document.getElementById(headingElId) : null;

  if (state.mode === 'self' || !state.me.persona) {
    if (headingEl) headingEl.textContent = headingSelf;
    el.innerHTML = bodySelf;
    return;
  }
  if (headingEl) headingEl.textContent = headingPersona;
  el.innerHTML = buildNarrativeHtml(state.me.gender, state.me.persona);
}

function renderFromState() {
  const state = lastState;
  if (!state) return;

  if (state.status === 'waiting') {
    showView('waiting');
    document.getElementById('waiting-number').textContent = myNumber;
  } else if (state.status === 'intro' || state.status === 'active') {
    showView('active');
    if (introSeenForTs !== state.activityStartedAt) {
      showIntro(state);
    } else if (state.status === 'intro') {
      showWaitingForTeacher();
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
  document.getElementById('sub-waiting-teacher').style.display = 'none';
  document.getElementById('sub-question').style.display = 'none';
  renderNarrativeInto(
    'condition-list-intro', 'intro-heading', state,
    '나에게 배정된 조건', '이번 활동 방식 안내',
    '이번 활동은 무작위로 배정된 조건이 아니라, <strong>여러분 자신의 실제 상황</strong>을 기준으로 진행합니다. 각 질문을 읽고 스스로에게 해당하는지 생각해서 답해주세요.'
  );
}

function showWaitingForTeacher() {
  document.getElementById('sub-intro').style.display = 'none';
  document.getElementById('sub-waiting-teacher').style.display = '';
  document.getElementById('sub-question').style.display = 'none';
}

function showQuestion(state) {
  document.getElementById('sub-intro').style.display = 'none';
  document.getElementById('sub-waiting-teacher').style.display = 'none';
  document.getElementById('sub-question').style.display = '';

  const stripCard = document.getElementById('condition-strip-card');
  const cardGroup = document.getElementById('card-group');
  if (state.mode === 'self' || !state.me.persona) {
    stripCard.style.display = 'none';
    if (cardGroup) cardGroup.classList.add('solo-question');
  } else {
    stripCard.style.display = '';
    if (cardGroup) cardGroup.classList.remove('solo-question');
    document.getElementById('condition-strip-text').innerHTML =
      buildNarrativeHtml(state.me.gender, state.me.persona);
  }

  renderMyTrack('my-track', state.me.position || 0, state.otherPositions || []);

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
    triggerFlash();
    showToast('다음 질문 확인');
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
    if (confirmedQuestionIndex !== state.questionIndex) {
      confirmedQuestionIndex = state.questionIndex;
      const d = alreadyAnswered.delta || 0;
      triggerFlash();
      showToast(describeMoveResult(d));
    }
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

// 학생 본인 화면의 "내 위치" 트랙. 다른 학생은 익명 점으로만 표시하고
// (호버 등 상세정보 없음), 내 위치는 항상 뚜렷하게 표시됩니다.
function renderMyTrack(trackId, myPosition, otherPositions) {
  const track = document.getElementById(trackId);
  if (!track) return;
  track.querySelectorAll('.student-dot').forEach(el => el.remove());

  const myPos = clampPosition(myPosition || 0);
  const others = (otherPositions || []).map(p => clampPosition(p || 0));
  const range = computeTrackRange(others.concat([myPos]));

  const baseline = track.querySelector('.baseline');
  if (baseline) baseline.style.top = yPctForPos(0, range) + '%';

  const n = others.length;
  others.forEach((pos, i) => {
    const dot = document.createElement('div');
    dot.className = 'student-dot other';
    dot.style.left = xPctForIndex(i, n) + '%';
    dot.style.top = yPctForPos(pos, range) + '%';
    track.appendChild(dot);
  });

  const meDot = document.createElement('div');
  meDot.className = 'student-dot me';
  meDot.style.left = '50%';
  meDot.style.top = yPctForPos(myPos, range) + '%';
  meDot.textContent = '나';
  track.appendChild(meDot);
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
  const pos = state.me.position || 0;
  document.getElementById('final-position').textContent = describePosition(pos);

  const p = state.me.percentile;
  const pEl = document.getElementById('final-percentile');
  if (p) {
    if (pos >= 0) {
      pEl.textContent = `우리 반 ${p.total}명 중 상위 ${p.percentileFromTop}% (앞에서 ${p.rankFromTop}번째)`;
    } else {
      pEl.textContent = `우리 반 ${p.total}명 중 하위 ${p.percentileFromBottom}% (뒤에서 ${p.rankFromBottom}번째)`;
    }
    pEl.style.display = '';
  } else {
    pEl.style.display = 'none';
  }

  renderMyTrack('my-track-ended', pos, state.otherPositions || []);

  const cardEl = document.getElementById('final-condition-card');
  const groupEl = document.getElementById('card-group-ended');
  if (state.mode === 'self' || !state.me.persona) {
    cardEl.style.display = 'none';
    if (groupEl) groupEl.classList.add('solo-question');
  } else {
    cardEl.style.display = '';
    if (groupEl) groupEl.classList.remove('solo-question');
    document.getElementById('final-condition-list').innerHTML =
      buildNarrativeHtml(state.me.gender, state.me.persona);
  }

  renderAnswerHistory(state);
}

// 그동안 각 질문에 어떻게 답했는지 목록으로 보여줍니다.
function renderAnswerHistory(state) {
  const el = document.getElementById('answer-history-list');
  if (!el) return;
  const qs = state.allQuestions || [];
  const responses = state.me.responses || {};

  if (qs.length === 0) {
    el.innerHTML = '<div class="empty-note">응답 기록을 불러올 수 없습니다</div>';
    return;
  }

  el.innerHTML = qs.map((q, i) => {
    const r = responses[i];
    if (!r) {
      return `<div class="history-row"><div class="history-q">${i + 1}. ${escapeHtml(q.text)}</div><div class="history-a empty-note">응답 없음</div></div>`;
    }
    const label = r.choice === 'choice1' ? q.choice1Label : q.choice2Label;
    return `<div class="history-row"><div class="history-q">${i + 1}. ${escapeHtml(q.text)}</div><div class="history-a">${escapeHtml(label)}</div></div>`;
  }).join('');
}
