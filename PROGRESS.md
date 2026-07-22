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

## 남은 일
- [ ] v3 에 GET /api/my/notices-activity 신설 + prod 배포 (PLAN §8 — v3 쪽 작업, 메인 담당)
- [ ] GitHub 공개 저장소 생성·푸시 → v1.0.0 태그 → 릴리스 자산 3종 확인 (PLAN §7)
- [ ] 사용자 실제 Windows PC 수동 QA (PLAN §11 체크리스트)
