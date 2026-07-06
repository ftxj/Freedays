// Central tuning for playback, cameras, and basemap themes.
// Event timing and route corrections belong in route_data/route-overrides.json.
window.MAP_ANIMATION_CONFIG = {
  playback: {
    timelineFrames: 5400,
    carScreenSpeed: {
      referenceZoom: 9.2,
      factorAtReference: 1,
      minFactor: 0.025,
      maxFactor: 1,
    },
    speed: {
      walk: 0.03,
      cityWalk: 0.009,
      detailTransition: 0.015,
    },
    minimumFrames: {
      detail: 240,
      cityDetail: 360,
      walk: 480,
      cityWalk: 900,
    },
  },
  camera: {
    zoom: {
      walk: 15.0,
      cityWalk: 16.4,
      detail: 12.8,
      city: 14.2,
      mountain: 14.6,
    },
    transitionMs: {
      normal: 1400,
      detail: 4000,
      fast: 4500,
    },
  },
  overlays: {
    sleepPauseMs: 2800,
  },
  mapStyles: {
    sat: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      bg: "#0b1a2b",
      trav: "#ff2d20",
      full: "#9ca3af",
    },
    relief: {
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}",
      ],
      bg: "#e9e4d8",
      trav: "#d81e06",
      full: "#8b8f94",
    },
    topo: {
      tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
      bg: "#e9e4d8",
      trav: "#c81e10",
      full: "#8b8f94",
    },
    dark: {
      tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
      bg: "#111",
      trav: "#ff2d20",
      full: "#4b5563",
    },
    light: {
      tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
      bg: "#f5f5f2",
      trav: "#e2231a",
      full: "#9ca3af",
    },
    street: {
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      bg: "#e9e4d8",
      trav: "#d81e06",
      full: "#9ca3af",
    },
    paper: {
      tiles: null,
      bg: "#efe6d3",
      trav: "#b3301a",
      full: "#8b8f94",
    },
  },
};
