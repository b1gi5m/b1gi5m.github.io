/* ============================================================
   common.js — 교사/학생 화면에서 공유하는 유틸리티
   (WebRTC / PeerJS 버전 — 외부 계정·서버 없이 동작)
   ============================================================ */

// 엑셀을 업로드하지 않았을 때 사용할 기본 예시 데이터
const DEFAULT_CONDITIONS = [
  { category: "나이", options: ["13세", "14세", "15세"] },
  { category: "성별", options: ["남성", "여성"] },
  { category: "이주배경", options: ["없음", "다문화가정", "중도입국가정", "새터민가정"] },
  { category: "부모의 경제적 상황", options: ["상", "중", "하"] },
  { category: "장애 여부", options: ["없음", "신체적 장애", "발달 장애"] },
  { category: "출신 지역", options: ["대도시", "중소도시", "농어촌", "해외"] },
  { category: "기타 조건", options: ["한부모가정", "조손가정", "다자녀가정", "해당없음"] }
];

const DEFAULT_QUESTIONS = [
  { text: "어쩔 수 없이 1~2년 단위로 이사를 다녀야 한다면", forwardLabel: "해당 없음", backLabel: "해당함", forwardDelta: 0, backDelta: -1 },
  { text: "4대 보험을 받지 못하는 일을 하고 있는 가정이라면", forwardLabel: "해당 없음", backLabel: "해당함", forwardDelta: 0, backDelta: -1 },
  { text: "가족 형태 때문에 학교나 또래 집단에서 놀림이나 곤란한 일을 겪은 적이 있다면", forwardLabel: "해당 없음", backLabel: "해당함", forwardDelta: 0, backDelta: -1 },
  { text: "매 학기 원하는 학원이나 방과후 활동을 자유롭게 선택할 수 있다면", forwardLabel: "해당함", backLabel: "해당 없음", forwardDelta: 1, backDelta: 0 }
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

// ---------- 조건 무작위 배정 ----------
function assignRandomConditions(conditionsConfig) {
  const result = {};
  (conditionsConfig || []).forEach(cond => {
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
function saveStudentSession(roomCode, studentKey, number) {
  localStorage.setItem(LS_STUDENT_KEY, JSON.stringify({ roomCode, studentKey, number }));
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
// questions 시트 : 순서 | 질문내용 | 뒤로버튼텍스트 | 뒤로칸수 | 앞으로버튼텍스트 | 앞으로칸수
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
        backLabel: String(row["뒤로버튼텍스트"] || row["back_label"] || "해당함").trim(),
        backDelta: Number(row["뒤로칸수"] !== "" && row["뒤로칸수"] !== undefined ? row["뒤로칸수"] : (row["back_delta"] || -1)),
        forwardLabel: String(row["앞으로버튼텍스트"] || row["forward_label"] || "해당 없음").trim(),
        forwardDelta: Number(row["앞으로칸수"] !== "" && row["앞으로칸수"] !== undefined ? row["앞으로칸수"] : (row["forward_delta"] || 0))
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
