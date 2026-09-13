/* ============================================================
   common.js — 교사/학생 화면에서 공유하는 유틸리티
   (WebRTC / PeerJS 버전 — 외부 계정·서버 없이 동작)
   ============================================================ */

// 엑셀을 업로드하지 않았을 때 사용할 기본 예시 데이터
// (선택지는 표가 아니라 문장으로 이어붙여지므로, 되도록 "~하는", "~할 수 있는"처럼
//  형용사형으로 끝나거나 "비장애인"처럼 명사형으로 자연스럽게 문장이 되도록 작성합니다)
const DEFAULT_CONDITIONS = [
  { category: "주거 형태", options: ["서울 대단지 아파트에 거주하는", "지방 소도시 다세대주택에 거주하는", "농어촌 마을에 거주하는", "해외에서 거주하다 최근 귀국한"] },
  { category: "경제적 상황", options: ["방학마다 해외여행을 갈 수 있는", "필요한 물건은 대부분 살 수 있는", "형편이 어려워 아르바이트를 해야 하는"] },
  { category: "학원/방과후", options: ["원하는 학원을 마음껏 다닐 수 있는", "형편에 맞춰 학원을 골라야 하는", "학원을 거의 다니지 못하는"] },
  { category: "장애 여부", options: ["비장애인", "신체적 장애가 있는", "발달 장애가 있는"] },
  { category: "가족 형태", options: ["부모님과 함께 사는", "한부모 가정에서 자란", "조부모님과 함께 사는"] },
  { category: "이주배경", options: ["이주배경이 없는", "다문화가정에서 자란", "새터민 가정 출신인"] }
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

// Firebase 시절 흔적이 아니라 일반적인 안전한 key 문자열 변환용
function sanitizeKey(raw) {
  return String(raw).trim().replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
}

// ---------- 조건 배정 ----------
// 성별은 학생이 입장할 때 직접 입력한 값을 그대로 사용하고(무작위 아님),
// 나이는 조건에서 아예 제외합니다. 나머지 항목만 엑셀 설정에서 무작위로 배정합니다.
// 혹시 엑셀에 "성별"이나 "나이" 항목이 남아있어도 무시합니다(자기 입력 값과 충돌 방지).
function assignConditionsForStudent(conditionsConfig, gender) {
  const result = {};
  if (gender) result["성별"] = gender;
  (conditionsConfig || []).forEach(cond => {
    if (cond.category === "성별" || cond.category === "나이") return;
    const options = cond.options || [];
    if (options.length === 0) return;
    const pick = options[Math.floor(Math.random() * options.length)];
    result[cond.category] = pick;
  });
  return result;
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
// conditions 시트: 항목 | 선택지 (쉼표로 구분)
// questions 시트 : 순서 | 질문내용 | 선택지1 | 선택지1칸수 | 선택지2 | 선택지2칸수
//   (칸수는 이동할 칸 수를 그대로 의미 — 음수면 뒤로, 양수면 앞으로, 0이면 이동 없음.
//    두 선택지 중 어느 쪽이 앞/뒤인지 열 위치로 드러나지 않도록 대칭적인 이름을 사용합니다)
function parseConfigWorkbook(workbook) {
  const condSheetName = workbook.SheetNames.find(n => n.trim() === "conditions" || n.trim() === "조건") || workbook.SheetNames[0];
  const qSheetName = workbook.SheetNames.find(n => n.trim() === "questions" || n.trim() === "질문") || workbook.SheetNames[1];

  const conditions = [];
  if (condSheetName) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[condSheetName], { defval: "" });
    rows.forEach(row => {
      const category = row["항목"] || row["category"] || row["Category"];
      const optsRaw = row["선택지"] || row["options"] || row["Options"];
      if (!category || !optsRaw) return;
      const options = String(optsRaw).split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (options.length) conditions.push({ category: String(category).trim(), options });
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

  return { conditions, questions };
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
