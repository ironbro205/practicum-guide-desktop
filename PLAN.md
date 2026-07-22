# 실습가이드 데스크톱 앱(exe) 구현 계획서 — v1.0.0

## 1. 목표
- Electron 셸이 https://practicum-guide.vercel.app 을 그대로 로드하는 Windows 전용 앱.
- 추가 가치 3가지: ①5분 간격 새 공지·채널 글 토스트 알림 ②트레이 상주+부팅 자동실행 ③GitHub Releases 자동 업데이트.
- 무서명·NSIS perUser(관리자 권한 불필요)·로컬(WSL) Windows 빌드 없음(CI 전용).

## 2. 저장소 구조 (새 공개 저장소 ironbro205/practicum-guide-desktop)
```
practicum-guide-desktop/
├─ package.json            # version 1.0.0, build(electron-builder) 설정 포함
├─ src/
│  ├─ main.js              # 메인 프로세스 전부(창·트레이·알림·폴링·업데이트·자동실행)
│  ├─ poller.js            # 새 글 감지 로직(net.fetch + 상태 비교)
│  └─ store.js             # 마지막 확인값 저장(userData/state.json 단순 읽기쓰기)
├─ assets/icon.ico         # 앱·트레이 아이콘(256px ico)
├─ .github/workflows/release.yml
├─ INSTALL.md              # 교사 배포 안내문(아주 쉬운 말)
├─ PLAN.md / PROGRESS.md / CLAUDE.md   # 세션 연속성 3종 세트
```
- 렌더러 코드 없음(사이트 자체를 로드하는 래핑 방식 — 쿠키가 일반 브라우저와 동일하게 동작).

## 3. 파일별 역할
- **main.js**: 단일 인스턴스 락(파일 최상단) → app.setAppUserModelId(appId, BrowserWindow 생성 전) → 창 생성(show:false, `--hidden` 이면 계속 숨김) → 트레이(모듈 스코프 변수) → close에서 preventDefault+hide, before-quit에서 isQuitting=true → setLoginItemSettings(openAtLogin:true, args:['--hidden']) → electron-updater → will-download 저장 처리 + setWindowOpenHandler(빈 URL 창 허용+네비게이션 감시, 외부 도메인 shell.openExternal) → 폴링 타이머 시작.
- **poller.js**: 5분마다 로그인 확인 후 채널·공지 새 글 판정 → Notification 표시, 클릭 시 창 복원+loadURL 로 해당 화면 이동.
- **store.js**: { lastSeenByChannel: {id: last_post_at}, lastNoticeMaxId } 를 JSON 파일로 유지.
- **release.yml**: 태그 푸시(v*) → windows-latest 에서 electron-builder --win --publish always.
- **INSTALL.md**: 다운로드→"알 수 없는 게시자" 경고 넘기는 법→설치→트레이 사용법.

