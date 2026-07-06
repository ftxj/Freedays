#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "outputs", "presentation-pause-test");

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--allow-file-access-from-files", "--disable-web-security", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(pathToFileURL(path.join(root, "地图行驶动画.html")).href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#story-timeline-tags .story-timeline-tag.region", { timeout: 15000 });
  await page.waitForSelector(".car", { timeout: 15000 });

  await page.evaluate(() => [...document.querySelectorAll("#story-timeline-tags .story-timeline-tag.region")]
    .find((node) => node.textContent.includes("珠峰大本营"))?.click());
  await page.waitForFunction(() => document.querySelector("#location-card").classList.contains("show"), null, { timeout: 5000 });
  await page.click("#btn-play");
  await page.waitForTimeout(150);
  await page.click("#btn-play");
  await page.waitForTimeout(5000);
  const regionPaused = await page.evaluate(() => ({
    visible: document.querySelector("#location-card").classList.contains("show"),
    paused: document.querySelector("#location-card").classList.contains("presentation-paused"),
    animation: getComputedStyle(document.querySelector("#location-card")).animationPlayState,
  }));
  if (!regionPaused.visible || !regionPaused.paused || regionPaused.animation !== "paused") {
    throw new Error(`region card did not freeze: ${JSON.stringify(regionPaused)}`);
  }
  await page.click("#btn-play");
  await page.waitForTimeout(300);
  if (await page.locator("#location-card").evaluate((node) => node.classList.contains("presentation-paused"))) {
    throw new Error("region card did not resume");
  }
  await page.click("#btn-play");

  await page.evaluate(() => [...document.querySelectorAll("#story-timeline-tags .story-timeline-tag")]
    .find((node) => node.textContent.includes("龙王潭的斑头雁"))?.click());
  await page.waitForFunction(() => document.querySelector("#supply-card").classList.contains("show"), null, { timeout: 5000 });
  await page.click("#btn-play");
  await page.waitForTimeout(150);
  await page.click("#btn-play");
  const beforeCount = await page.locator("#memory-reel-count").textContent();
  await page.waitForTimeout(3200);
  const mediaPaused = await page.evaluate(() => ({
    visible: document.querySelector("#supply-card").classList.contains("show"),
    paused: document.querySelector("#supply-card").classList.contains("presentation-paused"),
    count: document.querySelector("#memory-reel-count").textContent,
  }));
  if (!mediaPaused.visible || !mediaPaused.paused || mediaPaused.count !== beforeCount) {
    throw new Error(`media sequence did not freeze: ${JSON.stringify({ beforeCount, mediaPaused })}`);
  }
  await page.screenshot({ path: path.join(output, "paused-presentations.png"), fullPage: true });
  await page.click("#btn-play");
  await page.waitForTimeout(900);
  const afterCount = await page.locator("#memory-reel-count").textContent();
  if (afterCount === beforeCount) throw new Error("media sequence did not resume after playback resumed");

  const audit = { regionPaused, mediaPaused, beforeCount, afterCount, errors };
  await fs.writeFile(path.join(output, "browser-audit.json"), JSON.stringify(audit, null, 2) + "\n");
  await browser.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("presentation pause browser test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
