/**
 * poller.js — 60초 간격 새 글 감지 (v1.0.1: 통합 폴링 엔드포인트 1회 호출).
 *
 * 매 주기 = GET /api/my/desktop-activity 단 1회:
 *   200 { ok:true, channels:[{id,last_post_at}], notices:{max_id,count} }
 *     → 채널별 last_post_at·공지 max_id 를 저장된 기준값과 비교(기존 로직 그대로).
 *       커진 채널 → 알림 1건 + onNewAlert 콜백, 클릭 시 /channels?ch=<id>
 *       (v3 에는 /channels/[id] 페이지 라우트가 없음 — 쿼리 파라미터 방식이 실제 경로).
 *       max_id 증가 → 새 공지 알림 + onNewAlert 콜백. posted_at 은
 *       '게시 만료일' 의미라 절대 사용하지 않는다(id 기준).
 *   401 (미로그인) → 연속 3회부터 "다시 로그인해 주세요" 알림 딱 1회만(reloginNotified).
 *   그 외(네트워크 오류·5xx) → 조용히 다음 주기로(미로그인 streak 에 세지 않음).
 *
 * 첫 주기(저장된 기준값이 없는 항목)는 알림 없이 기준값만 저장 — 설치 직후 알림 폭탄 방지.
 *
 * 쿠키: net.fetch({credentials:'include'}) 기본. SameSite 등으로 쿠키가 안 붙어
 * 401 이 나오면 session.defaultSession.cookies.get 으로 Cookie 헤더를 수동 구성해
 * 1회 재시도하는 폴백 유지(재시도도 401 이면 진짜 미로그인으로 판정).
 *
 * (구 v1.0.0 은 /api/me → /api/channels/activity → /api/my/notices-activity 3회
 *  호출이었다 — 이 3개 v3 엔드포인트는 구버전 앱이 아직 쓰므로 서버에서 삭제 금지.)
 */
"use strict";

const { net, session, Notification } = require("electron");
const store = require("./store");

const INTERVAL_MS = 60 * 1000; // 60초 (통합 엔드포인트 1회 — 서버 폴링 하한 60초 준수)
const ACTIVITY_PATH = "/api/my/desktop-activity";
const RELOGIN_STREAK_THRESHOLD = 3;

let timer = null;
let initialTimer = null;
let notLoggedInStreak = 0;
let running = false; // 주기 겹침 방지
/** startPolling 에서 주입되는 { baseUrl, openPath, onNewAlert } */
let opts = null;

