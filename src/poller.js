/**
 * poller.js — 5분 간격 새 글 감지 (계획서 §5).
 *
 * 매 주기:
 *  1) GET /api/me — teacher:null 이면 이번 주기 전부 건너뜀.
 *     미로그인 연속 3회부터는 "다시 로그인해 주세요" 알림 딱 1회만(reloginNotified).
 *  2) GET /api/channels/activity — 채널별 last_post_at 을 저장값과 비교.
 *     커진 채널이 있으면 알림 1건 → 클릭 시 /channels?ch=<id> 로 이동
 *     (v3 에는 /channels/[id] 페이지 라우트가 없음 — 쿼리 파라미터 방식이 실제 경로).
 *  3) GET /api/my/notices-activity — max_id(숫자) 증가 판정. posted_at 은
 *     '게시 만료일' 의미라 절대 사용하지 않는다(id 기준).
 *
 * 첫 주기(저장된 기준값이 없는 항목)는 알림 없이 기준값만 저장 — 설치 직후 알림 폭탄 방지.
 * 네트워크 오류·401·404 는 조용히 다음 주기로.
 *
 * 쿠키: net.fetch({credentials:'include'}) 기본. SameSite 등으로 쿠키가 안 붙어
 * 401 이 나오면 session.defaultSession.cookies.get 으로 Cookie 헤더를 수동 구성해
 * 1회 재시도하는 폴백을 처음부터 내장.
 * 단 /api/me 는 v3 미들웨어 PUBLIC_PATHS 라 쿠키가 안 붙어도 401 이 아니라
 * 200 + {teacher:null} 이 온다 — 그래서 checkLoggedIn 은 teacher:null 일 때도
 * 같은 쿠키 헤더 폴백으로 1회 재시도한 뒤 미로그인 판정을 내린다.
 */
"use strict";

const { net, session, Notification } = require("electron");
const store = require("./store");

const INTERVAL_MS = 5 * 60 * 1000; // 5분 (서버 폴링 하한 60초 ≪ 준수)
const RELOGIN_STREAK_THRESHOLD = 3;

let timer = null;
let initialTimer = null;
let notLoggedInStreak = 0;
let running = false; // 주기 겹침 방지

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

/** 로그인 확인. 로그인=true. 미로그인 처리(연속 3회 → 1회 알림)까지 담당. */
async function checkLoggedIn(baseUrl, openPath) {
  let { status, json } = await apiGet(baseUrl, "/api/me");
  if (status === 200 && json !== null && !json.teacher) {
    // /api/me 는 서버 미들웨어의 공개 경로라 쿠키가 안 붙어도 401 대신
    // 200 + {teacher:null} 이 온다(apiGet 의 401 폴백이 여기선 발동 불가).
    // SameSite 등으로 net.fetch 에 쿠키가 안 붙은 경우일 수 있으므로
    // Cookie 헤더 수동 구성으로 1회 재시도한 결과로 최종 판정한다.
    const retry = await apiGetWithManualCookie(baseUrl, "/api/me");
    if (retry !== null) ({ status, json } = retry);
  }
  if (status !== 200 || json === null) {
    // 네트워크/서버 문제 — 로그인 여부 판단 불가, 이번 주기 조용히 스킵
    return false;
  }
  if (!json.teacher) {
    notLoggedInStreak += 1;
    const state = store.get();
    if (notLoggedInStreak >= RELOGIN_STREAK_THRESHOLD && !state.reloginNotified) {
      store.set({ reloginNotified: true });
      notify("실습가이드", "로그인이 풀렸어요. 다시 로그인해 주세요.", () =>
        openPath("/")
      );
    }
    return false;
  }
  notLoggedInStreak = 0;
  if (store.get().reloginNotified) store.set({ reloginNotified: false });
  return true;
}

