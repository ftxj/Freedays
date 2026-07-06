"use strict";

// Resolves declarative camera directives into stable views. The animation loop
// supplies the current position; this module decides framing, not playback.
(function (app) {
  class CameraPolicy {
    constructor(routeModel, routeData, config) {
      this.route = routeModel;
      this.directives = routeData.cameraDirectives || [];
      this.ranges = [
        ...this.directives,
        ...(routeData.cameraRanges || []),
      ];
      this.cityWalkRanges = routeData.cityWalkRanges || [];
      this.zoom = config.camera.zoom;
    }

    rangeAt(k) {
      const currentTime = this.route.timeNumbers[k];
      return this.ranges.find(
        (range) =>
          currentTime >= app.timeValue(range.start) &&
          currentTime <= app.timeValue(range.end),
      );
    }

    fixedRangeAt(k) {
      const range = this.rangeAt(k);
      return range &&
        (range.preset === "fixed_bounds" || range.mode === "fixed_region")
        ? range
        : null;
    }

    directiveAt(k) {
      const currentTime = this.route.timeNumbers[k];
      return this.directives.find(
        (directive) =>
          currentTime >= app.timeValue(directive.start) &&
          currentTime <= app.timeValue(directive.end),
      );
    }

    boundsFor(range) {
      return this.route.boundsForTimeRange(range.start, range.end);
    }

    isCompactSegment(k) {
      const segment = this.route.movementSegment(k);
      return (
        !!segment &&
        this.route.cumulative[Math.min(this.route.length - 1, segment.endIndex)] -
          this.route.cumulative[Math.max(0, segment.startIndex)] <=
          20000
      );
    }

    isCityWalk(k) {
      const currentTime = this.route.timeNumbers[k];
      return this.cityWalkRanges.some(
        (range) =>
          currentTime >= app.timeValue(range.start) &&
          currentTime <= app.timeValue(range.end),
      );
    }

    walkZoom(k) {
      return this.isCityWalk(k) ? this.zoom.cityWalk : this.zoom.walk;
    }

    detailZoom(k, turnOverride = null) {
      const segment = this.route.movementSegment(k);
      if (!segment) return this.zoom.detail;
      const segmentDistance =
        this.route.cumulative[Math.min(this.route.length - 1, segment.endIndex)] -
        this.route.cumulative[Math.max(0, segment.startIndex)];
      const turn =
        turnOverride === null ? this.route.roadTurn(k) : turnOverride;
      const base = segmentDistance <= 20000 ? this.zoom.city : this.zoom.detail;
      const curveZoom =
        this.zoom.detail +
        Math.min(1, turn / 90) * (this.zoom.mountain - this.zoom.detail);
      return Math.max(base, curveZoom);
    }

    orientationFor(rule, currentPosition) {
      // North-up remains the default. `look_at` is an explicit narrative
      // exception and never follows vehicle heading implicitly.
      if (!rule) return { bearing: 0, pitch: null };
      let bearing = Number.isFinite(rule.bearing) ? rule.bearing : 0;
      if (Array.isArray(rule.look_at)) {
        bearing = app.geoBearing(currentPosition, rule.look_at);
      }
      return {
        bearing,
        pitch: Number.isFinite(rule.pitch) ? rule.pitch : null,
      };
    }

    viewFor(rule, currentPosition, defaults) {
      if (!rule) return defaults;
      const orientation = this.orientationFor(rule, currentPosition);
      return {
        zoom: Number.isFinite(rule.zoom) ? rule.zoom : defaults.zoom,
        pitch:
          orientation.pitch === null ? defaults.pitch : orientation.pitch,
        bearing: orientation.bearing,
        followFactor: Number.isFinite(rule.follow_factor)
          ? rule.follow_factor
          : defaults.followFactor,
      };
    }
  }

  app.CameraPolicy = CameraPolicy;
})(window.RouteDemo || (window.RouteDemo = {}));
