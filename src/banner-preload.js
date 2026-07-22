/**
 * banner-preload.js — 자체 알림 배너 창 전용 preload.
 *
 * 배너 창은 로컬 banner.html 만 로드한다(사이트 로드 없음) — 웹 연동 브리지
 * (preload.js)와는 완전히 별개. 메인에서 "pg:banner-data" 로 받은 제목·본문을
 * textContent 로만 삽입한다(innerHTML 금지 — 알림 내용에 마크업이 섞여도 무해).
 * 카드 클릭 = "pg:banner-click", × 버튼 = "pg:banner-close"(전파 차단, 닫기만).
 */
"use strict";

const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const titleEl = document.getElementById("title");
  const bodyEl = document.getElementById("body");
  const cardEl = document.getElementById("card");
  const closeEl = document.getElementById("close");

  ipcRenderer.on("pg:banner-data", (_event, data) => {
    titleEl.textContent =
      data && typeof data.title === "string" ? data.title : "";
    bodyEl.textContent = data && typeof data.body === "string" ? data.body : "";
  });

  cardEl.addEventListener("click", () => {
    ipcRenderer.send("pg:banner-click");
  });

  closeEl.addEventListener("click", (event) => {
    event.stopPropagation(); // 카드 클릭(열기)으로 번지지 않게 차단
    ipcRenderer.send("pg:banner-close");
  });
});
