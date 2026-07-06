#!/usr/bin/env node
"use strict";

// Browser regression for authored still-photo movement. It intentionally uses
// an existing local photo without modifying route data or generated assets.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");

(async () => {
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
  await page.waitForSelector(".car", { state: "attached", timeout: 15000 });
  await page.click("#btn-story-editor");
  await page.waitForFunction(() => document.querySelector("#story-editor-route-time").textContent !== "--");
  await page.fill("#story-editor-title", "静态照片动态化测试");
  await page.fill("#story-editor-assets", "photo/DSC_8732.JPG");
  await page.selectOption("#story-editor-photo-motion", "pan-left-to-right");
  await page.selectOption("#story-editor-photo-aspect", "1.7777778");
  await page.fill("#story-editor-photo-duration", "4");
  await page.fill("#story-editor-photo-scale", "1.16");
  await page.click("#story-editor-preview");
  await page.waitForSelector("#supply-card.show #supply-image", { state: "visible", timeout: 5000 });
  await page.waitForFunction(() => document.querySelector("#supply-image").complete);

  const running = await page.evaluate(() => {
    const media = document.querySelector("#supply-media");
    const image = document.querySelector("#supply-image");
    const mediaStyle = getComputedStyle(media);
    const imageStyle = getComputedStyle(image);
    return {
      preset: media.dataset.photoMotion,
      aspect: Number(mediaStyle.aspectRatio),
      duration: imageStyle.animationDuration,
      animation: imageStyle.animationName,
      state: imageStyle.animationPlayState,
      objectFit: imageStyle.objectFit,
      scale: media.style.getPropertyValue("--photo-motion-scale"),
    };
  });
  if (
    running.preset !== "pan-left-to-right" ||
    Math.abs(running.aspect - 1.7777778) > 0.001 ||
    running.duration !== "4s" ||
    running.animation !== "photoPanLeftToRight" ||
    running.state !== "running" ||
    running.objectFit !== "cover" ||
    running.scale !== "1.16"
  ) {
    throw new Error(`photo motion did not render as authored: ${JSON.stringify(running)}`);
  }

  if (await page.locator("#btn-play").getAttribute("data-state") === "paused") {
    await page.click("#btn-play");
    await page.waitForTimeout(100);
  }
  await page.click("#btn-play");
  await page.waitForTimeout(100);
  const paused = await page.locator("#supply-image").evaluate(
    (image) => getComputedStyle(image).animationPlayState,
  );
  if (paused !== "paused") throw new Error(`photo motion did not pause: ${paused}`);
  await page.click("#btn-play");
  await page.waitForTimeout(100);
  const resumed = await page.locator("#supply-image").evaluate(
    (image) => getComputedStyle(image).animationPlayState,
  );
  if (resumed !== "running") throw new Error(`photo motion did not resume: ${resumed}`);

  await browser.close();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("photo motion browser test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
