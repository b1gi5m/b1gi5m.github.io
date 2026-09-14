/* ============================================================
   common.js — 교사/학생 화면에서 공유하는 유틸리티
   (WebRTC / PeerJS 버전 — 외부 계정·서버 없이 동작)
   ============================================================ */

// 엑셀을 준비하지 않았을 때 사용할 기본 예시 페르소나
// (내러티브 안에서 **이렇게** 감싸면 그 부분만 볼드로 표시됩니다)
const DEFAULT_PERSONAS = [
  { age: 14, narrative: "**서울 대단지 아파트**에 거주하며, 방학마다 **해외여행**을 갈 수 있고, 원하는 학원을 **마음껏** 다닐 수 있는 **비장애인** 학생." },
  { age: 15, narrative: "**지방 소도시 다세대주택**에 거주하며, 형편에 맞춰 학원을 골라야 하고, **한부모 가정**에서 자란 **비장애인** 학생." },
  { age: 13, narrative: "**농어촌 마을**에 거주하며, 필요한 물건은 대부분 살 수 있고, **다문화가정**에서 자란 **비장애인** 학생." },
  { age: 14, narrative: "형편이 어려워 **아르바이트**를 해야 하고, 학원을 거의 다니지 못하며, **조부모님과 함께 사는** 학생." },
  { age: 15, narrative: "**신체적 장애**가 있고, 부모님과 함께 살며, 방학마다 해외여행을 갈 수 있는 학생." },
  { age: 13, narrative: "**새터민 가정** 출신이며, 형편에 맞춰 학원을 골라야 하고, 발달 장애가 있는 형제와 함께 자란 학생." }
];

const DEFAULT_QUESTIONS = [
  { text: "어쩔 수 없이 1~2년 단위로 이사를 다녀야 한다면", choice1Label: "해당함", choice1Delta: -1, choice2Label: "해당 없음", choice2Delta: 0 },
  { text: "4대 보험을 받지 못하는 일을 하고 있는 가정이라면", choice1Label: "해당함", choice1Delta: -1, choice2Label: "해당 없음", choice2Delta: 0 },
  { text: "가족 형태 때문에 학교나 또래 집단에서 놀림이나 곤란한 일을 겪은 적이 있다면", choice1Label: "해당함", choice1Delta: -1, choice2Label: "해당 없음", choice2Delta: 0 },
  { text: "매 학기 원하는 학원이나 방과후 활동을 자유롭게 선택할 수 있다면", choice1Label: "해당 없음", choice1Delta: 0, choice2Label: "해당함", choice2Delta: 1 }
];

// PeerJS 피어 ID 네임스페이스 접두사 (공개 브로커에서 다른 서비스와 충돌 방지용)
const PEER_ID_PREFIX = "sdl-room-";
function peerIdFor(code) {
  return PEER_ID_PREFIX + code;
}

// ---------- 방 코드 ----------
function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function sanitizeKey(raw) {
  return String(raw).trim().replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
}

// ---------- 배열 셔플 (페르소나 무작위 배정용) ----------
function shuffledCopy(arr) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 내러티브 렌더링 ----------
// "나는 중학교에 재학 중인 {나이}살 {성별}학생이다." 형태의 문장 템플릿 (엑셀 settings 시트에서 교체 가능)
const DEFAULT_OPENING_TEMPLATE = "나는 중학교에 재학 중인 {나이}살 {성별}학생이다.";

// 기본 활동 안내문구 (엑셀 settings 시트의 "안내문구" 항목으로 교체 가능)
const DEFAULT_INTRO_INSTRUCTIONS =
  "1. 여러분에게는 무작위로 정해진 가상의 캐릭터(또는 실제 자신의 상황)가 주어집니다.\n" +
  "2. 선생님이 질문을 하나씩 제시하면, 자신의 조건에 비추어 두 선택지 중 하나를 골라 확정해주세요.\n" +
  "3. 선택에 따라 화면 속 나의 위치가 앞뒤로 움직입니다.\n" +
  "4. 옆 친구와 위치를 비교하며 놀리거나 장난치지 않도록 유의해주세요.\n" +
  "5. 활동이 끝나면 나의 최종 위치와 반 전체에서의 순위를 확인할 수 있습니다.";