/** 채널 새 글 판정. */
async function checkChannels(baseUrl, openPath) {
  const { status, json } = await apiGet(baseUrl, "/api/channels/activity");
  if (status !== 200 || json === null || json.ok !== true) return;
  const channels = Array.isArray(json.channels) ? json.channels : [];

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
    notify("실습가이드 — 새 채널 글", body, () =>
      openPath(`/channels?ch=${encodeURIComponent(first)}`)
    );
  }
}

/** 공지 새 글 판정 — max_id(숫자) 증가만 본다. */
async function checkNotices(baseUrl, openPath) {
  const { status, json } = await apiGet(baseUrl, "/api/my/notices-activity");
  // v3 에 라우트가 아직 없으면 404 — 조용히 스킵
  if (status !== 200 || json === null || json.ok !== true) return;

  const maxId = typeof json.max_id === "number" ? json.max_id : null;
  const prev = store.get().lastNoticeMaxId;

  if (prev === null) {
    // 기준값 없음 — 저장만. 공지 0건이어도 서버가 max_id:0 을 반환하므로
    // 기준값 0 이 저장되고, 이후 첫 공지(id>0)부터 정상 알림된다.
    if (maxId !== null) store.set({ lastNoticeMaxId: maxId });
    return;
  }
  if (maxId !== null && maxId > prev) {
    store.set({ lastNoticeMaxId: maxId });
    notify("실습가이드 — 새 공지", "새 공지가 게시되었어요.", () =>
      openPath("/home")
    );
  }
}

/** 한 주기 실행. 모든 오류는 조용히 삼킨다. */
async function runCycle(baseUrl, openPath) {
  if (running) return;
  // 알림 끔(웹 앱설정) — 아무 요청도 하지 않고 리턴.
  // 모든 알림·서버 확인 중단(재로그인 안내 포함 전부).
  if (store.get().notificationsEnabled === false) return;
  running = true;
  try {
    const loggedIn = await checkLoggedIn(baseUrl, openPath);
    if (loggedIn) {
      await checkChannels(baseUrl, openPath);
      await checkNotices(baseUrl, openPath);
    }
  } catch (_err) {
    // 네트워크 오류 등 — 조용히 다음 주기로
  } finally {
    running = false;
  }
}

/**
 * 폴링 시작.
 * @param {object} opts
 * @param {string} opts.baseUrl  예: https://practicum-guide.vercel.app
 * @param {(path: string) => void} opts.openPath  창 복원 + 해당 화면 loadURL
 */
function startPolling({ baseUrl, openPath }) {
  if (timer !== null) return;
  // 앱 시작 30초 후 첫 주기(세션 쿠키 로드 여유), 이후 5분 간격
  initialTimer = setTimeout(() => runCycle(baseUrl, openPath), 30 * 1000);
  timer = setInterval(() => runCycle(baseUrl, openPath), INTERVAL_MS);
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
 * 실패는 조용히 무시 — 최악의 경우 재개 직후 묵은 글 알림이 최대 2건 올 뿐.
 */
async function refreshBaselines(baseUrl) {
  try {
    const ch = await apiGet(baseUrl, "/api/channels/activity");
    if (ch.status === 200 && ch.json !== null && ch.json.ok === true) {
      const channels = Array.isArray(ch.json.channels) ? ch.json.channels : [];
      const lastSeen = { ...store.get().lastSeenByChannel };
      for (const c of channels) {
        if (!c || c.id == null) continue;
        lastSeen[String(c.id)] = c.last_post_at ?? null;
      }
      store.set({ lastSeenByChannel: lastSeen });
    }
    const no = await apiGet(baseUrl, "/api/my/notices-activity");
    if (
      no.status === 200 &&
      no.json !== null &&
      no.json.ok === true &&
      typeof no.json.max_id === "number"
    ) {
      store.set({ lastNoticeMaxId: no.json.max_id });
    }
  } catch (_err) {
    /* 네트워크 오류 등 — 조용히 무시 */
  }
}

module.exports = { startPolling, stopPolling, refreshBaselines };
