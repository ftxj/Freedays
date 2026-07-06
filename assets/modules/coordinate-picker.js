"use strict";

// Small authoring UI for turning a visual map click into a reproducible
// [longitude, latitude] editorial anchor.
(function (app) {
  class CoordinatePicker {
    constructor(map) {
      this.map = map;
      this.enabled = false;
      this.marker = null;
      this.value = "";
      this.lonlat = null;
      this.listeners = [];
      this.button = document.getElementById("btn-coordinate-picker");
      this.row = document.getElementById("coordinate-row");
      this.output = document.getElementById("picked-coordinate");
      this.copyButton = document.getElementById("btn-copy-coordinate");
      this.bindEvents();
    }

    bindEvents() {
      this.button.onclick = () => this.setEnabled(!this.enabled);
      this.copyButton.onclick = () => this.copy();
      this.output.onclick = () => this.copy();
      this.map.on("click", (event) => {
        if (!this.enabled) return;
        this.pick(event.lngLat.lng, event.lngLat.lat);
      });
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      this.button.textContent = enabled ? "📍 选点:开" : "📍 选点:关";
      this.button.classList.toggle("active", enabled);
      this.map.getCanvas().style.cursor = enabled ? "crosshair" : "";
      if (enabled) this.row.hidden = false;
    }

    pick(lng, lat) {
      const lonlat = [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
      this.lonlat = lonlat;
      this.value = `[${lonlat[0].toFixed(6)}, ${lonlat[1].toFixed(6)}]`;
      this.output.textContent = this.value;
      this.row.hidden = false;

      if (!this.marker) {
        const element = document.createElement("div");
        element.className = "coordinate-pick-marker";
        this.marker = new maplibregl.Marker({ element, anchor: "center" })
          .setLngLat(lonlat)
          .addTo(this.map);
      } else {
        this.marker.setLngLat(lonlat);
      }
      this.listeners.forEach((listener) => listener(lonlat));
    }

    onPick(listener) {
      if (typeof listener === "function") this.listeners.push(listener);
    }

    async copy() {
      if (!this.value) return;
      let copied = false;
      try {
        await navigator.clipboard.writeText(this.value);
        copied = true;
      } catch (_error) {
        const input = document.createElement("textarea");
        input.value = this.value;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        copied = document.execCommand("copy");
        input.remove();
      }
      if (!copied) return;
      const original = this.copyButton.textContent;
      this.copyButton.textContent = "已复制";
      setTimeout(() => {
        this.copyButton.textContent = original;
      }, 1200);
    }
  }

  app.CoordinatePicker = CoordinatePicker;
})(window.RouteDemo || (window.RouteDemo = {}));
