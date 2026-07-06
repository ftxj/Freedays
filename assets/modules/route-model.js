"use strict";

// Pure route-domain helpers. This module knows coordinates, distance, time and
// movement segments, but deliberately has no MapLibre or DOM dependencies.
(function (app) {
  const EARTH_RADIUS_M = 6371000;

  function haversine(a, b) {
    const q = Math.PI / 180;
    return (
      EARTH_RADIUS_M *
      2 *
      Math.asin(
        Math.sqrt(
          Math.sin(((b[1] - a[1]) * q) / 2) ** 2 +
            Math.cos(a[1] * q) *
              Math.cos(b[1] * q) *
              Math.sin(((b[0] - a[0]) * q) / 2) ** 2,
        ),
      )
    );
  }

  function timeValue(value) {
    if (!value) return 0;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const match = value.match(/(\d+)-(\d+) (\d+):(\d+)/);
    return match
      ? Date.UTC(2024, +match[1] - 1, +match[2], +match[3] - 8, +match[4])
      : 0;
  }

  function dayKey(value) {
    return value.includes("T") ? value.slice(5, 10) : value.slice(0, 5);
  }

  function geoBearing(a, b) {
    const p = Math.PI / 180;
    const y = Math.sin((b[0] - a[0]) * p) * Math.cos(b[1] * p);
    const x =
      Math.cos(a[1] * p) * Math.sin(b[1] * p) -
      Math.sin(a[1] * p) *
        Math.cos(b[1] * p) *
        Math.cos((b[0] - a[0]) * p);
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  /** Precomputes the indexes needed by playback, seeking and camera policies. */
  class RouteModel {
    constructor(data) {
      this.track = data.track;
      this.times = data.times;
      this.alts = data.alts;
      this.breaks = data.breaks || [];
      this.segments = data.segments || [];
      this.length = this.track.length;
      this.timeNumbers = this.times.map(timeValue);
      this.cumulative = [0];
      for (let k = 1; k < this.length; k++) {
        this.cumulative[k] =
          this.cumulative[k - 1] +
          (this.breaks[k] ? 0 : haversine(this.track[k - 1], this.track[k]));
      }
      this.totalDistance = this.cumulative[this.length - 1];
    }

    locate(distance) {
      // Binary search keeps per-frame distance lookup logarithmic even though
      // the rendered route contains tens of thousands of interpolated points.
      const dv = Math.max(0, Math.min(this.totalDistance, distance));
      let lo = 0;
      let hi = this.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.cumulative[mid] <= dv) lo = mid;
        else hi = mid - 1;
      }
      const k = Math.min(lo, this.length - 2);
      const segmentDistance = this.cumulative[k + 1] - this.cumulative[k] || 1;
      const fraction = (dv - this.cumulative[k]) / segmentDistance;
      const a = this.track[k];
      const b = this.track[k + 1];
      return {
        pos: [
          a[0] + (b[0] - a[0]) * fraction,
          a[1] + (b[1] - a[1]) * fraction,
        ],
        k,
        fr: fraction,
      };
    }

    movementSegment(k) {
      return this.segments.find(
        (segment) => segment.startIndex <= k && segment.endIndex >= k,
      );
    }

    speedKmh(k) {
      const segment = this.movementSegment(k);
      if (!segment) return 0;
      const a = Math.max(segment.startIndex, k - 12);
      const b = Math.min(segment.endIndex, k + 12);
      const hours = (this.timeNumbers[b] - this.timeNumbers[a]) / 3600000;
      if (hours <= 0) return 0;
      const kmh = (this.cumulative[b] - this.cumulative[a]) / 1000 / hours;
      return Math.max(0, Math.min(160, Math.round(kmh)));
    }

    roadTurn(k, lookAroundMeters = 280) {
      // Compare bearings on both sides of the sample instead of adjacent
      // points; tiny GPS noise would otherwise look like a sharp road corner.
      const segment = this.movementSegment(k);
      if (!segment) return 0;
      const center = this.cumulative[k];
      const before = this.locate(
        Math.max(this.cumulative[Math.max(0, segment.startIndex)], center - lookAroundMeters),
      ).pos;
      const here = this.track[k];
      const after = this.locate(
        Math.min(
          this.cumulative[Math.min(this.length - 1, segment.endIndex)],
          center + lookAroundMeters,
        ),
      ).pos;
      const b1 = geoBearing(before, here);
      const b2 = geoBearing(here, after);
      return Math.abs(((b2 - b1 + 540) % 360) - 180);
    }

    nearestIndexToCoordinate(lonlat) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let k = 0; k < this.length; k++) {
        const dx = this.track[k][0] - lonlat[0];
        const dy = this.track[k][1] - lonlat[1];
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = k;
        }
      }
      return bestIndex;
    }

    nearestIndexToTime(value) {
      const target = timeValue(value);
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let k = 0; k < this.length; k++) {
        const distance = Math.abs(this.timeNumbers[k] - target);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = k;
        }
      }
      return bestIndex;
    }

    distanceAtTime(value) {
      // Real trip time and animation distance are separate axes. Interpolate
      // between timestamped samples so debug seeks preserve the real clock.
      const target = timeValue(value);
      let k = 0;
      while (k + 1 < this.length && this.timeNumbers[k + 1] < target) k++;
      const next = Math.min(this.length - 1, k + 1);
      const span = Math.max(1, this.timeNumbers[next] - this.timeNumbers[k]);
      const fraction = Math.max(
        0,
        Math.min(1, (target - this.timeNumbers[k]) / span),
      );
      return {
        d:
          this.cumulative[k] +
          (this.cumulative[next] - this.cumulative[k]) * fraction,
        k,
      };
    }

    boundsForTimeRange(start, end) {
      const from = timeValue(start);
      const to = timeValue(end);
      return this.times.reduce(
        (bounds, _time, k) => {
          const value = this.timeNumbers[k];
          if (value < from || value > to) return bounds;
          const point = this.track[k];
          bounds[0][0] = Math.min(bounds[0][0], point[0]);
          bounds[0][1] = Math.min(bounds[0][1], point[1]);
          bounds[1][0] = Math.max(bounds[1][0], point[0]);
          bounds[1][1] = Math.max(bounds[1][1], point[1]);
          return bounds;
        },
        [
          [999, 999],
          [-999, -999],
        ],
      );
    }
  }

  app.haversine = haversine;
  app.timeValue = timeValue;
  app.dayKey = dayKey;
  app.geoBearing = geoBearing;
  app.RouteModel = RouteModel;
})(window.RouteDemo || (window.RouteDemo = {}));
