"use strict";

// Runtime event registry. `base` is generated project data; `active` is a
// disposable view that may include browser-authored overrides and fired state.
(function (app) {
  class TimelineRuntime {
    constructor(directiveEngine) {
      this.directives = directiveEngine;
      this.base = { title: [], media: [] };
      this.active = { title: [], media: [] };
    }

    initialize(items = {}) {
      this.base.title = this.directives.compile(items.title || [], "title");
      this.base.media = this.directives.compile(items.media || [], "media");
      this.resetActive();
    }

    resetActive(distance = -Infinity) {
      for (const kind of ["title", "media"]) {
        this.active[kind] = this.base[kind].map((event) => ({
          ...event,
          fired: event.d <= distance,
        }));
      }
    }

    applyManual(entries, distance) {
      // Rebuild active arrays instead of mutating base events, so deleting a
      // manual override reliably restores the generated project event.
      const replacedEventIds = new Set(
        (entries || [])
          .map((entry) => entry.point?.overrides_event_id)
          .filter(Boolean),
      );
      for (const kind of ["title", "media"]) {
        this.active[kind] = this.base[kind]
          .filter((event) => !replacedEventIds.has(event.id))
          .map((event) => ({ ...event, fired: event.d <= distance + 1e-6 }));
      }
      for (const entry of entries || []) {
        const kind = entry.event.presentation === "title" ? "title" : "media";
        const compiled = this.directives.compile([entry.event], kind)[0];
        compiled.fired = compiled.d <= distance + 1e-6;
        this.active[kind].push(compiled);
      }
      this.active.title.sort((a, b) => a.d - b.d);
      this.active.media.sort((a, b) => a.d - b.d);
      return replacedEventIds;
    }

    crossed(kind, from, to) {
      return this.directives.crossed(this.active[kind] || [], from, to);
    }

    reset(distance = -Infinity) {
      this.directives.reset(this.active.title, distance);
      this.directives.reset(this.active.media, distance);
    }

    nearest(kind, distance, maxDistance = Infinity) {
      return this.directives.nearest(
        this.active[kind] || [],
        distance,
        maxDistance,
      );
    }
  }

  app.TimelineRuntime = TimelineRuntime;
})(window.RouteDemo || (window.RouteDemo = {}));
