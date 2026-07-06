"use strict";

const fs = require("fs");
const vm = require("vm");

const context = { window: { RouteDemo: {} } };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync("assets/modules/playback-engine.js", "utf8"),
  context,
);

const PlaybackEngine = context.window.RouteDemo.PlaybackEngine;
const player = new PlaybackEngine({ totalDistance: 1000, initialRate: 0.2 });

if (player.isPlaying()) throw new Error("player must start paused");
player.resume("user");
if (!player.isPlaying()) throw new Error("player did not start");
player.pause("media");
player.pause("user");
player.resume("media");
if (player.isPlaying()) throw new Error("media close resumed a user-paused route");
player.resume("user");
player.setDistance(1200);
if (player.distance !== 1000) throw new Error("distance was not clamped");
player.setDistance(500);
player.setFactor("media", 0.5);
player.setFactor("camera", 0.4);
if (Math.abs(player.factor - 0.2) > 1e-9) throw new Error("factors were not composed");
player.complete();
if (player.isPlaying() || !player.completed) throw new Error("completion state is invalid");
player.reset({ distance: 20, playing: true });
if (!player.isPlaying() || player.distance !== 20 || player.factor !== 1)
  throw new Error("reset state is invalid");

console.log("playback engine test passed");