// 엑셀에 **이렇게** 적은 부분을 <strong>으로 변환합니다.
function parseBoldMarkup(text) {
  return escapeHtml(text || "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// 오프닝 문장 템플릿({나이}, {성별} 토큰 치환) + 내러티브 본문을 이어붙인 완성 문장을 만듭니다.
function buildFullNarrativeHtml(gender, age, narrativeRaw, openingTemplate) {
  const tpl = openingTemplate || DEFAULT_OPENING_TEMPLATE;
  const genderText = gender || "학생";
  const ageText = (age !== undefined && age !== null && age !== "") ? String(age) : "";
  const opening = escapeHtml(tpl)
    .replace(/\{나이\}/g, `<strong>${escapeHtml(ageText)}</strong>`)
    .replace(/\{성별\}/g, `<strong>${escapeHtml(genderText)}</strong>`);
  const body = parseBoldMarkup(narrativeRaw || "");
  return body ? `${opening} ${body}` : opening;
}

// ---------- 트랙(출발선) 시각화 - 교사/학생 화면 공용 스케일 로직 ----------
// 학생들이 실제로 위치한 범위(항상 0=출발선 포함)를 트랙 전체 높이에 꽉 채웁니다.
// 격차가 좁을 때는 화면을 거의 다 써서 과장되고, 격차가 이론상 최대치에 가까워질수록
// 점점 실제 비율에 가깝게 자연스러워집니다.
function computeTrackRange(positions, minWindow) {
  minWindow = minWindow === undefined ? 1.2 : minWindow;
  let min = Math.min(0, ...positions);
  let max = Math.max(0, ...positions);
  if (max - min < minWindow) {
    const mid = (max + min) / 2;
    min = mid - minWindow / 2;
    max = mid + minWindow / 2;
  }
  return { min, max };
}
function yPctForPos(pos, range, topPct, bottomPct) {
  topPct = topPct === undefined ? 10 : topPct;
  bottomPct = bottomPct === undefined ? 90 : bottomPct;
  const span = range.max - range.min;
  const normalized = span > 0 ? (pos - range.min) / span : 0.5;
  return bottomPct - normalized * (bottomPct - topPct);
}

// 학생 아이콘들의 가로 위치를 "가운데부터 바깥쪽으로" 채워나가는 순서로 배정합니다.
// (활동 시작 직후 전원이 출발선에 있을 때 화면 가운데부터 자연스럽게 채워지도록)
function centerOutOffsets(n) {
  const offsets = [];
  if (n <= 0) return offsets;
  offsets.push(0);
  let k = 1;
  while (offsets.length < n) {
    offsets.push(-k);
    if (offsets.length < n) offsets.push(k);
    k++;
  }
  return offsets;
}
function xPctForIndex(i, n) {
  if (n <= 1) return 50;
  const offsets = centerOutOffsets(n);
  const offset = offsets[i];
  const maxAbs = Math.max(1, ...offsets.map(o => Math.abs(o)));
  return 50 + (offset / maxAbs) * 42;
}

// ---------- 로컬스토리지 : 교사(호스트) 쪽 방 상태 ----------
// 방 상태 전체가 교사 기기의 localStorage 에 저장됩니다.
// (다른 기기에서는 절대 조회할 수 없고, 이 브라우저에서만 복구 가능합니다)
function teacherRoomStorageKey(code) {
  return "ssl_room::" + code;
}
function saveTeacherRoomState(code, room) {
  try {
    localStorage.setItem(teacherRoomStorageKey(code), JSON.stringify(room));
    localStorage.setItem("ssl_last_teacher_code", code);
  } catch (e) {
    console.error("방 상태 저장 실패:", e);
  }
}
function loadTeacherRoomState(code) {
  try {
    const raw = localStorage.getItem(teacherRoomStorageKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function loadLastTeacherCode() {
  return localStorage.getItem("ssl_last_teacher_code");
}

// ---------- 로컬스토리지 : 학생 쪽 세션(새로고침/재접속 복구용) ----------
const LS_STUDENT_KEY = "ssl_student_session";
function saveStudentSession(roomCode, studentKey, number, gender) {
  localStorage.setItem(LS_STUDENT_KEY, JSON.stringify({ roomCode, studentKey, number, gender }));
}
function loadStudentSession() {
  try {
    return JSON.parse(localStorage.getItem(LS_STUDENT_KEY) || "null");
  } catch (e) {
    return null;
  }
}
function clearStudentSession() {
  localStorage.removeItem(LS_STUDENT_KEY);
}

// ---------- 엑셀(xlsx) 파싱 ----------
// personas 시트 : 나이 | 내러티브   (한 행 = 완성된 캐릭터 한 명, 중복 없이 학생 수만큼 배정됨)
// questions 시트: 순서 | 질문내용 | 선택지1 | 선택지1칸수 | 선택지2 | 선택지2칸수
// settings 시트 : 항목 | 값        (예: 오프닝문장 | 나는 중학교에 재학 중인 {나이}살 {성별}이다.)
function parseConfigWorkbook(workbook) {
  const personaSheetName = workbook.SheetNames.find(n => n.trim() === "personas" || n.trim() === "페르소나") || workbook.SheetNames[0];
  const qSheetName = workbook.SheetNames.find(n => n.trim() === "questions" || n.trim() === "질문") || workbook.SheetNames[1];
  const settingsSheetName = workbook.SheetNames.find(n => n.trim() === "settings" || n.trim() === "설정");

  const personas = [];
  if (personaSheetName) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[personaSheetName], { defval: "" });
    rows.forEach(row => {
      const narrative = row["내러티브"] || row["narrative"];
      if (!narrative) return;
      const ageRaw = row["나이"] !== undefined ? row["나이"] : row["age"];
      const age = ageRaw !== "" && ageRaw !== undefined ? Number(ageRaw) : null;
      personas.push({ age, narrative: String(narrative).trim() });
    });
  }

  const questions = [];
  if (qSheetName) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[qSheetName], { defval: "" });
    rows
      .map(row => ({
        order: Number(row["순서"] || row["order"] || 0),
        text: String(row["질문내용"] || row["question"] || "").trim(),
        choice1Label: String(row["선택지1"] || row["choice1"] || "선택지1").trim(),
        choice1Delta: Number(row["선택지1칸수"] !== "" && row["선택지1칸수"] !== undefined ? row["선택지1칸수"] : (row["choice1_delta"] || 0)),
        choice2Label: String(row["선택지2"] || row["choice2"] || "선택지2").trim(),
        choice2Delta: Number(row["선택지2칸수"] !== "" && row["선택지2칸수"] !== undefined ? row["선택지2칸수"] : (row["choice2_delta"] || 0))
      }))
      .filter(q => q.text)
      .sort((a, b) => a.order - b.order)
      .forEach(q => questions.push(q));
  }

  let openingTemplate = null;
  let introInstructions = null;
  if (settingsSheetName) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[settingsSheetName], { defval: "" });
    rows.forEach(row => {
      const key = String(row["항목"] || row["key"] || "").trim();
      const val = row["값"] !== undefined ? row["값"] : row["value"];
      if ((key === "오프닝문장" || key === "opening_template") && val) {
        openingTemplate = String(val).trim();
      }
      if ((key === "안내문구" || key === "instructions") && val) {
        introInstructions = String(val).trim();
      }
    });
  }

  return { personas, questions, openingTemplate, introInstructions };
}

function clampPosition(pos, min = -10, max = 10) {
  return Math.max(min, Math.min(max, pos));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
