#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const dimensions = new Map([
  ["four-three.jpg", [640, 480]],
  ["three-two.jpg", [1500, 1000]],
  ["portrait.jpg", [900, 1600]],
]);

class ProbeImage {
  set src(value) {
    const size = dimensions.get(value);
    if (!size) {
      queueMicrotask(() => this.onerror?.());
      return;
    }
    [this.naturalWidth, this.naturalHeight] = size;
    queueMicrotask(() => this.onload?.());
  }
}

const context = {
  window: { RouteDemo: {} },
  Image: ProbeImage,
  Map,
  Promise,
  Number,
  String,
  setTimeout,
  clearTimeout,
  queueMicrotask,
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, "assets/modules/media-overlay.js"), "utf8"),
  context,
);

async function resolve(clip, fallback = null) {
  const overlay = Object.create(context.window.RouteDemo.MediaOverlay.prototype);
  overlay.layoutCache = new Map();
  const layout = await overlay.resolveClipLayout(clip, fallback);
  return { layout, aspect: clip.detected_aspect };
}

(async () => {
  const fourThree = await resolve({ poster: "four-three.jpg", media_layout: "landscape" });
  const threeTwo = await resolve({ image: "three-two.jpg", media_layout: "landscape" });
  const portrait = await resolve({ image: "portrait.jpg" });
  if (fourThree.layout !== "landscape" || Math.abs(fourThree.aspect - 4 / 3) > 1e-6) {
    throw new Error(`4:3 poster was not preserved: ${JSON.stringify(fourThree)}`);
  }
  if (threeTwo.layout !== "landscape" || Math.abs(threeTwo.aspect - 3 / 2) > 1e-6) {
    throw new Error(`3:2 image was not preserved: ${JSON.stringify(threeTwo)}`);
  }
  if (portrait.layout !== "portrait" || Math.abs(portrait.aspect - 9 / 16) > 1e-6) {
    throw new Error(`portrait image was not preserved: ${JSON.stringify(portrait)}`);
  }
  console.log("Media overlay aspect regression passed | 4:3 + 3:2 + 9:16");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
