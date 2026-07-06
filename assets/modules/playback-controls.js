"use strict";

// DOM adapter for transport controls. It sends intent to PlaybackEngine and
// leaves route, camera and overlay rendering to their respective modules.
(function (app) {
  class PlaybackControls {
    constructor(options) {
      this.options = options;
      this.player = options.player;
      this.playButton = document.getElementById("btn-play");
      this.bind();
      this.player.subscribe((state) => this.render(state));
    }

    bind() {
      this.playButton.onclick = () => {
        if (this.player.completed) {
          this.options.onReplay({ autoplay: true });
          return;
        }
        this.player.toggle("user");
        // Overall playback may still be held by `media`. UI intent is based on
        // the user's lock, not on whether the route happens to be moving.
        if (this.player.pauseReasons.has("user")) this.options.onPause();
        else this.options.onPlay();
      };
      document.getElementById("btn-replay").onclick = () =>
        this.options.onReplay({ autoplay: false });
      document.getElementById("spd").oninput = (event) => {
        const displayRate = Number(event.target.value) / 100;
        this.player.setRate(displayRate / 5);
        document.getElementById("spd-v").textContent =
          (displayRate < 0.1
            ? displayRate.toFixed(3)
            : displayRate.toFixed(2)) + "×";
      };
      document.getElementById("paus").oninput = (event) =>
        this.options.onPauseSeconds(
          Math.max(0, Number(event.target.value) || 0),
        );
      document.getElementById("seek").oninput = (event) =>
        this.options.onSeek(
          Number(event.target.value) / Number(event.target.max || 100000),
        );
    }

    render(state) {
      const userPaused = state.pauseReasons.includes("user") || state.completed;
      this.playButton.textContent = userPaused ? "▶ 播放" : "⏸ 暂停";
      this.playButton.dataset.state = userPaused ? "paused" : "playing";
      this.playButton.dataset.routeState = state.playing ? "moving" : "held";
    }
  }

  app.PlaybackControls = PlaybackControls;
})(window.RouteDemo || (window.RouteDemo = {}));
