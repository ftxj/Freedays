"use strict";

(function (app) {
  class PlaybackEngine {
    constructor(options = {}) {
      this.totalDistance = Math.max(0, Number(options.totalDistance) || 0);
      this.distance = 0;
      this.rate = Number.isFinite(options.initialRate) ? options.initialRate : 0.2;
      this.factors = new Map();
      this.pauseReasons = new Set(options.initiallyPlaying ? [] : ["user"]);
      this.completed = false;
      this.listeners = new Set();
      if (typeof options.onChange === "function") this.listeners.add(options.onChange);
    }

    subscribe(listener) {
      this.listeners.add(listener);
      listener(this.snapshot());
      return () => this.listeners.delete(listener);
    }

    snapshot() {
      return {
        distance: this.distance,
        totalDistance: this.totalDistance,
        rate: this.rate,
        factor: this.factor,
        playing: this.isPlaying(),
        completed: this.completed,
        pauseReasons: [...this.pauseReasons],
      };
    }

    emit() {
      const state = this.snapshot();
      this.listeners.forEach((listener) => listener(state));
    }

    isPlaying() {
      return !this.completed && this.pauseReasons.size === 0;
    }

    setDistance(value) {
      this.distance = Math.max(0, Math.min(this.totalDistance, Number(value) || 0));
      if (this.distance < this.totalDistance) this.completed = false;
      return this.distance;
    }

    setRate(value) {
      if (Number.isFinite(value) && value > 0) this.rate = value;
      this.emit();
    }

    setFactor(name, value) {
      const factor = Number.isFinite(value) ? Math.max(0.02, value) : 1;
      if (factor === 1) this.factors.delete(name);
      else this.factors.set(name, factor);
      this.emit();
    }

    get factor() {
      let result = 1;
      this.factors.forEach((value) => (result *= value));
      return result;
    }

    pause(reason = "user") {
      this.pauseReasons.add(reason);
      this.emit();
    }

    resume(reason = "user") {
      this.pauseReasons.delete(reason);
      this.emit();
      return this.isPlaying();
    }

    toggle(reason = "user") {
      if (this.pauseReasons.has(reason)) this.resume(reason);
      else this.pause(reason);
      return this.isPlaying();
    }

    complete() {
      this.distance = this.totalDistance;
      this.completed = true;
      this.pauseReasons.add("complete");
      this.emit();
    }

    reset(options = {}) {
      this.distance = Math.max(
        0,
        Math.min(this.totalDistance, Number(options.distance) || 0),
      );
      this.completed = false;
      this.factors.clear();
      this.pauseReasons.clear();
      if (!options.playing) this.pauseReasons.add("user");
      this.emit();
    }
  }

  app.PlaybackEngine = PlaybackEngine;
})(window.RouteDemo || (window.RouteDemo = {}));
