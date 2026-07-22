/**
 * preload.js — 웹(v3) ↔ 데스크톱 앱 브리지.
 *
 * contextBridge 로 window.practicumDesktop 만 노출한다(최소 API).
 * Node 접근(require/process/fs 등)은 절대 노출하지 않는다.
 *
 * ⚠️ 브리지 규격 변경 시 v3 앱설정 페이지와 동시 변경(CLAUDE.md 절대 규칙).
 * 규격:
 *   version: string
 *   getSettings(): Promise<{ autoLaunch: boolean, notifications: boolean }>
 *   setAutoLaunch(enabled: boolean): Promise<boolean>   — 적용 후 실제 상태 반환
 *   setNotifications(enabled: boolean): Promise<boolean> — 적용 후 실제 상태 반환
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 앱 버전 — main 이 webPreferences.additionalArguments 로 넘긴 값을 읽는다
// (샌드박스 preload 라 package.json require 불가 — 하드코딩 드리프트 방지).
const VERSION_ARG_PREFIX = "--pg-app-version=";
const versionArg = process.argv.find((a) => a.startsWith(VERSION_ARG_PREFIX));

contextBridge.exposeInMainWorld("practicumDesktop", {
  version: versionArg ? versionArg.slice(VERSION_ARG_PREFIX.length) : "1.0.1",
  getSettings: () => ipcRenderer.invoke("pg:get-settings"),
  setAutoLaunch: (enabled) =>
    ipcRenderer.invoke("pg:set-auto-launch", enabled === true),
  setNotifications: (enabled) =>
    ipcRenderer.invoke("pg:set-notifications", enabled === true),
});
