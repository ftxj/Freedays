#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "outputs", "manual-story-editor-test");

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--allow-file-access-from-files", "--disable-web-security"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(pathToFileURL(path.join(root, "地图行驶动画.html")).href, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("#region-preview option", { state: "attached", timeout: 15000 });
  await page.evaluate(() => localStorage.removeItem("tibet-route-manual-story-points-v1"));
  await page.click("#btn-story-editor");
  await page.waitForFunction(() => document.querySelector("#story-editor-route-time").textContent !== "--");
  const captured = await page.evaluate(() => ({
    time: document.querySelector("#story-editor-route-time").textContent,
    gps: document.querySelector("#story-editor-coordinate").textContent,
    center: document.querySelector("#story-editor-camera-center").textContent,
    zoom: document.querySelector("#story-editor-zoom").value,
    pitch: document.querySelector("#story-editor-pitch").value,
    bearing: document.querySelector("#story-editor-bearing").value,
  }));
  if (!captured.gps.startsWith("[") || !captured.center.startsWith("[")) {
    throw new Error(`current map capture failed: ${JSON.stringify(captured)}`);
  }
  await page.click("#story-editor-pick");
  await page.mouse.click(650, 360);
  await page.waitForFunction(() => !document.querySelector("#story-editor-coordinate").textContent.includes("请先"));
  const timeAfterGpsPick = await page.locator("#story-editor-route-time").textContent();
  if (timeAfterGpsPick !== captured.time) throw new Error("manual GPS pick unexpectedly changed current trigger time");
  await page.fill("#story-editor-kicker", "测 试 区 域");
  await page.fill("#story-editor-title", "手工 GPS 故事点");
  await page.fill("#story-editor-subtitle", "点击地图后立即预览。");
  await page.click("#story-editor-use-backpack");
  await page.waitForSelector("#material-backpack.selection-mode.show");
  await page.locator("#backpack-grid .backpack-item-open").nth(0).click();
  await page.locator("#backpack-grid .backpack-item-open").nth(1).click();
  await page.click("#backpack-selection-confirm");
  await page.waitForFunction(() => document.querySelector("#story-editor-assets").value.split("\n").filter(Boolean).length === 2);
  await page.selectOption("#story-editor-type", "hero");
  await page.selectOption("#story-editor-pause", "true");
  await page.fill("#story-editor-zoom", "15.2");
  await page.fill("#story-editor-pitch", "52");
  await page.fill("#story-editor-bearing", "24");
  await page.click("#story-editor-save");
  await page.waitForFunction(() => document.querySelector("#story-editor-status").textContent.includes("已保存"));
  await page.waitForSelector("#supply-card.show", { timeout: 5000 });
  await page.selectOption("#story-editor-saved", "existing:region-lhasa-departure-01");
  await page.waitForFunction(() => document.querySelector("#story-editor-origin").textContent.includes("正在编辑现有效果"));
  await page.fill("#story-editor-title", "现有动画覆盖测试");
  await page.fill("#story-editor-time", "2024-12-22T09:12:34");
  await page.fill("#story-editor-zoom", "13.7");
  await page.click("#story-editor-save");
  await page.waitForFunction(() => document.querySelector("#story-editor-status").textContent.includes("已保存"));
  const audit = await page.evaluate(() => {
    const points = JSON.parse(localStorage.getItem("tibet-route-manual-story-points-v1") || "[]");
    const override = points.find((point) => point.overrides_event_id === "region-lhasa-departure-01");
    return {
      count: points.length,
      point: points[0],
      override,
      saved_options: document.querySelectorAll("#story-editor-saved option").length,
      overlay_title: document.querySelector("#supply-title").textContent,
      editor_open: document.querySelector("#story-editor").classList.contains("show"),
      timeline_tags: document.querySelectorAll("#story-timeline-tags .story-timeline-tag").length,
      timeline_has_manual: [...document.querySelectorAll("#story-timeline-tags .story-timeline-tag")]
        .some((node) => node.title.startsWith("手工 GPS 故事点")),
      selected_assets: points[0]?.assets?.length,
      camera_center: points[0]?.camera_center,
      override_timeline_count: [...document.querySelectorAll("#story-timeline-tags .story-timeline-tag")]
        .filter((node) => node.title.startsWith("现有动画覆盖测试")).length,
    };
  });
  if (audit.count !== 2 || !audit.override || audit.override.title !== "现有动画覆盖测试" ||
      audit.override.zoom !== 13.7 || audit.override_timeline_count !== 1 ||
      audit.override.route_time !== "2024-12-22T09:12:34+08:00" ||
      audit.selected_assets !== 2 || !audit.camera_center || !audit.timeline_has_manual || audit.timeline_tags < 100) {
    throw new Error(`manual story editor audit failed: ${JSON.stringify(audit)}`);
  }
  await page.screenshot({ path: path.join(output, "editor-saved.png"), fullPage: true });
  await fs.writeFile(path.join(output, "browser-audit.json"), JSON.stringify({ ...audit, errors }, null, 2) + "\n");
  await page.evaluate(() => localStorage.removeItem("tibet-route-manual-story-points-v1"));
  await browser.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("manual story editor browser test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
