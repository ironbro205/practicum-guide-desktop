# practicum-guide-desktop

실습가이드(https://practicum-guide.vercel.app) Windows 전용 Electron 래핑 앱.
렌더러 코드 없음 — 사이트를 기본 세션으로 그대로 로드(쿠키 = 일반 브라우저와 동일).

## 절대 규칙
1. **win.publisherName 을 package.json build 에 절대 넣지 않는다.**
   무서명 배포에서 electron-updater 서명 검증 스킵의 핵심. electron-builder 는 26.x 유지
   (v28 은 무서명 업데이트 fail-closed 예고).
2. BrowserWindow 에 partition 지정 금지 — 기본 세션이어야 로그인 쿠키(60일)가 유지된다.
3. 폴링은 60초 간격 고정(앱 시작 30초 후 첫 주기 1회는 예외 — 설계임).
   매 주기 = `GET /api/my/desktop-activity` 통합 엔드포인트 **1회만**(서버 30초 캐시),
   이 외 호출 금지. 특히 /api/channels·/posts 직접 폴링 금지(v3 규칙).
   401 = 미로그인(연속 3회 → 재로그인 알림 1회). 공지 판정은 notices.max_id(id 기준)
   — posted_at 은 '게시 만료일' 의미라 쓰면 안 된다.
   구 3개 엔드포인트(/api/me·/api/channels/activity·/api/my/notices-activity)는
   v1.0.0 앱이 아직 쓰므로 v3 에서 삭제 금지.
4. 채널 화면 경로는 `/channels?ch=<id>` (쿼리 방식). v3 에 /channels/[id] 페이지 없음.
5. 자동실행은 첫 실행 1회만 등록(store 의 loginItemRegistered). 사용자가 끈 것을
   강제 재등록하지 않는다. get/setLoginItemSettings 는 항상 args:["--hidden"] 동일하게.
6. 브리지(window.practicumDesktop) 규격 변경 시 v3 앱설정 페이지와 동시 변경.

## 구조
- src/main.js — 메인 프로세스 전부(창·트레이·정책·자동실행·업데이트·폴링 시작·브리지 IPC)
- src/preload.js — 웹 연동 브리지(window.practicumDesktop, 최소 API만 노출)
- src/poller.js — 새 글 감지(net.fetch + 401 시 쿠키 헤더 수동 구성 폴백)
- src/store.js — userData/state.json 읽기/쓰기

## 릴리스 절차 (PLAN §7)
package.json version 올리고 커밋 → `git tag vX.Y.Z` → 푸시(태그≠version 이면 실패).
CI 가 Releases 에 setup.exe/latest.yml/.blockmap 3종 게시하는지 확인.

## 세션 시작
PROGRESS.md + git log 먼저. 상세 설계는 PLAN.md.
