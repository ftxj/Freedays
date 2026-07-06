"use strict";

(function (app) {
  class StoryTimeline {
    constructor(options) {
      this.options = options;
      this.root = document.getElementById("story-timeline");
      this.range = document.getElementById("story-timeline-seek");
      this.tags = document.getElementById("story-timeline-tags");
      this.current = document.getElementById("story-timeline-current");
      this.focusRoot = document.getElementById("story-focus-timeline");
      this.focusRange = document.getElementById("story-focus-seek");
      this.focusTags = document.getElementById("story-focus-tags");
      this.focusTitle = document.getElementById("story-focus-title");
      this.focusSummary = document.getElementById("story-focus-summary");
      this.focusCurrent = document.getElementById("story-focus-current");
      this.regions = options.regions || [];
      this.events = [];
      this.regionStats = new Map();
      this.activeRegion = null;
      this.range.oninput = () => this.options.onSeek((Number(this.range.value) / 100000) * this.options.totalDistance);
      this.focusRange.oninput = () => this.seekFocus(Number(this.focusRange.value) / 100000);
    }

    setEvents(events) {
      this.events = (events || [])
        .filter((event) => event && event.time && event.title)
        .map((event) => ({
          ...event,
          timestamp: Date.parse(event.time),
          distance: this.options.distanceAtTime(event.time).d,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
      this.buildRegionStats();
      this.renderOverview();
      if (this.activeRegion) this.showFocus(this.activeRegion);
    }

    buildRegionStats() {
      this.regionStats.clear();
      this.regions.forEach((region) => {
        const start = Date.parse(region.start);
        const end = Date.parse(region.end);
        const exact = this.events.filter((event) => event.region_id === region.id);
        const unassigned = this.events.filter((event) => !event.region_id && event.timestamp >= start && event.timestamp <= end);
        const events = [...exact, ...unassigned]
          .filter((event, index, values) => values.findIndex((candidate) => candidate.id === event.id) === index)
          .sort((a, b) => a.timestamp - b.timestamp);
        const mediaCount = events.filter((event) => event.presentation === "media").length;
        this.regionStats.set(region.id, { region, start, end, events, mediaCount, dense: mediaCount >= 3 });
      });
    }

    makeOverviewTag(event, laneEnds) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "story-timeline-tag";
      const isRegion = event.presentation === "title";
      const isMajor = event.display_type === "hero" || event.display_type === "sequence" || event.display_type === "slideshow";
      const stats = isRegion ? this.regionStats.get(event.region_id) : null;
      button.classList.toggle("region", isRegion);
      button.classList.toggle("major", isMajor);
      button.classList.toggle("dense", Boolean(stats?.dense));
      const leftPercent = (event.distance / this.options.totalDistance) * 100;
      let lane = laneEnds.findIndex((end) => leftPercent - end >= 0.45);
      if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
      laneEnds[lane] = leftPercent;
      button.style.left = `${leftPercent}%`;
      button.style.bottom = `${2 + lane * 6}px`;
      button.title = `${event.title}\n${event.time.replace("T", " ").slice(5, 16)}${stats?.dense ? `\n点击展开 ${stats.mediaCount} 个故事节点` : ""}`;
      button.setAttribute("aria-label", button.title);
      const dot = document.createElement("i");
      const label = document.createElement("span");
      label.textContent = stats?.dense ? `${event.title} · ${stats.mediaCount}` : event.title;
      button.append(dot, label);
      button.onclick = () => {
        this.options.onSelect(event, event.distance);
        if (stats?.dense) this.showFocus(stats.region);
      };
      return button;
    }

    renderOverview() {
      this.tags.replaceChildren();
      const laneEnds = [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
      this.events
        .filter((event) => event.presentation === "title" || ["hero", "sequence", "slideshow"].includes(event.display_type))
        .forEach((event) => this.tags.append(this.makeOverviewTag(event, laneEnds)));
    }

    regionAt(time) {
      const timestamp = Date.parse(time);
      return [...this.regionStats.values()]
        .filter((stats) => stats.dense && timestamp >= stats.start && timestamp <= stats.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.region || null;
    }

    showFocus(region) {
      const stats = this.regionStats.get(region.id);
      if (!stats?.dense) return this.hideFocus();
      this.activeRegion = region;
      this.focusRoot.classList.add("show");
      this.focusRoot.setAttribute("aria-hidden", "false");
      document.body.classList.add("focus-timeline-visible");
      this.focusTitle.textContent = region.title || region.label;
      this.focusSummary.textContent = `${stats.mediaCount} 个素材节点 · ${region.start.slice(5, 16).replace("T", " ")} — ${region.end.slice(11, 16)}`;
      this.focusTags.replaceChildren();
      const laneEnds = [-Infinity, -Infinity, -Infinity];
      stats.events.forEach((event) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "story-focus-tag";
        button.classList.toggle("region", event.presentation === "title");
        button.classList.toggle("major", ["hero", "sequence", "slideshow"].includes(event.display_type));
        const position = Math.max(0, Math.min(1, (event.timestamp - stats.start) / Math.max(1, stats.end - stats.start)));
        let lane = laneEnds.findIndex((end) => position - end >= 0.11);
        if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
        laneEnds[lane] = position;
        button.style.left = `${position * 100}%`;
        button.style.bottom = `${2 + lane * 17}px`;
        button.title = `${event.title}\n${event.time.replace("T", " ").slice(5, 19)}`;
        const dot = document.createElement("i");
        const label = document.createElement("span");
        label.textContent = event.title;
        button.append(dot, label);
        button.onclick = () => this.options.onSelect(event, event.distance);
        this.focusTags.append(button);
      });
    }

    hideFocus() {
      this.activeRegion = null;
      this.focusRoot.classList.remove("show");
      this.focusRoot.setAttribute("aria-hidden", "true");
      document.body.classList.remove("focus-timeline-visible");
    }

    seekFocus(fraction) {
      if (!this.activeRegion) return;
      const stats = this.regionStats.get(this.activeRegion.id);
      const timestamp = stats.start + (stats.end - stats.start) * fraction;
      this.options.onSeek(this.options.distanceAtTime(new Date(timestamp).toISOString()).d);
    }

    update(distance, time) {
      this.range.value = Math.round((distance / this.options.totalDistance) * 100000);
      this.root.style.setProperty("--story-progress", `${(distance / this.options.totalDistance) * 100}%`);
      if (time) this.current.textContent = time.replace("T", " ").slice(5, 16);
      const currentRegion = time ? this.regionAt(time) : null;
      if (currentRegion && currentRegion.id !== this.activeRegion?.id) this.showFocus(currentRegion);
      else if (!currentRegion && this.activeRegion) this.hideFocus();
      if (currentRegion) {
        const stats = this.regionStats.get(currentRegion.id);
        const timestamp = Date.parse(time);
        const progress = Math.max(0, Math.min(1, (timestamp - stats.start) / Math.max(1, stats.end - stats.start)));
        this.focusRange.value = Math.round(progress * 100000);
        this.focusRoot.style.setProperty("--focus-progress", `${progress * 100}%`);
        this.focusCurrent.textContent = time.replace("T", " ").slice(5, 19);
      }
    }
  }

  app.StoryTimeline = StoryTimeline;
})(window.RouteDemo || (window.RouteDemo = {}));