## 4. 구현 단계 (각 단계 완료 기준 포함)
1. **저장소·뼈대**: npm init + electron/electron-builder/electron-updater 최신 안정판 고정, package.json build 설정(appId `com.ironbro205.practicum-guide`, win.target nsis, nsis.oneClick true·perMachine false, publish github/releaseType release). ⚠️ win.publisherName 절대 넣지 않음. — 완료: `npx electron .` 으로 WSL에서 창 뜸(기능 미완이어도 로드 확인).
2. **창+사이트 로드+창 열기 정책**: BrowserWindow(기본 세션, partition 없음) → loadURL(운영 주소). setWindowOpenHandler: 자기 오리진=deny+loadURL, 빈 URL(about:blank)=allow 후 will-navigate 감시(구글 시트 내보내기 대응), 외부 도메인=shell.openExternal. will-download=저장 대화상자(첨부·hwpx). — 완료: 로그인·페이지 이동·첨부 다운로드·시트 열기 정상.
3. **트레이+X=숨김+단일 인스턴스**: 위 3.의 패턴대로. 트레이 메뉴 = 열기 / v1.0.0 표시 / 업데이트 확인 / 부팅 시 자동실행 켬끔(체크박스, getLoginItemSettings 를 set 과 동일 args 로 조회) / 종료. — 완료: X 눌러도 프로세스 생존, 두 번째 실행 시 기존 창 복원.
4. **부팅 자동실행**: 기본 켬(첫 실행 시 1회 등록), `--hidden` 이면 창 숨김 시작. 작업관리자에서 꺼진 경우(launchItems[].enabled=false) 강제 재등록 금지, 트레이 메뉴에 상태만 반영. — 완료: 레지스트리 HKCU Run 등록 확인(코드 리뷰 수준, 실기동은 QA에서).
5. **알림 폴링**: §5 설계대로 구현. — 완료: 모의 응답으로 새 글→토스트→클릭 이동 흐름 로직 검증.
6. **자동 업데이트**: §6 흐름. quitAndInstall 직전 isQuitting=true 수동 세팅. app.isPackaged 가드. — 완료: 코드 완성+개발 모드에서 가드로 오류 없음.
7. **CI+릴리스**: release.yml 작성, v1.0.0 태그 푸시 → Releases 에 setup.exe/latest.yml/.blockmap 3종 확인. — 완료: 릴리스 자산 3종 존재.
8. **v3 웹 최소 수정**(§8) + INSTALL.md 작성 → 사용자 실제 Windows PC 수동 QA(§11).

## 5. 알림 폴링 설계 (5분 간격, 실행 중에만)
- **전제 확인**: 매 주기 `net.fetch(base+'/api/me', {credentials:'include'})` → teacher:null 이면 이번 주기 전부 건너뜀(미로그인). SameSite=Lax 로 쿠키가 안 붙는 경우 대비: session.defaultSession.cookies.get 으로 Cookie 헤더 수동 구성 폴백을 처음부터 내장.
- **채널**: `GET /api/channels/activity` (폴링 전용, 5분≫하한 60초 준수. /api/channels·/posts 폴링 금지 규칙 준수) → 채널별 last_post_at 을 저장값과 비교, 커진 채널이 있으면 알림 1건("새 채널 글") → 클릭 시 창 복원+해당 채널 화면 URL 로드.
- **공지**: 일반 교사용 공지 API가 없음 → §8의 신설 경량 엔드포인트로 최대 id 비교(max_id 증가=새 공지). posted_at 은 '게시 만료일' 의미라 판정에 쓰지 않음(id 기준).
- 첫 주기는 알림 없이 기준값만 저장(설치 직후 알림 폭탄 방지). 네트워크 오류·401 은 조용히 다음 주기로.

## 6. 자동 업데이트 흐름
- electron-updater(내장 autoUpdater 아님) + GitHub provider(공개 저장소라 토큰 불필요).
- 앱 시작 시 + 트레이 "업데이트 확인" 시 checkForUpdatesAndNotify (app.isPackaged 가드).
- 무서명이므로 publisherName 미설정 → 서명 검증 자동 스킵이 정상 경로(electron-builder 26 유지, v28 fail-closed 예고 인지).
- 다운로드 완료 → 알림 → 사용자가 트레이 "종료" 또는 재시작 시 설치(quitAndInstall 은 isQuitting=true 세팅 후 호출).

## 7. GitHub Actions 릴리스 절차
1. package.json version 을 올리고 커밋 → `git tag vX.Y.Z` → 푸시.
2. release.yml: on push tags v*, `permissions: contents: write`(누락 시 릴리스 생성 실패), windows-latest, setup-node 22+npm ci, `npx electron-builder --win --publish always`, env GH_TOKEN=자동 제공 GITHUB_TOKEN.
3. publish.releaseType:"release" 로 draft 없이 바로 공개(draft 는 업데이터가 못 봄).
4. 태그≠package.json version 이면 실패하므로 항상 둘을 함께 변경.

