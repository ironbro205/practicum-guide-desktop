/**
 * main.js — 실습가이드 데스크톱 앱 메인 프로세스 전부.
 * 창·트레이·창 열기 정책·부팅 자동실행·자동 업데이트·알림 폴링 시작.
 *
 * 렌더러 코드 없음 — https://practicum-guide.vercel.app 을 기본 세션으로
 * 그대로 로드(쿠키가 일반 브라우저와 동일하게 동작, partition 사용 금지).
 */
"use strict";

const path = require("path");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  screen,
  ipcMain,
} = require("electron");

const APP_ID = "com.ironbro205.practicum-guide"; // build.appId 와 반드시 동일(토스트 AUMID)
const BASE_URL = "https://practicum-guide.vercel.app";
const OWN_ORIGIN = new URL(BASE_URL).origin;
const LOGIN_ARGS = ["--hidden"]; // get/setLoginItemSettings 에 항상 같은 args 사용
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");
// 새 알림 표시용 배지 아이콘(기본 아이콘 + 우상단 빨간 원)
const ALERT_ICON_PATH = path.join(__dirname, "..", "assets", "icon-alert.ico");
const TRAY_TOOLTIP = "실습가이드";
const TRAY_TOOLTIP_ALERT = "실습가이드 — 새 알림";
// 제목 표시줄 통일 규격 — v3 웹의 데스크톱 상단 띠와 반드시 동일 값 유지.
// TITLEBAR_COLOR = v3 --color-brand(#4a154b, 사이드바 배경), 높이 36px 공통 상수.
const TITLEBAR_COLOR = "#4a154b";
const TITLEBAR_SYMBOL_COLOR = "#ffffff";
const TITLEBAR_HEIGHT = 36;
// 자체 알림 배너 창 규격 (v1.0.2 — 윈도우 토스트 대체, PLAN §14)
const BANNER_WIDTH = 360;
const BANNER_HEIGHT = 100;
const BANNER_MARGIN = 16; // 작업 영역 우하단 여백
const BANNER_TIMEOUT_MS = 7 * 1000; // 자동 숨김

