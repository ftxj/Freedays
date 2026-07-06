"use strict";

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
        if (this.player.isPlaying()) this.options.onPlay();
        else this.options.onPause();
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
      this.playButton.textContent = state.playing ? "⏸ 暂停" : "▶ 播放";
      this.playButton.dataset.state = state.playing ? "playing" : "paused";
    }
  }

  app.PlaybackControls = PlaybackControls;
})(window.RouteDemo || (window.RouteDemo = {}));
