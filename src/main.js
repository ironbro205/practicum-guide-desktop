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
  Notification,
  ipcMain,
} = require("electron");

const APP_ID = "com.ironbro205.practicum-guide"; // build.appId 와 반드시 동일(토스트 AUMID)
const BASE_URL = "https://practicum-guide.vercel.app";
const OWN_ORIGIN = new URL(BASE_URL).origin;
const LOGIN_ARGS = ["--hidden"]; // get/setLoginItemSettings 에 항상 같은 args 사용
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");

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

    // X(닫기) = 종료가 아니라 트레이로 숨김
    mainWindow.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        mainWindow.hide();
      }
    });

    setupWindowOpenPolicy(mainWindow);
    attachMainNavGuard(mainWindow);

    // 다운로드(will-download)는 Electron 기본 저장 대화상자를 그대로 사용 —
    // 채널 첨부·hwpx 내보내기가 기본 동작으로 저장된다. 핸들러 등록 안 함.

    mainWindow.loadURL(BASE_URL);
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

  // ── 자동 업데이트 (electron-updater + GitHub Releases) ────────────────
  function initUpdater() {
    if (!app.isPackaged) return; // 개발 모드 가드
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // 트레이 "종료" 시에도 설치됨

    autoUpdater.on("update-downloaded", (info) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: "실습가이드 업데이트 준비 완료",
        body: `새 버전 v${info.version} — 알림을 누르면 지금 재시작하며 설치돼요.`,
      });
      n.on("click", () => {
        isQuitting = true; // quitAndInstall 경로에서 close 핸들러의 hide 방지
        autoUpdater.quitAndInstall();
      });
      n.show();
    });

    autoUpdater.on("error", () => {
      /* 네트워크 오류 등 — 조용히 무시, 다음 확인 때 재시도 */
    });

    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  function checkForUpdatesManually() {
    if (!app.isPackaged) {
      if (Notification.isSupported()) {
        new Notification({
          title: "실습가이드",
          body: "개발 모드에서는 업데이트 확인을 할 수 없어요.",
        }).show();
      }
      return;
    }
    const { autoUpdater } = require("electron-updater");
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  // ── 트레이 ───────────────────────────────────────────────────────────
  function createTray() {
    tray = new Tray(ICON_PATH);
    tray.setToolTip("실습가이드");
    rebuildTrayMenu();
    tray.on("click", showMainWindow);
  }

  function rebuildTrayMenu() {
    if (tray === null) return; // 트레이 생성 전 IPC 호출 대비
    const menu = Menu.buildFromTemplate([
      { label: "열기", click: showMainWindow },
      { label: `버전 v${app.getVersion()}`, enabled: false },
      { type: "separator" },
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
    createWindow();
    createTray();
    registerLoginItemOnce();
    initUpdater();

    // 새 글 알림 폴링(5분 간격, 실행 중에만)
    poller.startPolling({ baseUrl: BASE_URL, openPath });
  });
}