## 8. v3 웹 수정 필요 지점 (최소 1건 — 별도 명시)
- **공지 활동 API 신설(필수)**: 일반 교사용 공지 API가 전무(서버 렌더 HTML 뿐, /api/admin/notices 는 admin 전용)해서 데스크톱 폴링이 불가능. `GET /api/my/notices-activity` 신설 — 로그인 교사 전용(미들웨어 /api/my 401 규칙 자동 적용), 활성 학년도 '게시중' 공지의 `{ ok, max_id, count }` 만 반환(본문 없음, Neon 부하 극소). 이 1개 라우트 추가 외에 v3 는 수정하지 않음. 배포는 기존 규칙대로 v3 디렉토리에서 `npx vercel --prod --yes`.
- (수정 아님·확인만) /api/channels/activity 는 그대로 사용, 서버 30초 캐시 존재.

## 9. 교사 배포 안내문(INSTALL.md) 요지
- ①Releases 링크에서 "실습가이드-Setup-1.0.0.exe" 내려받기 ②파란 경고창("알 수 없는 게시자")이 떠도 정상 — "추가 정보 → 실행" 누르기(스크린샷 자리 표시) ③설치는 클릭 한 번, 관리자 암호 불필요 ④끝나면 자동 실행·로그인 그대로 ⑤X 를 눌러도 꺼진 게 아니라 시계 옆 아이콘에 있음, 완전 종료는 아이콘 우클릭→종료 ⑥업데이트는 자동(경고 없음).

## 10. 리스크와 대응
- **토스트가 안 뜸**: AUMID 불일치가 최다 원인 → appId 한 값을 setAppUserModelId·build.appId 에 상수로 공유. 개발 모드는 process.execPath 로 확인.
- **폴링 401**: credentials:'include' 누락/SameSite → 쿠키 헤더 수동 구성 폴백 내장(§5).
- **관리형 학교 PC**: HKCU Run 등록을 백신(V3·Somansa)이 알릴 수 있음 → INSTALL.md 에 한 줄 안내, 재등록 반복 금지.
- **업데이트 미감지**: draft 릴리스/blockmap 누락 → releaseType release + 자산 3종 체크를 릴리스 절차에 포함.
- **oneClick 설치 직후 자동 실행은 창이 보이는 게 정상**(--hidden 없음) — 버그 아님으로 설계.
- **60일 후 세션 만료**: 폴링이 건너뛰기만 하므로 알림이 조용히 멎음 → 미로그인 상태가 연속 감지되면 1회만 "다시 로그인해 주세요" 알림.

## 11. 검증 방법 (수동 QA 체크리스트 — 최종 확인은 사용자의 실제 Windows PC)
- [ ] 설치: 경고→추가 정보→실행→관리자 암호 없이 설치 완료(%LOCALAPPDATA%\Programs)
- [ ] 로그인 유지: 로그인→앱 완전 종료→재실행 시 로그인 유지(60일 쿠키)
- [ ] 트레이: X=숨김, 우클릭 메뉴 5항목 동작, 두 번째 실행 시 창 복원
- [ ] 알림: 다른 계정으로 채널 글/공지 등록 → 5분 내 토스트 → 클릭 시 해당 화면
- [ ] 미로그인: 로그아웃 상태에서 5분 대기 → 알림 없음(건너뜀) 확인
- [ ] 다운로드: 채널 첨부·hwpx 내보내기 저장, 외부 링크는 기본 브라우저로 열림, 구글 시트 내보내기 정상
- [ ] 자동실행: 재부팅 → 트레이만으로 시작(창 숨김), 메뉴에서 끄면 재부팅 후 미실행
- [ ] 업데이트: v1.0.1 테스트 릴리스 공개 → 기존 설치본이 감지·경고 없이 설치·버전 표시 갱신

## 12. 웹 연동 브리지 + 설정 (추가분)
- **브리지**: src/preload.js 가 contextBridge 로 `window.practicumDesktop` 노출 —
  `version`(string) / `getSettings()` → `{autoLaunch, notifications}` /
  `setAutoLaunch(enabled)`·`setNotifications(enabled)` → 적용 후 실제 상태(boolean) 반환.
  IPC 채널: `pg:get-settings` / `pg:set-auto-launch` / `pg:set-notifications`.