/** 세션 쿠키로 Cookie 헤더 문자열 수동 구성 (폴백용). */
async function buildCookieHeader(url) {
  try {
    const cookies = await session.defaultSession.cookies.get({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (_err) {
    return "";
  }
}

/** res 에서 JSON 파싱 (실패 시 null). */
async function parseJson(res) {
  try {
    return await res.json();
  } catch (_err) {
    return null;
  }
}

/**
 * 폴백 전용: Cookie 헤더를 수동 구성해 1회 GET.
 * 세션에 쿠키가 하나도 없으면 요청하지 않고 null 반환.
 *
 * net.fetch 가 아니라 net.request 를 쓴다 — fetch 표준에서 "cookie" 는
 * forbidden header 라 스펙 준수 구현이 조용히 제거할 수 있는 반면,
 * net.request 의 setHeader 는 지정이 보장된다.
 */
function requestWithCookieHeader(url, cookieHeader) {
  return new Promise((resolve) => {
    const req = net.request({ url, useSessionCookies: false });
    req.setHeader("accept", "application/json");
    req.setHeader("cookie", cookieHeader);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (_err) {
          /* json = null */
        }
        resolve({ status: res.statusCode, json });
      });
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function apiGetWithManualCookie(baseUrl, apiPath) {
  const cookieHeader = await buildCookieHeader(baseUrl);
  if (!cookieHeader) return null;
  return requestWithCookieHeader(baseUrl + apiPath, cookieHeader);
}

/**
 * JSON GET. 1차: credentials:'include'. 401 이면 쿠키 헤더 수동 구성으로 1회 재시도.
 * 반환: { status, json } — json 은 파싱 실패 시 null.
 */
async function apiGet(baseUrl, apiPath) {
  const res = await net.fetch(baseUrl + apiPath, {
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (res.status === 401) {
    const retry = await apiGetWithManualCookie(baseUrl, apiPath);
    if (retry !== null) return retry;
  }
  return { status: res.status, json: await parseJson(res) };
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (onClick) n.on("click", onClick);
  n.show();
}

/** 새 글 알림 공통 — 토스트 + main 쪽 시각 표시(트레이 깜빡임 등) 콜백. */
function notifyNewContent(title, body, onClick) {
  notify(title, body, onClick);
  if (opts !== null && typeof opts.onNewAlert === "function") {
    try {
      opts.onNewAlert();
    } catch (_err) {
      /* 시각 표시 실패는 알림 자체에 영향 없음 */
    }
  }
}

/** 401(미로그인) 처리 — 연속 3회부터 재로그인 알림 1회만. */
function handleNotLoggedIn(openPath) {
  notLoggedInStreak += 1;
  const state = store.get();
  if (notLoggedInStreak >= RELOGIN_STREAK_THRESHOLD && !state.reloginNotified) {
    store.set({ reloginNotified: true });
    notify("실습가이드", "로그인이 풀렸어요. 다시 로그인해 주세요.", () =>
      openPath("/")
    );
  }
}

/** 채널 새 글 판정 — 통합 응답의 channels 배열을 기존 비교 로직 그대로 적용. */
function applyChannels(rawChannels, openPath) {
  const channels = Array.isArray(rawChannels) ? rawChannels : [];

  const lastSeen = { ...store.get().lastSeenByChannel };
  const changedIds = [];

  for (const ch of channels) {
    if (!ch || ch.id == null) continue;
    const id = String(ch.id);
    const latest = ch.last_post_at ?? null;
    if (!(id in lastSeen)) {
      // 첫 관측 채널 — 기준값만 저장, 알림 없음
      lastSeen[id] = latest;
      continue;
    }
    const prev = lastSeen[id];
    const isNewer =
      latest !== null &&
      (prev === null || new Date(latest).getTime() > new Date(prev).getTime());
    if (isNewer) {
      changedIds.push(id);
      lastSeen[id] = latest;
    }
  }

  store.set({ lastSeenByChannel: lastSeen });

  if (changedIds.length > 0) {
    const first = changedIds[0];
    const body =
      changedIds.length === 1
        ? "채널에 새 글이 올라왔어요."
        : `채널 ${changedIds.length}곳에 새 글이 올라왔어요.`;
    notifyNewContent("실습가이드 — 새 채널 글", body, () =>
      openPath(`/channels?ch=${encodeURIComponent(first)}`)
    );
  }
}

/** 공지 새 글 판정 — 통합 응답의 notices.max_id(숫자) 증가만 본다. */
function applyNotices(rawNotices, openPath) {
  const maxId =
    rawNotices && typeof rawNotices.max_id === "number"
      ? rawNotices.max_id
      : null;
  const prev = store.get().lastNoticeMaxId;

  if (prev === null) {
    // 기준값 없음 — 저장만. 공지 0건이어도 서버가 max_id:0 을 반환하므로
    // 기준값 0 이 저장되고, 이후 첫 공지(id>0)부터 정상 알림된다.
    if (maxId !== null) store.set({ lastNoticeMaxId: maxId });
    return;
  }
  if (maxId !== null && maxId > prev) {
    store.set({ lastNoticeMaxId: maxId });
    notifyNewContent("실습가이드 — 새 공지", "새 공지가 게시되었어요.", () =>
      openPath("/home")
    );
  }
}

/** 한 주기 실행 — 통합 엔드포인트 1회 호출. 모든 오류는 조용히 삼킨다. */
async function runCycle() {
  if (running || opts === null) return;
  // 알림 끔(웹 앱설정) — 아무 요청도 하지 않고 리턴.
  // 모든 알림·서버 확인 중단(재로그인 안내 포함 전부).
  if (store.get().notificationsEnabled === false) return;
  running = true;
  try {
    const { baseUrl, openPath } = opts;
    const { status, json } = await apiGet(baseUrl, ACTIVITY_PATH);
    if (status === 401) {
      // apiGet 이 쿠키 수동 폴백까지 재시도한 뒤의 401 = 진짜 미로그인
      handleNotLoggedIn(openPath);
    } else if (status === 200 && json !== null && json.ok === true) {
      notLoggedInStreak = 0;
      if (store.get().reloginNotified) store.set({ reloginNotified: false });
      applyChannels(json.channels, openPath);
      applyNotices(json.notices, openPath);
    }
    // 그 외(네트워크/서버 문제·404) — 판단 불가, 조용히 다음 주기로
  } catch (_err) {
    // 네트워크 오류 등 — 조용히 다음 주기로
  } finally {
    running = false;
  }
}

/**
 * 폴링 시작.
 * @param {object} options
 * @param {string} options.baseUrl  예: https://practicum-guide.vercel.app
 * @param {(path: string) => void} options.openPath  창 복원 + 해당 화면 loadURL
 * @param {() => void} [options.onNewAlert]  새 글 알림 시 main 쪽 시각 표시 콜백
 */
function startPolling(options) {
  if (timer !== null) return;
  opts = options;
  // 앱 시작 30초 후 첫 주기(세션 쿠키 로드 여유), 이후 60초 간격
  initialTimer = setTimeout(runCycle, 30 * 1000);
  timer = setInterval(runCycle, INTERVAL_MS);
}

/** 트레이 "지금 확인" — 즉시 폴링 1주기 실행(주기 겹침은 running 이 막음). */
function runOnce() {
  return runCycle();
}

function stopPolling() {
  if (initialTimer !== null) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 알림 재개 직전 호출 — 알림 없이 기준값만 최신으로 갱신해,
 * 꺼둔 사이 올라온 글들이 재개 순간 뒤늦게 알림으로 튀는 것을 막는다.
 * (알림 끔 = 서버 확인도 끔이 확정 설계라, 재개 시점 이후의 새 글만 알린다.)
 * v1.0.1: 통합 엔드포인트 1회 호출로 채널·공지 기준값을 한 번에 갱신.
 * 실패는 조용히 무시 — 최악의 경우 재개 직후 묵은 글 알림이 최대 2건 올 뿐.
 */
async function refreshBaselines(baseUrl) {
  try {
    const { status, json } = await apiGet(baseUrl, ACTIVITY_PATH);
    if (status !== 200 || json === null || json.ok !== true) return;
    const channels = Array.isArray(json.channels) ? json.channels : [];
    const lastSeen = { ...store.get().lastSeenByChannel };
    for (const c of channels) {
      if (!c || c.id == null) continue;
      lastSeen[String(c.id)] = c.last_post_at ?? null;
    }
    store.set({ lastSeenByChannel: lastSeen });
    if (json.notices && typeof json.notices.max_id === "number") {
      store.set({ lastNoticeMaxId: json.notices.max_id });
    }
  } catch (_err) {
    /* 네트워크 오류 등 — 조용히 무시 */
  }
}

module.exports = { startPolling, stopPolling, runOnce, refreshBaselines };
