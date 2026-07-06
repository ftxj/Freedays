"use strict";

const fs = require("fs");
const vm = require("vm");

const route = {
  cumulative: [0, 100, 200],
  nearestIndexToCoordinate: (coordinate) => coordinate[0],
  nearestIndexToTime: (time) => ({ a: 0, b: 1, c: 2 }[time] || 0),
  distanceAtTime: (time) => ({ d: ({ a: 0, b: 100, c: 200 }[time] || 0), k: 0 }),
};
const context = { window: { RouteDemo: {} } };
vm.createContext(context);
for (const file of [
  "assets/modules/directive-engine.js",
  "assets/modules/timeline-runtime.js",
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
}

const { DirectiveEngine, TimelineRuntime } = context.window.RouteDemo;
const runtime = new TimelineRuntime(new DirectiveEngine(route));
runtime.initialize({
  title: [{ id: "title-a", time: "a" }],
  media: [{ id: "media-b", time: "b" }],
});
if (runtime.crossed("title", -1, 1)[0]?.id !== "title-a")
  throw new Error("title event did not fire");
runtime.reset(-Infinity);
const replaced = runtime.applyManual(
  [
    {
      point: { overrides_event_id: "media-b" },
      event: { id: "manual-c", time: "c", presentation: "media" },
    },
  ],
  150,
);
if (!replaced.has("media-b")) throw new Error("override id was not recorded");
if (runtime.crossed("media", 150, 210)[0]?.id !== "manual-c")
  throw new Error("manual media event did not replace the base event");

console.log("timeline runtime test passed");