- **웹(v3) 쪽**: exe 감지 = `typeof window !== "undefined" && !!window.practicumDesktop`
  (hydration 후 useEffect 판정 — SSR 불일치 방지). 앱설정 페이지가 이 브리지로 설정 토글.
- **알림 끔**: store 의 `notificationsEnabled`(기본 true) — false 면 poller 가
  서버 확인 자체를 건너뜀(재로그인 안내 포함 전부 중단).
- **보안**: 자식 창(about:blank allow 분기)에는 overrideBrowserWindowOptions 로
  preload 없는 webPreferences 명시 — 외부 페이지에 브리지 노출 금지.
- **고정 파일명**: nsis.artifactName = `PracticumGuide-Setup.${ext}` →
  다운로드 고정 주소 `…/releases/latest/download/PracticumGuide-Setup.exe`
  (홈 화면 [앱 다운로드] 버튼이 이 주소 사용).
- ⚠️ 브리지 규격 변경 시 v3 앱설정 페이지와 동시 변경(CLAUDE.md 절대 규칙).

## 13. v1.0.1 변경 (통합 폴링 + 알림 시각 표시)
- 폴링을 §5 의 3개 호출에서 `GET /api/my/desktop-activity` **1회**로 통합, 간격 5분 → **60초**
  (INTERVAL_MS). 응답 = { ok, channels:[{id,last_post_at}], notices:{max_id,count} },
  401 = 미로그인(기존 streak 3회 → 재로그인 알림 1회 로직 그대로). 기준값 비교·첫 관측
  알림 억제·401 쿠키 수동 폴백·refreshBaselines 전부 유지(호출 대상만 통합 엔드포인트로).
- 새 글 감지 시 시각 표시: 트레이 아이콘을 icon-alert.ico(빨간 점 배지)와 800ms 교대 깜빡임
  + 툴팁 "실습가이드 — 새 알림" + 창 존재 시 flashFrame. 해제 = 창 focus/show(열면 해제).
- 트레이 메뉴 2항목 추가: "지금 확인"(poller.runOnce) / "알림 테스트"(배너 억제 진단용 토스트).
- assets/icon-alert.ico 신설(기존 SVG + 우상단 빨간 원, 256/48/32/16 멀티사이즈).
- 구 3개 v3 엔드포인트는 v1.0.0 앱이 아직 쓰므로 삭제 금지(서버는 통합 라우트 신설만).
- 제목 표시줄 색 통일: Windows 에서만 titleBarStyle:"hidden" + titleBarOverlay(#4a154b/#ffffff/36px, v3 상단 띠와 동일 상수) — 비 Windows 는 기본 프레임 유지.

## 14. v1.0.2 변경 (자체 팝업 배너 — 윈도우 알림 시스템 완전 대체)
- 윈도우 토스트가 방해 금지·배너 끔 설정에 막혀 사용자가 못 보는 사고 → new Notification 전면 제거, 자체 배너 창으로 전환.
- src/banner.html + src/banner-preload.js 신설, main.js showBanner(title, body, onClick): 재사용 단일 BrowserWindow(frame:false·transparent·alwaysOnTop·skipTaskbar·focusable:false), 주 모니터 작업영역 우하단(여백 16px, 360×100), showInactive 로 포커스 안 뺏음.
- 내용은 IPC "pg:banner-data" 로 전달해 textContent 로만 삽입(innerHTML 금지), 본문 클릭="pg:banner-click"(onClick+숨김), ×="pg:banner-close"(숨김만), 7초 자동 숨김, 표시 중 새 알림=내용 교체+타이머 리셋.
- 알림 경로 통일: poller 는 startPolling opts.notify 주입(전 알림 배너로), main 의 업데이트 준비·알림 테스트·개발모드 안내도 전부 showBanner. onNewAlert(트레이 깜빡임)는 그대로.
- 숨김 60초 초과 후 재표시 시 webContents.reload(그 사이 새 글 반영) — 같은 릴리스에 포함. INSTALL.md §8 은 "윈도우 설정과 무관하게 항상 뜸"으로 재작성.
