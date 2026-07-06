#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "outputs", "focus-story-timeline-test");

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
  await page.goto(pathToFileURL(path.join(root, "地图行驶动画.html")).href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".car", { timeout: 15000 });
  await page.selectOption("#region-preview", "kulagangri");
  await page.click("#btn-region-preview");
  await page.waitForFunction(() => document.querySelector("#story-focus-timeline").classList.contains("show"), null, { timeout: 5000 });
  await page.click("#btn-play");
  const audit = await page.evaluate(() => {
    const tags = [...document.querySelectorAll("#story-focus-tags .story-focus-tag")];
    return {
      title: document.querySelector("#story-focus-title").textContent,
      summary: document.querySelector("#story-focus-summary").textContent,
      tag_count: tags.length,
      labels: tags.map((tag) => tag.textContent.trim()),
      positions: tags.map((tag) => `${tag.style.left}/${tag.style.bottom}`),
      overview_count: document.querySelectorAll("#story-timeline-tags .story-timeline-tag").length,
      total_event_count: window.LOCATION_STORY_DATA.events.length,
    };
  });
  const required = ["脚踩大地，走进雪山", "一步一步走上山脊", "群峰终于完整出现", "在山前留下合影", "从空中看白玛林措"];
  if (audit.title !== "库拉岗日" || audit.tag_count !== 6 || !required.every((title) => audit.labels.includes(title))) {
    throw new Error(`kulagangri focus timeline incomplete: ${JSON.stringify(audit)}`);
  }
  if (audit.overview_count >= audit.total_event_count) throw new Error("overview timeline was not simplified");
  await page.screenshot({ path: path.join(output, "kulagangri-focus.png"), fullPage: true });

  await page.selectOption("#region-preview", "yarlung-outbound");
  await page.click("#btn-region-preview");
  await page.waitForFunction(() => !document.querySelector("#story-focus-timeline").classList.contains("show"), null, { timeout: 5000 });
  await fs.writeFile(path.join(output, "browser-audit.json"), JSON.stringify({ ...audit, errors }, null, 2) + "\n");
  await browser.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("focus story timeline browser test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
