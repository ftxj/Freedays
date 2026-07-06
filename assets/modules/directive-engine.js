"use strict";

// Compiles editorial triggers into the route-distance coordinate used by the
// playback loop. Renderers consume compiled events and never search GPS data.
(function (app) {
  class DirectiveEngine {
    constructor(routeModel) {
      this.route = routeModel;
    }

    compile(items, kind) {
      return (items || []).map((item) => {
        // Coordinate triggers snap once during compilation. This is both more
        // deterministic and cheaper than searching the route every frame.
        if (item.lonlat) {
          const k = this.route.nearestIndexToCoordinate(item.lonlat);
          return {
            ...item,
            directiveKind: kind,
            triggerKind: "coordinate",
            d: this.route.cumulative[k],
            k,
            fired: false,
          };
        }
        if (kind === "title" || item.snap_to_sample === true) {
          const k = this.route.nearestIndexToTime(item.time || item.start);
          return {
            ...item,
            directiveKind: kind,
            triggerKind: "time",
            d: this.route.cumulative[k],
            k,
            fired: false,
          };
        }
        const resolved = this.route.distanceAtTime(item.time || item.start);
        return {
          ...item,
          directiveKind: kind,
          triggerKind: "time",
          d: resolved.d,
          k: resolved.k,
          fired: false,
        };
      });
    }

    crossed(events, from, to) {
      // `fired` is runtime state: seeking calls reset() to rebuild it from the
      // destination distance and prevent duplicate or skipped presentations.
      return events.filter((event) => {
        if (event.fired || event.d <= from + 1e-6 || event.d > to) return false;
        event.fired = true;
        return true;
      });
    }

    reset(events, distance = -Infinity) {
      events.forEach((event) => {
        event.fired = event.d <= distance;
      });
    }

    nearest(events, distance, maxDistance = Infinity) {
      let picked = null;
      let best = Infinity;
      for (const event of events) {
        const delta = Math.abs(event.d - distance);
        if (delta < best) {
          best = delta;
          picked = event;
        }
      }
      return best <= maxDistance ? picked : null;
    }
  }

  app.DirectiveEngine = DirectiveEngine;
})(window.RouteDemo || (window.RouteDemo = {}));
