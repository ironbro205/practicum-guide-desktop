/**
 * store.js — userData/state.json 단순 읽기/쓰기 (동기 fs).
 *
 * 보관 상태:
 *  - lastSeenByChannel: { [channelId]: last_post_at(ISO string|null) }
 *  - lastNoticeMaxId: number|null (공지 최대 id 기준값. null = 기준값 미저장)
 *  - loginItemRegistered: boolean (부팅 자동실행 "첫 실행 1회 등록" 완료 여부.
 *      true 면 사용자가 껐어도 다시 강제 등록하지 않는다)
 *  - reloginNotified: boolean ("다시 로그인해 주세요" 알림을 이미 보냈는지 —
 *      로그인 복귀 시 false 로 리셋)
 *
 * 파일 손상(JSON 파싱 실패 등) 시 기본값으로 초기화한다.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  lastSeenByChannel: {},
  lastNoticeMaxId: null,
  loginItemRegistered: false,
  reloginNotified: false,
};

let cache = null;

function filePath() {
  return path.join(app.getPath("userData"), "state.json");
}

function load() {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
  } catch (_err) {
    parsed = null; // 없거나 손상 → 초기화
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    cache = { ...DEFAULTS, lastSeenByChannel: {} };
  } else {
    cache = {
      ...DEFAULTS,
      ...parsed,
      lastSeenByChannel:
        parsed.lastSeenByChannel &&
        typeof parsed.lastSeenByChannel === "object" &&
        !Array.isArray(parsed.lastSeenByChannel)
          ? parsed.lastSeenByChannel
          : {},
    };
  }
  return cache;
}

/** 현재 상태 객체 반환(최초 호출 시 파일에서 로드). */
function get() {
  return cache !== null ? cache : load();
}

/** 부분 갱신 후 즉시 파일 저장. 저장 실패는 조용히 무시(다음 저장에서 재시도). */
function set(patch) {
  cache = { ...get(), ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), "utf8");
  } catch (_err) {
    // 디스크 오류 등 — 메모리 캐시는 유지되므로 이번 세션 동작에는 지장 없음
  }
  return cache;
}

module.exports = { get, set };
