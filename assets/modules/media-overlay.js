"use strict";

(function (app) {
  class MediaOverlay {
    constructor(options) {
      this.options = options;
      this.timer = 0;
      this.slideTimer = 0;
      this.timerDeadline = 0;
      this.slideDeadline = 0;
      this.timerRemaining = 0;
      this.slideRemaining = 0;
      this.timerCallback = null;
      this.slideCallback = null;
      this.presentationPaused = false;
      this.videoResumeAfterPause = false;
      this.resumePlayback = false;
      this.card = document.getElementById("supply-card");
      this.video = document.getElementById("supply-video");
      this.image = document.getElementById("supply-image");
      this.media = document.getElementById("supply-media");
      this.reel = document.getElementById("memory-reel");
      this.clips = [];
      this.clipIndex = 0;
      this.layoutToken = 0;
      this.showToken = 0;
      this.defaultLayout = null;
      this.layoutCache = new Map();
      this.bindEvents();
    }

    bindEvents() {
      this.media.onclick = () => this.play();
      this.media.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.play();
        }
      };
      document.getElementById("supply-close").onclick = (event) => {
        event.stopPropagation();
        this.close();
      };
      document.getElementById("memory-reel-prev").onclick = (event) => {
        event.stopPropagation();
        this.stepClip(-1);
      };
      document.getElementById("memory-reel-next").onclick = (event) => {
        event.stopPropagation();
        this.stepClip(1);
      };
      this.video.onended = () => {
        this.scheduleMain(() => this.close(), 1400);
      };
      this.video.onloadedmetadata = () => {
        if (this.video.videoWidth && this.video.videoHeight) {
          this.applyMediaDimensions(this.video.videoWidth, this.video.videoHeight);
        }
      };
    }

    scheduleMain(callback, delay) {
      this.clearMainTimer();
      this.timerCallback = callback;
      this.timerRemaining = Math.max(0, delay);
      if (this.presentationPaused) return;
      this.timerDeadline = performance.now() + this.timerRemaining;
      this.timer = setTimeout(() => {
        this.timer = 0;
        this.timerRemaining = 0;
        callback();
      }, this.timerRemaining);
    }

    scheduleSlide(callback, delay) {
      this.clearSlideTimer();
      this.slideCallback = callback;
      this.slideRemaining = Math.max(0, delay);
      if (this.presentationPaused) return;
      this.slideDeadline = performance.now() + this.slideRemaining;
      this.slideTimer = setTimeout(() => {
        this.slideTimer = 0;
        this.slideRemaining = 0;
        callback();
      }, this.slideRemaining);
    }

    clearMainTimer() {
      clearTimeout(this.timer);
      this.timer = 0;
      this.timerDeadline = 0;
      this.timerRemaining = 0;
      this.timerCallback = null;
    }

    clearSlideTimer() {
      clearTimeout(this.slideTimer);
      this.slideTimer = 0;
      this.slideDeadline = 0;
      this.slideRemaining = 0;
      this.slideCallback = null;
    }

    pausePresentation() {
      if (this.presentationPaused) return;
      this.presentationPaused = true;
      if (this.timer) {
        this.timerRemaining = Math.max(0, this.timerDeadline - performance.now());
        clearTimeout(this.timer);
        this.timer = 0;
      }
      if (this.slideTimer) {
        this.slideRemaining = Math.max(0, this.slideDeadline - performance.now());
        clearTimeout(this.slideTimer);
        this.slideTimer = 0;
      }
      this.videoResumeAfterPause = !this.video.paused && !this.video.ended;
      this.video.pause();
      this.card.classList.add("presentation-paused");
    }

    resumePresentation() {
      if (!this.presentationPaused) return;
      this.presentationPaused = false;
      this.card.classList.remove("presentation-paused");
      if (this.timerCallback && this.timerRemaining > 0) {
        const callback = this.timerCallback;
        const remaining = this.timerRemaining;
        this.scheduleMain(callback, remaining);
      }
      if (this.slideCallback && this.slideRemaining > 0) {
        const callback = this.slideCallback;
        const remaining = this.slideRemaining;
        this.scheduleSlide(callback, remaining);
      }
      const resumeVideo = this.videoResumeAfterPause;
      this.videoResumeAfterPause = false;
      if (resumeVideo) this.play();
    }

    resumeIfNeeded() {
      if (!this.resumePlayback) return;
      this.resumePlayback = false;
      this.options.resumePlayback();
    }

    hide(resume = false) {
      this.showToken += 1;
      this.clearMainTimer();
      this.clearSlideTimer();
      this.video.pause();
      this.video.controls = false;
      try {
        this.video.currentTime = 0;
      } catch (_error) {}
      this.video.removeAttribute("src");
      this.video.removeAttribute("poster");
      this.video.muted = false;
      this.video.load();
      this.image.removeAttribute("src");
      this.image.alt = "";
      delete this.media.dataset.src;
      this.media.classList.remove("playing", "static-image");
      this.media.style.removeProperty("--media-aspect");
      this.media.style.removeProperty("aspect-ratio");
      this.card.classList.remove("show", "closing", "video-open", "landscape");
      this.card.classList.remove("presentation-paused");
      this.image.onload = null;
      this.layoutToken += 1;
      if (typeof this.options.setPlaybackFactor === "function") {
        this.options.setPlaybackFactor(1);
      }
      void this.card.offsetWidth;
      if (resume) this.resumeIfNeeded();
      else this.resumePlayback = false;
    }

    applyMediaDimensions(width, height) {
      if (!width || !height) return;
      this.card.classList.toggle("landscape", width >= height);
      const aspect = width / height;
      this.media.style.setProperty("--media-aspect", String(aspect));
      this.media.style.aspectRatio = `${width} / ${height}`;
    }

    resolveClipLayout(clip, fallbackLayout = null) {
      const explicitLayout = clip?.media_layout || clip?.layout || fallbackLayout;
      if (Number.isFinite(clip?.media_aspect) && clip.media_aspect > 0) {
        clip.detected_aspect = clip.media_aspect;
        return Promise.resolve(clip.media_aspect >= 1 ? "landscape" : "portrait");
      }
      const probeSource = clip?.image || clip?.poster;
      const fallback = explicitLayout === "landscape" ? "landscape" : "portrait";
      if (!probeSource) {
        clip.detected_aspect = fallback === "landscape" ? 16 / 9 : 3 / 4;
        return Promise.resolve(fallback);
      }
      if (this.layoutCache.has(probeSource)) {
        const cached = this.layoutCache.get(probeSource);
        clip.detected_aspect = cached.aspect;
        return Promise.resolve(cached.layout);
      }
      return new Promise((resolve) => {
        const probe = new Image();
        let settled = false;
        const finish = (layout, width = 0, height = 0) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const aspect = width && height ? width / height : layout === "landscape" ? 16 / 9 : 3 / 4;
          clip.detected_aspect = aspect;
          this.layoutCache.set(probeSource, { layout, aspect });
          resolve(layout);
        };
        const timeout = setTimeout(() => finish(fallback), 1200);
        probe.onload = () =>
          finish(
            probe.naturalWidth >= probe.naturalHeight ? "landscape" : "portrait",
            probe.naturalWidth,
            probe.naturalHeight,
          );
        probe.onerror = () => finish(fallback);
        probe.src = probeSource;
      });
    }

    setClip(index, autoplay = false) {
      if (!this.clips.length) return;
      this.clipIndex = (index + this.clips.length) % this.clips.length;
      const clip = this.clips[this.clipIndex];
      const layoutToken = ++this.layoutToken;
      const explicitLayout =
        clip.detected_layout || clip.media_layout || clip.layout || this.defaultLayout;
      const applyDimensions = (width, height) => {
        if (layoutToken !== this.layoutToken || !width || !height) return;
        this.applyMediaDimensions(width, height);
      };
      this.card.classList.toggle("landscape", explicitLayout === "landscape");
      this.media.style.setProperty(
        "--media-aspect",
        String(clip.detected_aspect || (explicitLayout === "landscape" ? 16 / 9 : 3 / 4)),
      );
      this.media.style.aspectRatio = String(
        clip.detected_aspect || (explicitLayout === "landscape" ? 16 / 9 : 3 / 4),
      );
      this.video.pause();
      this.video.removeAttribute("src");
      this.image.removeAttribute("src");
      const isImage = Boolean(clip.image);
      this.media.classList.toggle("static-image", isImage);
      if (isImage) {
        this.video.removeAttribute("poster");
        delete this.media.dataset.src;
        this.image.onload = () => {
          if (!explicitLayout) {
            applyDimensions(this.image.naturalWidth, this.image.naturalHeight);
          }
        };
        this.image.src = clip.image;
        this.image.alt = clip.alt || clip.title || "旅行照片";
      } else {
        this.video.poster = clip.poster || "";
        this.media.dataset.src = clip.video;
        if (!explicitLayout && clip.poster) {
          const posterProbe = new Image();
          posterProbe.onload = () =>
            applyDimensions(posterProbe.naturalWidth, posterProbe.naturalHeight);
          posterProbe.src = clip.poster;
        }
      }
      document.getElementById("supply-video-label").textContent =
        clip.label || "查看旅途影像";
      document.getElementById("memory-reel-count").textContent =
        String(this.clipIndex + 1).padStart(2, "0") +
        " / " +
        String(this.clips.length).padStart(2, "0");
      document.getElementById("memory-reel-title").textContent =
        clip.title || "旅途影像";
      this.media.classList.remove("playing");
      this.video.controls = false;
      this.video.load();
      if (autoplay && !isImage) {
        if (this.presentationPaused) this.videoResumeAfterPause = true;
        else this.play();
      }
    }

    async stepClip(delta) {
      this.clearSlideTimer();
      const autoplay = this.card.classList.contains("video-open");
      const nextIndex = (this.clipIndex + delta + this.clips.length) % this.clips.length;
      const clip = this.clips[nextIndex];
      const showToken = this.showToken;
      if (!clip.detected_layout) {
        clip.detected_layout = await this.resolveClipLayout(clip, this.defaultLayout);
      }
      if (showToken !== this.showToken) return;
      this.setClip(nextIndex, autoplay);
    }

    startImageSequence(intervalMs) {
      this.clearSlideTimer();
      if (this.clips.length < 2) return;
      let remaining = this.clips.length - 1;
      const advance = () => {
        if (!this.card.classList.contains("show") || remaining <= 0) return;
        this.setClip(this.clipIndex + 1, false);
        remaining -= 1;
        if (remaining > 0) this.scheduleSlide(advance, intervalMs);
      };
      this.scheduleSlide(advance, intervalMs);
    }

    close() {
      this.clearMainTimer();
      if (!this.card.classList.contains("show")) return;
      this.card.classList.add("closing");
      this.scheduleMain(() => this.hide(true), 380);
    }

    async show(event) {
      const pausesRoute = event.pause !== false;
      const shouldResume = pausesRoute && this.options.isPlaying();
      this.hide(false);
      const showToken = ++this.showToken;
      this.resumePlayback = shouldResume;
      if (typeof this.options.setPlaybackFactor === "function") {
        this.options.setPlaybackFactor(
          Number.isFinite(event.playback_factor) ? event.playback_factor : 1,
        );
      }
      if (pausesRoute && this.options.isPlaying()) this.options.pausePlayback();

      document.getElementById("supply-kicker").textContent =
        event.kicker || "旅 途 补 给";
      document.getElementById("supply-title").textContent =
        event.title || "获得物资";
      document.getElementById("supply-subtitle").textContent =
        event.subtitle || "";
      document.getElementById("supply-items").innerHTML = (event.items || [])
        .map(
          (item) =>
            '<div class="supply-item ' +
            (item.tone || "") +
            '"><div class="supply-icon">' +
            item.icon +
            '</div><div><div class="supply-name">' +
            item.name +
            '</div><div class="supply-count">× ' +
            item.count +
            "</div></div></div>",
        )
        .join("");

      this.clips = (event.clips || [])
        .filter((clip) => clip.video || clip.image)
        .map((clip) => ({ ...clip }));
      if (!this.clips.length && event.video) {
        this.clips = [
          {
            video: event.video,
            poster: event.poster,
            title: event.video_title || event.title,
            label: event.video_label,
            media_layout: event.media_layout,
            media_aspect: event.media_aspect,
          },
        ];
      }
      if (!this.clips.length && event.image) {
        this.clips = [
          {
            image: event.image,
            alt: event.image_alt,
            title: event.image_title || event.title,
            label: event.image_label,
            media_layout: event.media_layout,
            media_aspect: event.media_aspect,
          },
        ];
      }
      this.media.style.display = this.clips.length ? "block" : "none";
      this.reel.style.display = this.clips.length > 1 ? "flex" : "none";
      this.video.muted = event.muted === true;
      this.card.classList.toggle("memory", event.priority === "memory");
      this.card.classList.toggle("chapter", event.priority !== "memory");
      this.defaultLayout = event.media_layout || null;
      if (this.clips.length) {
        this.clips[0].detected_layout = await this.resolveClipLayout(
          this.clips[0],
          this.defaultLayout,
        );
        if (showToken !== this.showToken) return;
        this.setClip(0, event.autoplay === true);
      }
      const containsOnlyImages = this.clips.length && this.clips.every((clip) => clip.image);
      document.getElementById("supply-hint").textContent = containsOnlyImages
        ? Number.isFinite(event.auto_advance_ms)
          ? "照片连拍自动播放"
          : event.image_label || ""
        : this.clips.length
          ? this.clips.length > 1
            ? "点击播放 · 使用箭头翻阅此地影像"
            : "点击影像 · 查看旅途动态记忆"
          : "";
      this.card.classList.add("show");
      this.card.classList.toggle("presentation-paused", this.presentationPaused);
      if (containsOnlyImages && Number.isFinite(event.auto_advance_ms)) {
        this.startImageSequence(Math.max(250, event.auto_advance_ms));
      }
      this.scheduleMain(
        () => this.close(),
        Number.isFinite(event.duration_ms)
          ? Math.max(1500, event.duration_ms)
          : event.priority === "memory" ? 8000 : 12000,
      );
    }

    play() {
      if (!this.media.dataset.src && !this.video.src) return;
      this.clearMainTimer();
      if (!this.video.src) {
        this.video.src = this.media.dataset.src;
        this.video.load();
      }
      this.card.classList.add("video-open");
      this.media.classList.add("playing");
      this.video.controls = true;
      this.video.play().catch(() => {
        this.card.classList.remove("video-open");
        this.media.classList.remove("playing");
        this.video.controls = false;
      });
    }
  }

  app.MediaOverlay = MediaOverlay;
})(window.RouteDemo || (window.RouteDemo = {}));
