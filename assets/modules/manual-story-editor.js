"use strict";

// Browser-side authoring tool for story points. Saved entries are translated
// into the same event/camera shapes consumed by TimelineRuntime and CameraPolicy.
(function (app) {
  const STORAGE_KEY = "tibet-route-manual-story-points-v1";

  function numberValue(id, fallback) {
    const value = Number(document.getElementById(id).value);
    return Number.isFinite(value) ? value : fallback;
  }

  function assetKind(path) {
    return /\.(?:mp4|mov)$/i.test(path) ? "video" : "image";
  }

  function posterFor(path) {
    return path.replace(/(?:_web)?\.(?:mp4|mov)$/i, "_poster.jpg");
  }

  function shiftedIso(value, seconds) {
    return new Date(new Date(value).getTime() + seconds * 1000).toISOString();
  }

  function eventAssets(event) {
    if (Array.isArray(event.source_paths) && event.source_paths.length) return [...event.source_paths];
    if (Array.isArray(event.clips)) {
      return event.clips.map((clip) => clip.video || clip.image).filter(Boolean);
    }
    return [event.video, event.image].filter(Boolean);
  }

  function normalizeChinaTime(value) {
    if (!value) return "";
    return /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}+08:00`;
  }

  class ManualStoryEditor {
    constructor(options) {
      this.options = options;
      this.panel = document.getElementById("story-editor");
      this.openButton = document.getElementById("btn-story-editor");
      this.savedSelect = document.getElementById("story-editor-saved");
      this.coordinateOutput = document.getElementById("story-editor-coordinate");
      this.routeTimeOutput = document.getElementById("story-editor-route-time");
      this.status = document.getElementById("story-editor-status");
      this.points = this.readStorage();
      this.existingEntries = options.existingEntries || [];
      this.existingById = new Map(this.existingEntries.map((entry) => [entry.event.id, entry]));
      this.currentId = "";
      this.currentOverride = null;
      this.lonlat = null;
      this.routeContext = null;
      this.cameraCenter = null;
      this.bindEvents();
      this.renderSaved();
      this.options.coordinatePicker.onPick((lonlat) => this.setCoordinate(lonlat));
    }

    readStorage() {
      // Local storage is a draft workspace only. Exported JSON is the portable
      // artifact that can later be reviewed and merged into project data.
      try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        return Array.isArray(value) ? value : [];
      } catch (_error) {
        return [];
      }
    }

    writeStorage() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.points));
    }

    bindEvents() {
      this.openButton.onclick = () => this.startNewFromCurrent();
      document.getElementById("story-editor-capture").onclick = () => this.startNewFromCurrent();
      document.getElementById("story-editor-close").onclick = () => this.close();
      document.getElementById("story-editor-pick").onclick = () => {
        this.open();
        this.options.coordinatePicker.setEnabled(true);
        this.setStatus("请在地图上点击故事发生位置");
      };
      document.getElementById("story-editor-use-backpack").onclick = () => {
        const input = document.getElementById("story-editor-assets");
        const selectedPaths = input.value.split("\n").map((value) => value.trim()).filter(Boolean);
        this.options.openAssetSelector?.(selectedPaths, (paths) => {
          input.value = paths.join("\n");
          this.open();
          this.setStatus(`已选择 ${paths.length} 件素材`);
        });
      };
      document.getElementById("story-editor-use-view").onclick = () => {
        const view = this.options.getMapView();
        this.applyMapView(view);
        this.setStatus("已读取当前地图视角");
      };
      document.getElementById("story-editor-time").onchange = (event) => {
        const time = normalizeChinaTime(event.target.value);
        if (!time) return;
        const context = this.options.getRouteContextForTime(time);
        this.routeContext = { k: context.k, time, altitude: context.altitude };
        this.routeTimeOutput.textContent = time.replace("T", " ").slice(0, 19);
        this.setStatus("已修改触发时间，故事 GPS 和镜头不变");
      };
      document.getElementById("story-editor-preview").onclick = () => {
        const point = this.readForm(false);
        if (point) this.options.onPreview(this.runtimeEntry(point));
      };
      document.getElementById("story-editor-save").onclick = () => this.save();
      document.getElementById("story-editor-delete").onclick = () => this.remove();
      document.getElementById("story-editor-copy-json").onclick = () => this.copyJson();
      document.getElementById("story-editor-download-json").onclick = () => this.downloadJson();
      this.savedSelect.onchange = () => this.loadSelection(this.savedSelect.value);
      document.getElementById("story-editor-type").onchange = (event) => {
        if (event.target.value === "hero" || event.target.value === "chapter") {
          document.getElementById("story-editor-pause").value = "true";
        }
      };
    }

    open() {
      this.panel.classList.add("show");
      this.panel.setAttribute("aria-hidden", "false");
      this.openButton.classList.add("active");
    }

    close() {
      this.panel.classList.remove("show");
      this.panel.setAttribute("aria-hidden", "true");
      this.openButton.classList.remove("active");
    }

    activateStored() {
      this.options.onChange(this.points.map((point) => this.runtimeEntry(point)));
    }

    startNewFromCurrent() {
      this.clearForm();
      const context = this.options.getCurrentContext?.();
      if (!context?.lonlat || !context?.time) {
        this.open();
        return this.setStatus("当前路线位置尚未就绪", true);
      }
      this.lonlat = [...context.lonlat];
      this.routeContext = { k: context.k, time: context.time, altitude: context.altitude };
      this.coordinateOutput.textContent = `[${this.lonlat[0].toFixed(6)}, ${this.lonlat[1].toFixed(6)}]`;
      this.routeTimeOutput.textContent = context.time.replace("T", " ").slice(0, 19);
      document.getElementById("story-editor-time").value = context.time.slice(0, 19);
      this.applyMapView(this.options.getMapView());
      this.options.coordinatePicker.pick(this.lonlat[0], this.lonlat[1]);
      this.open();
      this.setStatus("已读取当前时间、GPS 和地图镜头；也可手工重选 GPS");
    }

    applyMapView(view) {
      document.getElementById("story-editor-zoom").value = Number(view.zoom).toFixed(1);
      document.getElementById("story-editor-pitch").value = Math.round(view.pitch);
      document.getElementById("story-editor-bearing").value = Math.round(view.bearing);
      this.cameraCenter = Array.isArray(view.center) ? [...view.center] : this.lonlat ? [...this.lonlat] : null;
      this.renderCameraCenter();
    }

    renderCameraCenter() {
      const output = document.getElementById("story-editor-camera-center");
      const offset = document.getElementById("story-editor-camera-offset");
      output.textContent = this.cameraCenter
        ? `[${this.cameraCenter[0].toFixed(6)}, ${this.cameraCenter[1].toFixed(6)}]`
        : "读取当前地图中心";
      offset.textContent = this.cameraCenter && this.lonlat &&
        (Math.abs(this.cameraCenter[0] - this.lonlat[0]) > 0.000001 || Math.abs(this.cameraCenter[1] - this.lonlat[1]) > 0.000001)
        ? "镜头中心与故事 GPS 分离" : "同一位置";
    }

    setCoordinate(lonlat) {
      this.lonlat = [...lonlat];
      const preservedTime = Boolean(this.routeContext?.time);
      if (!this.routeContext) this.routeContext = this.options.getRouteContext(this.lonlat);
      this.coordinateOutput.textContent = `[${lonlat[0].toFixed(6)}, ${lonlat[1].toFixed(6)}]`;
      this.routeTimeOutput.textContent = this.routeContext.time.replace("T", " ").slice(0, 19);
      document.getElementById("story-editor-time").value = this.routeContext.time.slice(0, 19);
      this.renderCameraCenter();
      this.open();
      this.setStatus(preservedTime
        ? "已替换故事 GPS，触发时间保持不变"
        : "已吸附到最近轨迹时间");
    }

    clearForm() {
      this.currentId = "";
      this.currentOverride = null;
      this.lonlat = null;
      this.routeContext = null;
      this.cameraCenter = null;
      this.coordinateOutput.textContent = "请先点击地图";
      this.routeTimeOutput.textContent = "--";
      document.getElementById("story-editor-time").value = "";
      this.renderCameraCenter();
      for (const id of ["story-editor-kicker", "story-editor-title", "story-editor-subtitle", "story-editor-assets"]) {
        document.getElementById(id).value = "";
      }
      document.getElementById("story-editor-type").value = "memory";
      document.getElementById("story-editor-pause").value = "false";
      this.savedSelect.value = "";
      const origin = document.getElementById("story-editor-origin");
      origin.textContent = "新建故事点会使用当前播放状态";
      origin.classList.remove("override");
    }

    readForm(requireTitle = true) {
      // Normalize UI strings at the boundary so runtime code receives stable
      // China-time timestamps, coordinates and numeric camera properties.
      if (!this.lonlat || !this.routeContext) {
        this.setStatus("请先在地图上选一个 GPS 位置", true);
        return null;
      }
      const title = document.getElementById("story-editor-title").value.trim();
      if (requireTitle && !title) {
        this.setStatus("请填写故事标题", true);
        return null;
      }
      const type = document.getElementById("story-editor-type").value;
      const assets = document.getElementById("story-editor-assets").value
        .split("\n").map((value) => value.trim()).filter(Boolean);
      if (type !== "chapter" && !assets.length) {
        this.setStatus("请至少填写一个素材路径", true);
        return null;
      }
      const routeTime = normalizeChinaTime(document.getElementById("story-editor-time").value) || this.routeContext.time;
      const timeContext = this.options.getRouteContextForTime(routeTime);
      return {
        id: this.currentId || (this.currentOverride ? `manual-override-${this.currentOverride.event_id}` : `manual-story-${Date.now()}`),
        overrides_event_id: this.currentOverride?.event_id || null,
        overrides_camera_id: this.currentOverride?.camera_id || null,
        lonlat: [...this.lonlat],
        camera_center: this.cameraCenter ? [...this.cameraCenter] : [...this.lonlat],
        route_time: routeTime,
        route_index: timeContext.k,
        type,
        pause: document.getElementById("story-editor-pause").value === "true",
        kicker: document.getElementById("story-editor-kicker").value.trim(),
        title: title || "未命名故事点",
        subtitle: document.getElementById("story-editor-subtitle").value.trim(),
        assets,
        zoom: numberValue("story-editor-zoom", 14.5),
        pitch: numberValue("story-editor-pitch", 48),
        bearing: numberValue("story-editor-bearing", 0),
        playback_factor: numberValue("story-editor-playback", 0.45),
        duration_seconds: numberValue("story-editor-duration", 5),
        camera_window_seconds: numberValue("story-editor-window", 45),
        updated_at: new Date().toISOString(),
      };
    }

    save() {
      const point = this.readForm(true);
      if (!point) return;
      const index = this.points.findIndex((item) => item.id === point.id);
      if (index >= 0) this.points[index] = point;
      else this.points.push(point);
      this.currentId = point.id;
      this.writeStorage();
      this.renderSaved();
      this.savedSelect.value = `manual:${point.id}`;
      this.options.onChange(this.points.map((item) => this.runtimeEntry(item)));
      this.options.onPreview(this.runtimeEntry(point));
      this.setStatus("已保存到浏览器，重播路线时会按 GPS 触发");
    }

    remove() {
      if (!this.currentId) return this.setStatus("当前没有可删除的故事点", true);
      this.points = this.points.filter((point) => point.id !== this.currentId);
      this.writeStorage();
      this.renderSaved();
      this.clearForm();
      this.options.onChange(this.points.map((item) => this.runtimeEntry(item)));
      this.setStatus("已删除故事点");
    }

    renderSaved() {
      this.savedSelect.replaceChildren();
      const fresh = document.createElement("option");
      fresh.value = "";
      fresh.textContent = "＋ 使用当前状态新建";
      this.savedSelect.append(fresh);

      const manualGroup = document.createElement("optgroup");
      manualGroup.label = "手工故事点 / 已保存覆盖";
      this.points.forEach((point) => {
        const option = document.createElement("option");
        option.value = `manual:${point.id}`;
        option.textContent = `${point.overrides_event_id ? "覆盖 · " : ""}${point.title} · ${point.route_time.slice(5, 16).replace("T", " ")}`;
        manualGroup.append(option);
      });
      if (this.points.length) this.savedSelect.append(manualGroup);

      const existingGroup = document.createElement("optgroup");
      existingGroup.label = "现有动画效果";
      this.existingEntries.forEach((entry) => {
        const option = document.createElement("option");
        const overridden = this.points.some((point) => point.overrides_event_id === entry.event.id);
        option.value = `existing:${entry.event.id}`;
        option.textContent = `${overridden ? "已覆盖 · " : ""}${entry.event.title} · ${entry.event.time.slice(5, 16).replace("T", " ")}`;
        existingGroup.append(option);
      });
      this.savedSelect.append(existingGroup);
    }

    loadSelection(value) {
      if (!value) return this.startNewFromCurrent();
      const [kind, id] = value.split(/:(.*)/s);
      if (kind === "existing") return this.loadExisting(id);
      return this.loadPoint(id);
    }

    loadExisting(id) {
      const savedOverride = this.points.find((point) => point.overrides_event_id === id);
      if (savedOverride) {
        this.loadPoint(savedOverride.id);
        this.savedSelect.value = `existing:${id}`;
        return;
      }
      const entry = this.existingById.get(id);
      if (!entry) return;
      const event = entry.event;
      const camera = entry.camera || {};
      const route = this.options.getRouteContextForTime(event.time);
      const lonlat = Array.isArray(event.lonlat) ? event.lonlat : route.lonlat;
      const duration = camera.start && camera.end
        ? Math.min(600, Math.max(5, Math.round((new Date(camera.end) - new Date(camera.start)) / 2000)))
        : 45;
      const assets = eventAssets(event);
      let type = event.presentation === "title" ? "chapter" : event.display_type || "memory";
      if (!['memory', 'hero', 'sequence', 'slideshow', 'chapter'].includes(type)) {
        type = assets.length > 1 ? "sequence" : event.priority === "chapter" ? "hero" : "memory";
      }
      this.currentId = "";
      this.currentOverride = { event_id: event.id, camera_id: camera.id || null };
      this.fillPoint({
        lonlat, camera_center: camera.center || lonlat, route_time: event.time, route_index: route.k,
        type, pause: Boolean(event.pause), kicker: event.kicker || event.lead || "", title: event.title,
        subtitle: event.subtitle || event.editorial_note || "", assets,
        zoom: camera.zoom ?? this.options.getMapView().zoom,
        pitch: camera.pitch ?? this.options.getMapView().pitch,
        bearing: camera.bearing ?? (Array.isArray(camera.look_at)
          ? this.options.getBearing(camera.center || lonlat, camera.look_at)
          : this.options.getMapView().bearing),
        playback_factor: event.playback_factor ?? camera.playback_factor ?? 0.55,
        duration_seconds: (event.duration_ms || 5000) / 1000,
        camera_window_seconds: duration,
      });
      const origin = document.getElementById("story-editor-origin");
      origin.textContent = `正在编辑现有效果：${event.id}。保存后将以本地覆盖取代原效果。`;
      origin.classList.add("override");
      this.options.coordinatePicker.pick(lonlat[0], lonlat[1]);
      this.open();
      this.setStatus("已载入现有动画效果，可修改触发时间、GPS、素材、展示方式和镜头");
    }

    fillPoint(point) {
      this.lonlat = [...point.lonlat];
      this.routeContext = { k: point.route_index, time: point.route_time };
      this.cameraCenter = [...(point.camera_center || point.lonlat)];
      this.coordinateOutput.textContent = `[${point.lonlat[0].toFixed(6)}, ${point.lonlat[1].toFixed(6)}]`;
      this.routeTimeOutput.textContent = point.route_time.replace("T", " ").slice(0, 19);
      document.getElementById("story-editor-time").value = point.route_time.slice(0, 19);
      for (const [idSuffix, value] of Object.entries({
        type: point.type, pause: String(point.pause), kicker: point.kicker, title: point.title,
        subtitle: point.subtitle, assets: (point.assets || []).join("\n"), zoom: point.zoom,
        pitch: point.pitch, bearing: point.bearing, playback: point.playback_factor,
        duration: point.duration_seconds, window: point.camera_window_seconds,
      })) document.getElementById(`story-editor-${idSuffix}`).value = value;
      this.renderCameraCenter();
    }

    loadPoint(id) {
      const point = this.points.find((item) => item.id === id);
      if (!point) return;
      this.currentId = point.id;
      this.currentOverride = point.overrides_event_id
        ? { event_id: point.overrides_event_id, camera_id: point.overrides_camera_id || null }
        : null;
      this.fillPoint(point);
      const origin = document.getElementById("story-editor-origin");
      origin.textContent = point.overrides_event_id
        ? `本地覆盖：${point.overrides_event_id}` : "本地新建故事点";
      origin.classList.toggle("override", Boolean(point.overrides_event_id));
      this.options.coordinatePicker.pick(point.lonlat[0], point.lonlat[1]);
      this.setStatus("已载入，修改后点击保存");
    }

    runtimeEntry(point) {
      // Keep point, event and camera records separate: one authoring action may
      // replace a timeline event, a camera directive, or both.
      const isChapter = point.type === "chapter";
      const event = {
        id: point.id,
        authoring_point_id: point.id,
        overrides_event_id: point.overrides_event_id || null,
        presentation: isChapter ? "title" : "media",
        lonlat: point.lonlat,
        time: point.route_time,
        lead: point.kicker || "发 现",
        kicker: point.kicker || "旅 途 记 忆",
        title: point.title,
        subtitle: point.subtitle,
        priority: point.type === "memory" ? "memory" : "chapter",
        pause: point.pause,
        duration_ms: Math.round(point.duration_seconds * 1000),
        playback_factor: point.playback_factor,
      };
      if (!isChapter) {
        const clips = point.assets.map((path) => assetKind(path) === "video"
          ? { video: path, poster: posterFor(path), title: point.title }
          : { image: path, title: point.title, alt: point.subtitle || point.title });
        if (clips.length > 1) {
          event.clips = clips;
          event.auto_advance_ms = point.type === "slideshow" ? 650 : 2200;
        } else if (clips[0]?.video) {
          event.video = clips[0].video;
          event.poster = clips[0].poster;
        } else if (clips[0]?.image) event.image = clips[0].image;
      }
      const camera = {
        id: `${point.id}-camera`, authoring_point_id: point.id,
        overrides_camera_id: point.overrides_camera_id || null,
        name: `手工镜头·${point.title}`,
        start: shiftedIso(point.route_time, -point.camera_window_seconds),
        end: shiftedIso(point.route_time, point.camera_window_seconds),
        mode: "fixed_region", center: point.camera_center || point.lonlat, zoom: point.zoom,
        pitch: point.pitch, bearing: point.bearing, follow_center: false,
        follow_factor: 0, playback_factor: point.playback_factor,
      };
      return { point, event, camera };
    }

    exportPayload() {
      const entries = this.points.map((point) => this.runtimeEntry(point));
      return {
        schema_version: 2,
        generated_at: new Date().toISOString(),
        note: "从地图故事点编辑器导出；复核后合并到 route-overrides.json。",
        manual_story_points: this.points,
        replaced_event_ids: this.points.map((point) => point.overrides_event_id).filter(Boolean),
        story_events: entries.map((entry) => entry.event),
        camera_directives: entries.map((entry) => entry.camera),
      };
    }

    async copyJson() {
      const text = JSON.stringify(this.exportPayload(), null, 2);
      try { await navigator.clipboard.writeText(text); }
      catch (_error) {
        const area = document.createElement("textarea"); area.value = text;
        document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
      }
      this.setStatus("已复制 JSON");
    }

    downloadJson() {
      const blob = new Blob([JSON.stringify(this.exportPayload(), null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = "manual-story-points.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      this.setStatus("已导出 manual-story-points.json");
    }

    setStatus(message, error = false) {
      this.status.textContent = message;
      this.status.classList.toggle("error", error);
    }
  }

  app.ManualStoryEditor = ManualStoryEditor;
})(window.RouteDemo || (window.RouteDemo = {}));