// ── 단일 인스턴스 락 (파일 최상단) ─────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  const store = require("./store");
  const poller = require("./poller");

  /** @type {BrowserWindow|null} */
  let mainWindow = null;
  /** @type {Tray|null} 모듈 스코프 변수 — GC 로 트레이 아이콘이 사라지는 것 방지 */
  let tray = null;
  let isQuitting = false;
  /** 새 알림 트레이 깜빡임 타이머 (null = 깜빡이는 중 아님) */
  let alertBlinkTimer = null;
  /** 6시간 주기 업데이트 확인 타이머 (중복 등록 방지·종료 시 정리) */
  let updateCheckTimer = null;
  let alertIconShown = false;
  /** X(트레이 숨김) 시각 — 이 경로로 숨었을 때만 재표시 새로고침 대상 (null = 해당 없음) */
  let hiddenByCloseAt = null;
  /** @type {BrowserWindow|null} 자체 알림 배너 창(재사용 단일 인스턴스) */
  let bannerWindow = null;
  /** @type {Promise<void>|null} 배너 html 로드 완료 대기용 */
  let bannerLoadPromise = null;
  /** 배너 자동 숨김 타이머 (null = 표시 중 아님) */
  let bannerHideTimer = null;
  /** 현재 표시 중인 배너의 클릭 동작 (null = 클릭해도 닫기만) */
  let bannerOnClick = null;

  // 토스트 알림 AUMID — BrowserWindow 생성 전에 설정.
  // 개발 모드는 process.execPath 기준(계획서 §10).
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

  // 두 번째 실행 시 기존 창 복원.
  // 단, 부팅 자동실행 항목(--hidden)이 중복 트리거된 경우는 창을 불쑥 띄우지 않는다.
  app.on("second-instance", (_event, argv) => {
    if (!argv.includes("--hidden")) showMainWindow();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (updateCheckTimer !== null) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = null;
    }
  });

  // 트레이 상주 앱 — 창이 다 닫혀도(=숨겨져도) 종료하지 않는다
  app.on("window-all-closed", () => {
    /* keep running in tray */
  });

  // ── 창 ───────────────────────────────────────────────────────────────
  function createWindow(forceShow = false) {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      icon: ICON_PATH,
      autoHideMenuBar: true,
      // Windows 전용: 기본 제목 표시줄을 숨기고 오버레이 버튼만 남겨
      // v3 웹의 상단 브랜드 띠(#4a154b, 36px)와 색·높이를 통일한다.
      // 비 Windows(개발 WSLg 등)는 기본 프레임 유지.
      ...(process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            titleBarOverlay: {
              color: TITLEBAR_COLOR,
              symbolColor: TITLEBAR_SYMBOL_COLOR,
              height: TITLEBAR_HEIGHT,
            },
          }
        : {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 웹(v3) 연동 브리지 — window.practicumDesktop 노출(preload.js)
        preload: path.join(__dirname, "preload.js"),
        // 샌드박스 preload 에서 앱 버전을 읽을 수 있게 전달(package.json require 불가)
        additionalArguments: [`--pg-app-version=${app.getVersion()}`],
        // 기본 세션 사용 — partition 지정 금지(로그인 쿠키 60일 유지)
      },
    });

    mainWindow.once("ready-to-show", () => {
      // forceShow: 트레이 "열기"/알림 클릭으로 창을 재생성한 경우 —
      // --hidden 부팅 프로세스여도 무조건 표시해야 한다.
      if (forceShow || !process.argv.includes("--hidden")) mainWindow.show();
    });

    // X(닫기) = 종료가 아니라 트레이로 숨김.
    // 이 경로로 숨은 시각만 기록 — 최소화/복원 등 다른 경로와 구분해
    // "X 로 숨겼다 다시 연" 경우에만 오래된 화면 새로고침을 검토한다.
    mainWindow.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        hiddenByCloseAt = Date.now();
        mainWindow.hide();
      }
    });

    // 창을 열어 보면 새 알림 표시 해제("창을 열면 해제" 확정 설계)
    mainWindow.on("focus", stopAlertBlink);
    mainWindow.on("show", stopAlertBlink);
    mainWindow.on("show", () => {
      void maybeReloadStale();
    });

    setupWindowOpenPolicy(mainWindow);
    attachMainNavGuard(mainWindow);

    // 다운로드(will-download)는 Electron 기본 저장 대화상자를 그대로 사용 —
    // 채널 첨부·hwpx 내보내기가 기본 동작으로 저장된다. 핸들러 등록 안 함.

    mainWindow.loadURL(BASE_URL);
  }

  /**
   * X 로 1분 이상 숨겨져 있던 창을 다시 열면 새로고침해, 그 사이 올라온
   * 공지·채널 글이 보이게 한다. 단 화면에 입력하다 만 내용(글 작성 중 X 를
   * 누른 경우 등)이 있으면 날아가지 않도록 새로고침을 건너뛴다.
   */
  async function maybeReloadStale() {
    if (hiddenByCloseAt === null) return;
    const stale = Date.now() - hiddenByCloseAt > 60 * 1000;
    hiddenByCloseAt = null;
    if (!stale || mainWindow === null || mainWindow.isDestroyed()) return;
    let dirty = true; // 판정 실패 시 보수적으로 새로고침하지 않는다
    try {
      dirty = await mainWindow.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type])'))
           .some((el) => typeof el.value === "string" && el.value.trim() !== "")`,
        true
      );
    } catch (_err) {
      /* dirty = true 유지 */
    }
    if (dirty !== true && mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  }

  /** 외부 브라우저 열기 — http/https 만 허용(그 외 프로토콜은 무시). */
  function safeOpenExternal(url) {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "https:" || protocol === "http:") shell.openExternal(url);
    } catch (_err) {
      /* 잘못된 URL — 무시 */
    }
  }

  /**
   * 메인 창 자체의 페이지 이동 제한 — 같은 창에서 외부 도메인으로 떠나는 것을 막고
   * 기본 브라우저로 넘긴다(첨부는 전부 같은 도메인 /api/blob 중계라 영향 없음).
   */
  function attachMainNavGuard(win) {
    const guard = (event, url) => {
      let origin = null;
      try {
        origin = new URL(url).origin;
      } catch (_err) {
        event.preventDefault();
        return;
      }
      if (origin !== OWN_ORIGIN) {
        event.preventDefault();
        safeOpenExternal(url);
      }
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", guard);
  }

  /**
   * 창 열기 정책:
   *  - 자기 오리진 → 새 창 대신 현재 창에서 이동(deny + loadURL)
   *  - about:blank/빈 URL → allow 후 will-navigate 감시
   *    (구글 시트 내보내기: 빈 창을 먼저 열고 외부로 이동하는 패턴 대응)
   *  - 외부 도메인 → deny + 기본 브라우저(shell.openExternal)
   */
  function setupWindowOpenPolicy(win) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url === "about:blank" || url === "") {
        return {
          action: "allow",
          // ⚠️ Electron 문서상 about:blank 자식 창의 webPreferences 는 부모에서
          // 통째로 복사되며 여기서 override 할 수 없다("no way to override it") —
          // 즉 브리지 preload 는 자식 창에 상속된다. 아래 지정은 방어적 표기일 뿐
          // 실제 차단이 아니며, 외부 페이지에 브리지가 노출되지 않는 실제 방어는
          // did-create-window 의 guardExternal(will-navigate + will-redirect)이다:
          // 외부 문서가 로드되기 전에 이동을 막고 창을 닫는다(preload 는 최상위
          // 프레임에만 주입되므로 서브프레임 우회 경로도 없음).
          overrideBrowserWindowOptions: {
            webPreferences: {
              preload: undefined,
              nodeIntegration: false,
              contextIsolation: true,
            },
          },
        };
      }
      let origin = null;
      try {
        origin = new URL(url).origin;
      } catch (_err) {
        return { action: "deny" };
      }
      if (origin === OWN_ORIGIN) {
        win.loadURL(url);
        return { action: "deny" };
      }
      safeOpenExternal(url);
      return { action: "deny" };
    });

    // about:blank 로 열린 자식 창: 같은 정책을 재귀 적용하고,
    // will-navigate 뿐 아니라 서버측 리다이렉트(will-redirect)도 감시해
    // 외부 도메인이면 기본 브라우저로 넘긴다.
    // ★ 이 가드가 브리지 노출 방지의 실제 방어선이다 — about:blank 자식 창은
    // 부모의 preload(브리지)를 그대로 상속하므로(위 overrideBrowserWindowOptions
    // 주석 참고), 외부 문서가 로드되기 전에 여기서 차단·창 닫기로 막는다.
    win.webContents.on("did-create-window", (childWindow) => {
      setupWindowOpenPolicy(childWindow);
      const guardExternal = (event, url) => {
        if (url === "about:blank") return;
        let origin = null;
        try {
          origin = new URL(url).origin;
        } catch (_err) {
          return;
        }
        if (origin !== OWN_ORIGIN) {
          event.preventDefault();
          safeOpenExternal(url);
          if (!childWindow.isDestroyed()) childWindow.close();
        }
      };
      childWindow.webContents.on("will-navigate", guardExternal);
      childWindow.webContents.on("will-redirect", guardExternal);
    });
  }

  function showMainWindow() {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      createWindow(true); // 재생성 경로 — --hidden 프로세스여도 반드시 표시
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  /** 알림 클릭 등에서 창 복원 + 사이트 내 경로 이동 */
  function openPath(sitePath) {
    hiddenByCloseAt = null; // 어차피 아래 loadURL 로 새로 이동 — 이중 새로고침 방지
    showMainWindow();
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(BASE_URL + sitePath);
    }
  }

  // ── 부팅 시 자동실행 ─────────────────────────────────────────────────
  function getAutoLaunchEnabled() {
    const settings = app.getLoginItemSettings({ args: LOGIN_ARGS });
    // Windows 에서 작업관리자로 시작프로그램을 끄면 레지스트리 Run 항목은 남고
    // StartupApproved 만 disabled 가 된다 — launchItems 의 enabled 까지 봐야
    // 트레이 체크박스가 실제 상태를 반영한다(강제 재등록은 하지 않음).
    if (Array.isArray(settings.launchItems) && settings.launchItems.length > 0) {
      return settings.openAtLogin && settings.launchItems.some((it) => it.enabled);
    }
    return settings.openAtLogin;
  }

  function setAutoLaunch(enabled) {
    app.setLoginItemSettings({ openAtLogin: enabled, args: LOGIN_ARGS });
  }

  /**
   * 첫 실행 시 딱 1회만 자동실행 등록.
   * 이후 사용자가 트레이 메뉴나 작업관리자에서 꺼도 강제 재등록하지 않는다
   * (loginItemRegistered 플래그로 첫 실행 판별).
   */
  function registerLoginItemOnce() {
    if (!app.isPackaged) return; // 개발 모드에서 electron 바이너리 등록 방지
    if (store.get().loginItemRegistered) return;
    setAutoLaunch(true);
    store.set({ loginItemRegistered: true });
  }

  // ── 웹(v3) 연동 브리지 IPC ───────────────────────────────────────────
  // preload.js 의 window.practicumDesktop 이 invoke 하는 채널 3개.
  // ⚠️ 브리지 규격 변경 시 v3 앱설정 페이지와 동시 변경(CLAUDE.md 절대 규칙).
  function registerBridgeIpc() {
    ipcMain.handle("pg:get-settings", () => ({
      autoLaunch: getAutoLaunchEnabled(),
      notifications: store.get().notificationsEnabled !== false,
    }));

    ipcMain.handle("pg:set-auto-launch", (_event, enabled) => {
      setAutoLaunch(enabled === true);
      rebuildTrayMenu(); // 트레이 체크박스 동기화
      return getAutoLaunchEnabled(); // 적용 후 실제 상태 반환
    });

    ipcMain.handle("pg:set-notifications", async (_event, enabled) => {
      const turningOn =
        enabled === true && store.get().notificationsEnabled === false;
      if (turningOn) {
        // 켜기 전에 기준값을 조용히 최신화 — 꺼둔 사이 글이 뒤늦게 알림으로
        // 튀지 않게 한다. 완료 후에 켜야 폴링 주기와의 경합도 없다.
        await poller.refreshBaselines(BASE_URL);
      }
      store.set({ notificationsEnabled: enabled === true });
      return store.get().notificationsEnabled !== false; // 적용 후 실제 상태 반환
    });
  }

  // ── 자체 알림 배너 (v1.0.2 — 윈도우 토스트 대체) ─────────────────────
  // 윈도우 토스트(new Notification)는 방해 금지·배너 끔 설정에 막혀 사용자가
  // 못 보는 사고가 있었다 → 윈도우 알림 시스템을 아예 쓰지 않고, 항상 뜨는
  // 자체 배너 창(alwaysOnTop, 우하단)으로 모든 알림을 통일한다.
  // 배너 창은 로컬 banner.html 만 로드(사이트 로드 없음) — 브리지 preload 미사용.

  function createBannerWindow() {
    bannerWindow = new BrowserWindow({
      width: BANNER_WIDTH,
      height: BANNER_HEIGHT,
      frame: false,
      transparent: true, // 둥근 모서리(카드 바깥 완전 투명)
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false, // 작업 중인 창에서 포커스를 뺏지 않는다
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false, // 그림자는 카드 CSS 로(창 사각 그림자 방지)
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "banner-preload.js"),
      },
    });
    bannerWindow.on("closed", () => {
      bannerWindow = null;
      bannerLoadPromise = null;
    });
    bannerLoadPromise = bannerWindow
      .loadFile(path.join(__dirname, "banner.html"))
      .catch(() => {});
  }

  function hideBanner() {
    if (bannerHideTimer !== null) {
      clearTimeout(bannerHideTimer);
      bannerHideTimer = null;
    }
    bannerOnClick = null;
    if (bannerWindow !== null && !bannerWindow.isDestroyed()) {
      bannerWindow.hide();
    }
  }

  /**
   * 알림 배너 표시 — 앱의 모든 알림이 이 한 경로로 나간다.
   * 표시 중 새 알림이 오면 내용 교체 + 타이머 리셋(최신 우선).
   * 본문 클릭 = onClick 실행 + 즉시 숨김, × = 숨김만, 7초 후 자동 숨김.
   */
  async function showBanner(title, body, onClick) {
    try {
      if (bannerWindow === null || bannerWindow.isDestroyed()) {
        createBannerWindow();
      }
      await bannerLoadPromise;
      if (bannerWindow === null || bannerWindow.isDestroyed()) return;

      bannerOnClick = typeof onClick === "function" ? onClick : null;
      bannerWindow.webContents.send("pg:banner-data", {
        title: String(title),
        body: String(body),
      });

      // 주 모니터 작업 영역(작업표시줄 제외) 우하단에 배치
      const workArea = screen.getPrimaryDisplay().workArea;
      bannerWindow.setBounds({
        x: workArea.x + workArea.width - BANNER_WIDTH - BANNER_MARGIN,
        y: workArea.y + workArea.height - BANNER_HEIGHT - BANNER_MARGIN,
        width: BANNER_WIDTH,
        height: BANNER_HEIGHT,
      });
      bannerWindow.showInactive(); // 포커스 안 뺏고 표시

      if (bannerHideTimer !== null) clearTimeout(bannerHideTimer);
      bannerHideTimer = setTimeout(hideBanner, BANNER_TIMEOUT_MS);
    } catch (_err) {
      /* 배너 실패로 앱이 죽지 않게 — 트레이 깜빡임이 보조 표시로 남는다 */
    }
  }

  function registerBannerIpc() {
    // 배너 창에서만 오는 이벤트인지 확인(다른 렌더러의 위조 전송 방지)
    const isFromBanner = (event) =>
      bannerWindow !== null &&
      !bannerWindow.isDestroyed() &&
      event.sender === bannerWindow.webContents;

    ipcMain.on("pg:banner-click", (event) => {
      if (!isFromBanner(event)) return;
      const onClick = bannerOnClick;
      hideBanner(); // 즉시 숨김(onClick 이 창을 띄우기 전에)
      if (onClick !== null) onClick();
    });

    ipcMain.on("pg:banner-close", (event) => {
      if (!isFromBanner(event)) return;
      hideBanner();
    });
  }

  // ── 자동 업데이트 (electron-updater + GitHub Releases) ────────────────
  function initUpdater() {
    if (!app.isPackaged) return; // 개발 모드 가드
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // 트레이 "종료" 시에도 설치됨

    autoUpdater.on("update-downloaded", (info) => {
      showBanner(
        "실습가이드 업데이트 준비 완료",
        `새 버전 v${info.version} — 알림을 누르면 지금 재시작하며 설치돼요.`,
        () => {
          isQuitting = true; // quitAndInstall 경로에서 close 핸들러의 hide 방지
          autoUpdater.quitAndInstall();
        }
      );
    });

    autoUpdater.on("error", () => {
      /* 네트워크 오류 등 — 조용히 무시, 다음 확인 때 재시도 */
    });

    autoUpdater.checkForUpdates().catch(() => {});

    // 트레이 상주 앱이라 몇 주씩 재시작이 없을 수 있다 —
    // 시작 시 1회만으로는 새 버전을 못 받으므로 6시간마다 자동 확인.
    if (updateCheckTimer === null) {
      updateCheckTimer = setInterval(() => {
        autoUpdater.checkForUpdates().catch(() => {});
      }, 6 * 60 * 60 * 1000);
    }
  }

  function checkForUpdatesManually() {
    if (!app.isPackaged) {
      showBanner("실습가이드", "개발 모드에서는 업데이트 확인을 할 수 없어요.");
      return;
    }
    const { autoUpdater } = require("electron-updater");
    autoUpdater.checkForUpdates().catch(() => {});
  }

  // ── 새 알림 시각 표시 (v1.0.1) ───────────────────────────────────────
  // 트레이: 기본 아이콘 ↔ 빨간 점 배지 아이콘을 800ms 간격 교대 + 툴팁 변경.
  // 작업표시줄: 창이 존재하면 flashFrame (숨김 상태면 버튼이 없어 무해).
  // 해제는 창 focus/show 에서 stopAlertBlink ("창을 열면 해제" 확정).
  function startAlertBlink() {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(true);
    }
    if (tray === null || alertBlinkTimer !== null) return; // 이미 깜빡이는 중
    tray.setToolTip(TRAY_TOOLTIP_ALERT);
    alertIconShown = true;
    tray.setImage(ALERT_ICON_PATH);
    alertBlinkTimer = setInterval(() => {
      if (tray === null) return;
      alertIconShown = !alertIconShown;
      tray.setImage(alertIconShown ? ALERT_ICON_PATH : ICON_PATH);
    }, 800);
  }

  function stopAlertBlink() {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false);
    }
    if (alertBlinkTimer === null) return;
    clearInterval(alertBlinkTimer);
    alertBlinkTimer = null;
    alertIconShown = false;
    if (tray !== null) {
      tray.setImage(ICON_PATH);
      tray.setToolTip(TRAY_TOOLTIP);
    }
  }

  /** 트레이 "알림 테스트" — 자체 배너가 화면에 뜨는지 즉시 확인. */
  function showTestNotification() {
    showBanner(
      "실습가이드 — 알림 테스트",
      "이 알림이 화면 오른쪽 아래에 보이면 정상이에요."
    );
  }

  // ── 트레이 ───────────────────────────────────────────────────────────
  function createTray() {
    tray = new Tray(ICON_PATH);
    tray.setToolTip(TRAY_TOOLTIP);
    rebuildTrayMenu();
    tray.on("click", showMainWindow);
  }

  function rebuildTrayMenu() {
    if (tray === null) return; // 트레이 생성 전 IPC 호출 대비
    const menu = Menu.buildFromTemplate([
      { label: "열기", click: showMainWindow },
      { label: `버전 v${app.getVersion()}`, enabled: false },
      { type: "separator" },
      // 즉시 폴링 1주기(알림 끔이면 설계대로 아무것도 안 함)
      { label: "지금 확인", click: () => poller.runOnce() },
      // 자체 배너가 화면에 뜨는지 바로 확인하는 진단용
      { label: "알림 테스트", click: showTestNotification },
      { label: "업데이트 확인", click: checkForUpdatesManually },
      {
        label: "부팅 시 자동실행",
        type: "checkbox",
        checked: getAutoLaunchEnabled(),
        click: (menuItem) => {
          setAutoLaunch(menuItem.checked);
          rebuildTrayMenu(); // 실제 등록 결과를 다시 조회해 체크 상태 동기화
        },
      },
      { type: "separator" },
      {
        label: "종료",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  }

  // ── 시작 ─────────────────────────────────────────────────────────────
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // 웹 래핑 앱 — 기본 메뉴바 제거

    registerBridgeIpc();
    registerBannerIpc();
    createWindow();
    createTray();
    registerLoginItemOnce();
    initUpdater();

    // 새 글 알림 폴링(60초 간격, 통합 엔드포인트 1회 호출, 실행 중에만)
    // 알림 = 자체 배너(showBanner 주입 — 윈도우 토스트 미사용),
    // 새 글 감지 시 배너와 함께 트레이 깜빡임·작업표시줄 flashFrame 시작
    poller.startPolling({
      baseUrl: BASE_URL,
      openPath,
      notify: showBanner,
      onNewAlert: startAlertBlink,
    });
  });
}
