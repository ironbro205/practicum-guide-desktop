# PROGRESS — practicum-guide-desktop

## 2026-07-22 — v1.0.0 전체 구현 (PLAN §2~§7·§9·§10)
- package.json: electron 43.2.0 / electron-builder 26.15.7 / electron-updater 6.8.9 고정,
  build 설정(appId com.ironbro205.practicum-guide, NSIS oneClick·perUser, GitHub publish).
  ⚠️ win.publisherName 없음(무서명 자동 업데이트 핵심) — 절대 추가하지 말 것.
- src/main.js: 단일 인스턴스 락, AUMID, 창(X=트레이 숨김), 트레이 메뉴 5항목,
  창 열기 정책(자기 오리진/about:blank/외부), 첫 실행 자동실행 1회 등록, electron-updater.
- src/poller.js: 5분 폴링 — /api/me → /api/channels/activity(last_post_at 비교)
  → /api/my/notices-activity(max_id 비교). 첫 관측은 기준값만 저장. 401 쿠키 폴백 내장.
  채널 알림 클릭 = /channels?ch=<id> (v3 에 /channels/[id] 라우트 없음 — 확인됨).
- src/store.js: userData/state.json (lastSeenByChannel·lastNoticeMaxId·loginItemRegistered·reloginNotified).
- assets/icon.ico: SVG → resvg 256px PNG → png-to-ico 생성(멀티사이즈 256/48/32/16).
- .github/workflows/release.yml: 태그 v* → windows-latest → electron-builder --win --publish always.
- INSTALL.md: 교사용 설치 안내(파란 경고 → 추가 정보 → 실행 포함).
- 검증: npm install 성공, node --check src/*.js 통과. 실기동 QA 는 PLAN §11.

## 2026-07-22 — 브리지·앱설정·릴리스까지 완료 (v1.0.0 공개됨)
- Codex 1차 리뷰 반영: 메인 창 will-navigate/will-redirect 가드(자기 도메인만),
  safeOpenExternal(http/https 만), release.yml 태그=version 검증 스텝.
- 추가 기능(PLAN §12): src/preload.js 브리지(window.practicumDesktop),
  IPC 3채널(pg:get-settings/set-auto-launch/set-notifications), notificationsEnabled,
  알림 끔=폴링 전체 중단. Codex 2차 리뷰 반영: 알림 켤 때 refreshBaselines 선실행
  (꺼둔 사이 글이 뒤늦게 알림으로 튀는 것 방지).
- artifactName 버전 제거 → 고정 다운로드 주소
  https://github.com/ironbro205/practicum-guide-desktop/releases/latest/download/PracticumGuide-Setup.exe
- v3 배포 완료: /api/my/notices-activity(운영 401 확인), 홈 [앱 다운로드] 버튼,
  사이드바 앱설정 탭(/app-settings, exe 전용) — v3 커밋 15c6940.
- 릴리스: 공개 저장소 생성, v1.0.0 태그 → CI 성공. ⚠️사고 1건: 병렬 업로드 경합으로
  같은 태그에 릴리스 2개 생성(blockmap 분리) → 수동 병합(자산 3종 확인).
  재발 방지로 release.yml 에 pre-create release 스텝 추가.

## 2026-07-22 — v1.0.1 (통합 폴링 + 알림 시각 표시, PLAN §13)
- poller.js: 3개 호출 → `GET /api/my/desktop-activity` 1회로 통합, 간격 60초
  (첫 주기는 시작 30초 후). 401 = 미로그인 streak(3회 → 재로그인 알림 1회),
  기준값 비교·첫 관측 억제·쿠키 수동 폴백·refreshBaselines 유지. runOnce 노출.
  새 글 알림 시 onNewAlert 콜백(주입) 호출.
- main.js: 새 알림 시 트레이 아이콘 800ms 교대 깜빡임(icon-alert.ico)+툴팁 변경
  +flashFrame, 창 focus/show 로 해제. 트레이 메뉴 "지금 확인"/"알림 테스트" 추가.
- assets/icon-alert.ico: 기존 SVG + 우상단 빨간 원 배지, 256/48/32/16 (스크래치패드
  iconbuild 파이프라인 재사용 — 프로젝트에 빌드 의존성 추가 없음).
- package.json 1.0.1, CLAUDE.md 절대 규칙 3 갱신, INSTALL.md "문제 해결" 절 추가.
- 검증: node --check src/*.js 통과, ico 멀티사이즈 4종·기존과 내용 상이 확인.
- 추가 반영(같은 릴리스): Windows 타이틀바 오버레이(#4a154b·36px, v3 상단 띠와 규격 공유),
  6시간 주기 업데이트 자동 확인(타이머 가드·before-quit 정리), Codex 최종 리뷰 2건
  (package-lock 1.0.1 동기화 — npm ci 차단 사유였음 / 타이머 핸들).
- **릴리스 완료(2026-07-22)**: v3 배포(d28c792) → 태그 v1.0.1 → CI 성공(2m11s),
  자산 3종 단일 릴리스(pre-create 스텝 정상 작동). latest.yml version 1.0.1 확인.
- v3 쪽 동반 변경: /api/my/desktop-activity(30초 캐시), exe 전용 타이틀바 띠(pg-desktop),
  [관리자 설정]+shield, 다운로드 버튼 lg+ 전용, 앱설정 버전 표시.

## 남은 일
- [ ] 사용자 실제 Windows PC 수동 QA — v1.0.1 자동 업데이트 확인부터
      (PLAN §11 + 타이틀바 색·트레이 깜빡임·지금 확인·알림 테스트·앱설정 스위치·버전 표시)
- [ ] QA 통과 후 INSTALL.md 링크를 교사들에게 안내
