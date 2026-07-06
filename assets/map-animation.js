"use strict";

// Runtime data is split between generated route geometry and hand-maintained map content.
if (!window.ROUTE_DATA || !Array.isArray(window.ROUTE_DATA.points)) {
  throw new Error("route_data/processed/route-data.js is missing or invalid");
}

const ROUTE = window.ROUTE_DATA;
const CONTENT = window.MAP_CONTENT || {};
const LOCATION_STORIES = window.LOCATION_STORY_DATA || {};
const GENERATED_REPLACED_EVENT_IDS = new Set(LOCATION_STORIES.replaced_event_ids || []);
const CONFIG = window.MAP_ANIMATION_CONFIG;
if (!CONFIG) {
  throw new Error("assets/map-config.js is missing or invalid");
}

const excludedMediaStems = new Set(
  (window.MEDIA_BACKPACK_DATA?.editorial_exclusions || []).map((assetPath) =>
    assetPath.replace(/\.[^.]+$/, "").toLocaleLowerCase(),
  ),
);

function isEditoriallyExcludedMedia(assetPath) {
  if (!assetPath) return false;
  const stem = assetPath
    .replace(/\.(mp4|mov|jpe?g|png|webp|heic|heif)$/i, "")
    .replace(/_(web|poster)$/i, "")
    .toLocaleLowerCase();
  return excludedMediaStems.has(stem);
}

function withoutExcludedMedia(event) {
  const result = { ...event };
  if (Array.isArray(event.clips)) {
    result.clips = event.clips.filter(
      (clip) =>
        !isEditoriallyExcludedMedia(clip.video) &&
        !isEditoriallyExcludedMedia(clip.image),
    );
  }
  if (isEditoriallyExcludedMedia(event.video)) {
    delete result.video;
    delete result.poster;
    delete result.video_label;
    delete result.video_title;
  }
  if (isEditoriallyExcludedMedia(event.image)) {
    delete result.image;
    delete result.image_alt;
    delete result.image_label;
    delete result.image_title;
  }
  return result;
}

const DATA = {
  track: ROUTE.points.map((point) => [point.lon, point.lat]),
  times: ROUTE.points.map((point) => point.time),
  alts: ROUTE.points.map((point) => point.alt),
  modes: ROUTE.points.map((point) => point.mode || "drive_fast"),
  breaks: ROUTE.points.map((point) => Boolean(point.breakBefore)),
  segments: ROUTE.segments || [],
  events: ROUTE.events || [],
  cameraRanges: ROUTE.camera_ranges || [],
  titleCards: ROUTE.title_cards || [],
  cityWalkRanges: ROUTE.city_walk_ranges || [],
  supplyEvents: (ROUTE.supply_events || []).map(withoutExcludedMedia),
  mediaEvents: (ROUTE.media_events || [])
    .filter((event) => !GENERATED_REPLACED_EVENT_IDS.has(event.id))
    .map(withoutExcludedMedia),
  storyEvents: [
    ...(ROUTE.story_events || []).filter((event) => !GENERATED_REPLACED_EVENT_IDS.has(event.id)),
    ...(LOCATION_STORIES.events || []),
  ].map(withoutExcludedMedia),
  cameraDirectives: [
    ...(LOCATION_STORIES.camera_directives || []),
    ...(ROUTE.camera_directives || []),
  ],
  tunnelRanges: ROUTE.tunnel_ranges || [],
  previewRegions: [
    ...(ROUTE.preview_regions || []),
    ...(LOCATION_STORIES.regions || []).filter((region) => region.start),
  ].filter(
    (region, index, regions) =>
      regions.findIndex((candidate) => candidate.id === region.id) === index,
  ),
  routeConnections: ROUTE.route_connections || [],
  stops: CONTENT.stops || [],
  peaks: CONTENT.peaks || [],
  stays: CONTENT.stays || [],
};

const APP = window.RouteDemo;
if (
  !APP?.RouteModel ||
  !APP?.DirectiveEngine ||
  !APP?.PlaybackEngine ||
  !APP?.TimelineRuntime ||
  !APP?.PlaybackControls ||
  !APP?.CameraPolicy ||
  !APP?.CoordinatePicker ||
  !APP?.MaterialBackpack ||
  !APP?.ManualStoryEditor ||
  !APP?.StoryTimeline
) {
  throw new Error("RouteDemo architecture modules are missing");
}
const routeModel = new APP.RouteModel(DATA),
  directiveEngine = new APP.DirectiveEngine(routeModel),
  timelineRuntime = new APP.TimelineRuntime(directiveEngine),
  cameraPolicy = new APP.CameraPolicy(routeModel, DATA, CONFIG),
  track = routeModel.track,
  N = routeModel.length,
  cum = routeModel.cumulative,
  total = routeModel.totalDistance,
  tnum = routeModel.timeNumbers,
  timeValue = APP.timeValue,
  dayKey = APP.dayKey;
const baseCameraDirectives = [...cameraPolicy.directives];
// Local aliases keep the animation code readable while tuning stays centralized.
const WALK_SPEED_FACTOR = CONFIG.playback.speed.walk,
  CITY_WALK_SPEED_FACTOR = CONFIG.playback.speed.cityWalk,
  DETAIL_TRANSITION_SPEED_FACTOR = CONFIG.playback.speed.detailTransition;
const WALK_ZOOM = CONFIG.camera.zoom.walk,
  CITY_WALK_ZOOM = CONFIG.camera.zoom.cityWalk,
  DETAIL_ZOOM = CONFIG.camera.zoom.detail,
  CITY_ZOOM = CONFIG.camera.zoom.city,
  MOUNTAIN_ZOOM = CONFIG.camera.zoom.mountain,
  CAMERA_TRANSITION_MS = CONFIG.camera.transitionMs.normal,
  DETAIL_TRANSITION_MS = CONFIG.camera.transitionMs.detail,
  FAST_TRANSITION_MS = CONFIG.camera.transitionMs.fast,
  SLEEP_PAUSE_MS = CONFIG.overlays.sleepPauseMs;
const tunnelRanges = DATA.tunnelRanges.map((range) => {
  const startMs = timeValue(range.start),
    endMs = timeValue(range.end);
  return {
    ...range,
    startMs,
    endMs,
    startK: routeModel.nearestIndexToTime(range.start),
    endK: routeModel.nearestIndexToTime(range.end),
  };
});
function carPlaybackFactor() {
  const tuning = CONFIG.playback.carScreenSpeed,
    factor =
      tuning.factorAtReference *
      2 ** (tuning.referenceZoom - map.getZoom());
  return Math.max(tuning.minFactor, Math.min(tuning.maxFactor, factor));
}
function movingMode(k) {
  k = Math.max(0, Math.min(N - 2, k));
  const m = DATA.modes && DATA.modes[k];
  if (m === "walk" || m === "drive_slow" || m === "drive_fast") return m;
  if (m === "detail") return "drive_slow";
  return m === "car" ? "drive_fast" : "drive_fast";
}
const WALK_ICON =
  '<div class="people" aria-label="三人步行"><div class="emoji-back">🚶‍♀️🚶‍♂️</div><div class="emoji-front">🚶‍♂️</div></div>';
function preloadWalkTiles() {
  const seen = new Set();
  for (const s of DATA.segments || []) {
    if (s.mode !== "walk" && s.mode !== "drive_slow") continue;
    const k = Math.round((s.startIndex + s.endIndex) / 2),
      key = Math.round(track[k][0] * 100) + "/" + Math.round(track[k][1] * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    map.easeTo({
      center: track[k],
      zoom: s.mode === "walk" ? walkZoomFor(k) : DETAIL_ZOOM,
      pitch: pitch,
      bearing: 0,
      duration: 0,
      preloadOnly: true,
    });
  }
}
function fmtNum(v) {
  const d = new Date(v),
    p = (x) => String(x).padStart(2, "0");
  return (
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    " " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes())
  );
}
const DAYS = [...new Set(DATA.times.map(dayKey))];
const PAL = [
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#00c7be",
  "#30b0ff",
  "#5e5ce6",
  "#bf5af2",
  "#ff2d95",
  "#a2845e",
];
const dayColor = {};
DAYS.forEach((d, k) => (dayColor[d] = PAL[k % PAL.length]));
const matchExpr = ["match", ["get", "day"]];
DAYS.forEach((d) => matchExpr.push(d, dayColor[d]));
matchExpr.push("#ffffff");
const dayBounds = {};
DATA.times.forEach((t, k) => {
  const d = dayKey(t);
  const b = dayBounds[d] || [
    [999, 999],
    [-999, -999],
  ];
  const c = track[k];
  b[0][0] = Math.min(b[0][0], c[0]);
  b[0][1] = Math.min(b[0][1], c[1]);
  b[1][0] = Math.max(b[1][0], c[0]);
  b[1][1] = Math.max(b[1][1], c[1]);
  dayBounds[d] = b;
});
// Basemap themes are configured in assets/map-config.js.
const STYLES = CONFIG.mapStyles;
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      sat: {
        type: "raster",
        tiles: STYLES.sat.tiles,
        tileSize: 256,
        attribution: "Esri / OSM / Carto",
      },
    },
    layers: [
      {
        id: "bg",
        type: "background",
        paint: { "background-color": STYLES.sat.bg },
      },
      { id: "sat", type: "raster", source: "sat" },
    ],
  },
  center: track[0],
  zoom: 8,
  pitch: 0,
  bearing: 0,
  maxPitch: 80,
  dragRotate: false,
  attributionControl: false,
});
map.touchZoomRotate.disableRotation();
const coordinatePicker = new APP.CoordinatePicker(map);
const playback = new APP.PlaybackEngine({
  totalDistance: total,
  initialRate: 0.2,
});
let pauseSec = 1,
  mode = "auto",
  pitch = 0,
  zoom = 9.2,
  curDay = null,
  curMoveMode = "sleep",
  cameraTransitionUntil = 0,
  detailTransitionUntil = 0,
  currentDetailZoom = DETAIL_ZOOM,
  detailCameraCenter = null,
  smoothedRoadTurn = 0,
  activeFixedCamera = null,
  fastTransitionStart = 0,
  fastTransitionFromKmh = 0,
  displayKmh = 0,
  locationTimer = 0,
  locationTimerDeadline = 0,
  locationTimerRemaining = 0,
  locationTimerCallback = null,
  locationPresentationPaused = false,
  backpackLocationTimer = 0,
  mediaOverlay,
  materialBackpack,
  manualStoryEditor,
  storyTimeline,
  car,
  carEl,
  showPeak = true,
  byday = false,
  labels = [],
  stopMarks = [],
  stayMarks = [],
  sleepEvents = [],
  lastTrailUpdate = 0;
const stepBase = total / CONFIG.playback.timelineFrames;
const SEEK_STEPS = 100000;
const MIN_DETAIL_FRAMES = CONFIG.playback.minimumFrames.detail,
  MIN_CITY_DETAIL_FRAMES = CONFIG.playback.minimumFrames.cityDetail,
  MIN_WALK_FRAMES = CONFIG.playback.minimumFrames.walk,
  MIN_CITY_WALK_FRAMES = CONFIG.playback.minimumFrames.cityWalk;
mediaOverlay = new APP.MediaOverlay({
  isPlaying: () => playback.isPlaying(),
  pausePlayback: () => {
    playback.pause("media");
  },
  resumePlayback: () => {
    if (playback.resume("media")) requestAnimationFrame(step);
  },
  setPlaybackFactor: (factor) => {
    playback.setFactor("media", factor);
  },
});
materialBackpack = new APP.MaterialBackpack({
  data: window.MEDIA_BACKPACK_DATA,
  map,
  onLocateCluster: locateBackpackCluster,
});
storyTimeline = new APP.StoryTimeline({
  totalDistance: total,
  regions: LOCATION_STORIES.regions || [],
  distanceAtTime: (time) => routeModel.distanceAtTime(time),
  onSeek: (distance) => {
    seekToDistance(distance, { previewMedia: false });
  },
  onSelect: (event, distance) => {
    seekToDistance(distance, { previewMedia: false });
    const context = { ...event, k: routeModel.distanceAtTime(event.time).k };
    if (event.presentation === "title") showLocationCard(context);
    else mediaOverlay.show(context);
  },
});
storyTimeline.setEvents(DATA.storyEvents);
function syncManualStoryEntries(entries) {
  const replacedEventIds = timelineRuntime.applyManual(
    entries,
    playback.distance,
  );
  const manualCameras = entries.map((entry) => entry.camera);
  cameraPolicy.directives = manualCameras.concat(baseCameraDirectives);
  cameraPolicy.ranges = [
    ...cameraPolicy.directives,
    ...(DATA.cameraRanges || []),
  ];
  storyTimeline.setEvents([
    ...DATA.storyEvents.filter((event) => !replacedEventIds.has(event.id)),
    ...entries.map((entry) => entry.event),
  ]);
}
function previewManualStoryEntry(entry) {
  const context = {
    ...entry.event,
    k: routeModel.nearestIndexToCoordinate(entry.point.lonlat),
  };
  map.easeTo({
    center: entry.camera.center,
    zoom: entry.camera.zoom,
    pitch: entry.camera.pitch,
    bearing: entry.camera.bearing,
    duration: 700,
  });
  if (context.presentation === "title") showLocationCard(context);
  else mediaOverlay.show(context);
}
const editableAnimationEntries = [
  ...DATA.titleCards.map((event) => ({ ...event, presentation: "title" })),
  ...DATA.supplyEvents.map((event) => ({ ...event, presentation: "media" })),
  ...DATA.mediaEvents.map((event) => ({ ...event, presentation: "media" })),
  ...DATA.storyEvents,
].filter((event, index, events) => event.id && events.findIndex((candidate) => candidate.id === event.id) === index)
  .map((sourceEvent) => {
    const event = { ...sourceEvent };
    let k;
    if (event.time) k = routeModel.distanceAtTime(event.time).k;
    else if (Array.isArray(event.lonlat)) k = routeModel.nearestIndexToCoordinate(event.lonlat);
    else return null;
    event.time = event.time || DATA.times[k];
    event.lonlat = event.lonlat || DATA.track[k];
    const timestamp = timeValue(event.time);
    const camera = DATA.cameraDirectives.find((directive) =>
      (event.region_id && directive.region_id === event.region_id) ||
      (timestamp >= timeValue(directive.start) && timestamp <= timeValue(directive.end)),
    );
    return { event, camera: camera || null };
  })
  .filter(Boolean)
  .sort((a, b) => timeValue(a.event.time) - timeValue(b.event.time));

manualStoryEditor = new APP.ManualStoryEditor({
  map,
  coordinatePicker,
  existingEntries: editableAnimationEntries,
  getBearing: (from, to) => APP.geoBearing(from, to),
  openAssetSelector: (selectedPaths, onConfirm) => materialBackpack.openSelection({ selectedPaths, onConfirm }),
  getMapView: () => ({
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    center: [map.getCenter().lng, map.getCenter().lat],
  }),
  getCurrentContext: () => {
    const current = locate(playback.distance);
    const next = Math.min(N - 1, current.k + 1);
    const timestamp = tnum[current.k] + (tnum[next] - tnum[current.k]) * current.fr;
    const chinaIso = new Date(timestamp + 8 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+08:00");
    const a0 = DATA.alts[current.k], a1 = DATA.alts[next];
    return {
      lonlat: current.pos,
      k: current.k,
      time: chinaIso,
      altitude: a0 != null && a1 != null ? a0 + (a1 - a0) * current.fr : a0 ?? a1,
    };
  },
  getRouteContext: (lonlat) => {
    const k = routeModel.nearestIndexToCoordinate(lonlat);
    return { k, time: DATA.times[k], altitude: DATA.alts[k] };
  },
  getRouteContextForTime: (time) => {
    const target = routeModel.distanceAtTime(time);
    return { k: target.k, time, lonlat: locate(target.d).pos, altitude: DATA.alts[target.k] };
  },
  onChange: syncManualStoryEntries,
  onPreview: previewManualStoryEntry,
});
// Authoring helper: ?media=<event-id> opens one card without seeking the route.
const previewMediaId = new URLSearchParams(window.location.search).get("media");
if (previewMediaId) {
  const previewEvent = [...(DATA.supplyEvents || []), ...(DATA.mediaEvents || [])].find(
    (event) => event.id === previewMediaId,
  );
  if (previewEvent) setTimeout(() => mediaOverlay.show(previewEvent), 250);
}
const OFF = [
  [10, -2],
  [14, -13],
  [0, -15],
  [-14, -13],
  [-14, -2],
  [0, 14],
  [15, 13],
  [-15, 13],
  [26, -20],
  [26, 2],
  [0, -28],
  [-26, -20],
  [-26, 2],
  [26, 22],
  [-26, 22],
  [0, 28],
  [42, 0],
  [0, -42],
  [-42, 0],
  [0, 42],
];
function fc(c) {
  return { type: "Feature", geometry: { type: "LineString", coordinates: c } };
}
function routeConnectionsFc() {
  return {
    type: "FeatureCollection",
    features: DATA.routeConnections.map((connection) => ({
      type: "Feature",
      properties: { id: connection.id, style: connection.style || "connection" },
      geometry: { type: "LineString", coordinates: connection.coordinates },
    })),
  };
}
function traveledRouteConnectionsFc(currentTime) {
  const now = currentTime ? new Date(currentTime).getTime() : -Infinity;
  return {
    type: "FeatureCollection",
    features: DATA.routeConnections
      .filter(
        (connection) =>
          connection.reveal_at && new Date(connection.reveal_at).getTime() <= now,
      )
      .map((connection) => ({
        type: "Feature",
        properties: { id: connection.id },
        geometry: { type: "LineString", coordinates: connection.coordinates },
      })),
  };
}
function routeFc(endK = N - 1, pos = null) {
  const lines = [[]];
  for (let k = 0; k <= Math.min(endK, N - 1); k++) {
    if (
      k > 0 &&
      DATA.breaks &&
      DATA.breaks[k] &&
      lines[lines.length - 1].length
    )
      lines.push([]);
    lines[lines.length - 1].push(track[k]);
  }
  if (pos) lines[lines.length - 1].push(pos);
  const usable = lines.filter((x) => x.length > 1);
  return {
    type: "Feature",
    geometry:
      usable.length <= 1
        ? { type: "LineString", coordinates: usable[0] || [track[0], track[0]] }
        : { type: "MultiLineString", coordinates: usable },
  };
}
function tunnelRouteFc() {
  return {
    type: "FeatureCollection",
    features: tunnelRanges
      .map((range) => {
        const startK = Math.min(range.startK, range.endK),
          endK = Math.max(range.startK, range.endK),
          coordinates = track.slice(startK, endK + 1);
        if (coordinates.length < 2) return null;
        return {
          type: "Feature",
          properties: { id: range.id || "", name: range.name || "隧道" },
          geometry: { type: "LineString", coordinates },
        };
      })
      .filter(Boolean),
  };
}
function ov(a, b) {
  return (
    a[0] < b[0] + b[2] &&
    a[0] + a[2] > b[0] &&
    a[1] < b[1] + b[3] &&
    a[1] + a[3] > b[1]
  );
}
function locate(dv) {
  return routeModel.locate(dv);
}
function movementSegment(k) {
  return routeModel.movementSegment(k);
}
function fixedCameraFor(k) {
  return cameraPolicy.fixedRangeAt(k);
}
function fitFixedCamera(r, duration = 1800, currentPosition = null) {
  if (Array.isArray(r.center)) {
    const targetCenter = r.follow_center && currentPosition ? currentPosition : r.center;
    const orientation = cameraPolicy.orientationFor(r, targetCenter);
    map.easeTo({
      center: targetCenter,
      zoom: r.zoom || r.max_zoom || 14.2,
      pitch: orientation.pitch === null ? pitch : orientation.pitch,
      bearing: orientation.bearing,
      duration,
    });
    return;
  }
  const b = cameraPolicy.boundsFor(r);
  map.fitBounds(b, {
    padding: r.padding || 100,
    duration,
    pitch: pitch,
    bearing: 0,
    maxZoom: r.max_zoom || 14.2,
  });
}
function speedKmhFor(k) {
  return routeModel.speedKmh(k);
}
function smoothStep01(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
function isCompactCitySegment(k) {
  return cameraPolicy.isCompactSegment(k);
}
function isCityWalk(k) {
  return cameraPolicy.isCityWalk(k);
}
function walkZoomFor(k) {
  return cameraPolicy.walkZoom(k);
}
function roadTurnFor(k) {
  return routeModel.roadTurn(k);
}
function detailZoomFor(k, turnOverride = null) {
  return cameraPolicy.detailZoom(k, turnOverride);
}
function fitFastSegment(k, duration = CAMERA_TRANSITION_MS) {
  fitAll(duration);
}
function declutter() {
  const placed = [];
  for (const L of labels) {
    if (L.el.style.display === "none" || L.labelEl.style.display === "none")
      continue;
    const pt = map.project(L.lonlat);
    placed.push([pt.x - 6, pt.y - 13, 12, 15]);
  }
  for (const L of [...labels].sort((a, b) => b.prio - a.prio)) {
    if (L.el.style.display === "none" || L.labelEl.style.display === "none")
      continue;
    const pt = map.project(L.lonlat),
      w = L.labelEl.offsetWidth || 40,
      h = L.labelEl.offsetHeight || 15;
    let pick = OFF[0];
    for (const o of OFF) {
      const box = [pt.x + o[0] - w / 2, pt.y + o[1] - h / 2, w, h];
      if (!placed.some((q) => ov(box, q))) {
        pick = o;
        break;
      }
    }
    L.labelEl.style.transform = `translate(-50%,-50%) translate(${pick[0]}px,${pick[1]}px)`;
    placed.push([pt.x + pick[0] - w / 2, pt.y + pick[1] - h / 2, w, h]);
  }
}
// Map layers, markers, and timeline events.
map.on("load", () => {
  map.addSource("full", { type: "geojson", data: routeFc() });
  map.addSource("route-connections", { type: "geojson", data: routeConnectionsFc() });
  map.addSource("traveled-route-connections", {
    type: "geojson",
    data: traveledRouteConnectionsFc(null),
  });
  map.addSource("trav", { type: "geojson", data: fc([track[0]]) });
  map.addLayer({
    id: "full",
    type: "line",
    source: "full",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": STYLES.sat.full,
      "line-width": 2,
      "line-opacity": 0.22,
    },
  });
  map.addLayer({
    id: "route-connections",
    type: "line",
    source: "route-connections",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": STYLES.sat.full,
      "line-width": 2,
      "line-opacity": 0.22,
    },
  });
  map.addLayer({
    id: "traveled-route-connections",
    type: "line",
    source: "traveled-route-connections",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": STYLES.sat.trav,
      "line-width": 4,
      "line-opacity": 0.95,
      "line-blur": 0.55,
    },
  });
  map.addLayer({
    id: "trav",
    type: "line",
    source: "trav",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": STYLES.sat.trav,
      "line-width": 4,
      "line-opacity": 0.95,
      "line-blur": 0.55,
    },
  });
  map.addSource("tunnel-route", { type: "geojson", data: tunnelRouteFc() });
  map.addLayer({
    id: "tunnel-route",
    type: "line",
    source: "tunnel-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#332b31",
      "line-width": 4.2,
      "line-opacity": 0.92,
      "line-blur": 0.25,
    },
  });
  map.addSource("byday", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "bydayL",
    type: "line",
    source: "byday",
    layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: { "line-color": matchExpr, "line-width": 4.5, "line-opacity": 0.96 },
  });
  stopMarks = (DATA.stops || []).map((s) => {
    const el = document.createElement("div");
    el.className = "mk stop";
    el.innerHTML =
      '<div class="ic">' +
      WALK_ICON +
      '</div><div class="lbl">' +
      s.name +
      "</div>";
    let bi = 0,
      bd = 1e9;
    for (let k = 0; k < N; k++) {
      const dx = track[k][0] - s.lonlat[0],
        dy = track[k][1] - s.lonlat[1],
        dd = dx * dx + dy * dy;
      if (dd < bd) {
        bd = dd;
        bi = k;
      }
    }
    el.onclick = () => {
      el.dataset.hid = "1";
      el.style.display = "none";
      declutter();
    };
    new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat(s.lonlat)
      .addTo(map);
    labels.push({
      lonlat: s.lonlat,
      el,
      labelEl: el.querySelector(".lbl"),
      prio: 2.6,
    });
    return { el, d: cum[bi], k: bi, name: s.name, paused: false };
  });
  (DATA.peaks || []).forEach((p) => {
    const el = document.createElement("div");
    el.className = "mk peak" + (p.k8 ? " k8" : "") + (p.seen ? "" : " unseen");
    el.innerHTML =
      '<div class="tri"></div><div class="lbl">' +
      p.name +
      (p.elev > 0 ? " " + p.elev : "") +
      (p.seen ? "" : " ·未拍") +
      "</div>";
    el.onclick = () => {
      el.style.display = "none";
      declutter();
    };
    new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat(p.lonlat)
      .addTo(map);
    labels.push({
      lonlat: p.lonlat,
      el,
      labelEl: el.querySelector(".lbl"),
      prio: p.prio !== undefined ? p.prio : p.k8 ? 4 : 1,
    });
  });
  stayMarks = (DATA.stays || []).map((st) => {
    const el = document.createElement("div");
    el.className = "mk stay";
    el.innerHTML =
      '<div class="ic">🏠</div><div class="lbl">' + st.name + "</div>";
    el.style.display = "none";
    let bi = 0,
      bd = 1e9;
    for (let k = 0; k < N; k++) {
      const dx = track[k][0] - st.lonlat[0],
        dy = track[k][1] - st.lonlat[1],
        dd = dx * dx + dy * dy;
      if (dd < bd) {
        bd = dd;
        bi = k;
      }
    }
    el.onclick = () => {
      el.dataset.hid = "1";
      el.style.display = "none";
      declutter();
    };
    new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat(st.lonlat)
      .addTo(map);
    labels.push({
      lonlat: st.lonlat,
      el,
      labelEl: el.querySelector(".lbl"),
      prio: 2.8,
    });
    return { el, d: cum[bi], paused: false };
  });
  sleepEvents = (DATA.events || [])
    .filter((e) => e.mode === "sleep")
    .map((e) => {
      const tv = timeValue(e.start);
      let bi = 0,
        bd = Infinity;
      for (let k = 0; k < N; k++) {
        const dd = Math.abs(tnum[k] - tv);
        if (dd < bd) {
          bd = dd;
          bi = k;
        }
      }
      return { ...e, d: cum[bi], fired: false };
    });
  timelineRuntime.initialize({
    title: [
      ...DATA.titleCards,
      ...DATA.storyEvents.filter((event) => event.presentation === "title"),
    ],
    media: [
      ...(DATA.supplyEvents || []),
      ...(DATA.mediaEvents || []),
      ...DATA.storyEvents.filter((event) => event.presentation === "media"),
    ],
  });
  manualStoryEditor.activateStored();
  carEl = document.createElement("div");
  carEl.className = "car";
  carEl.textContent = "🚙";
  car = new maplibregl.Marker({ element: carEl })
    .setLngLat(track[0])
    .addTo(map);
  preloadWalkTiles();
  fitAll(0);
  curMoveMode = "sleep";
  setDist(0);
  map.on("moveend", declutter);
  map.on("zoomend", declutter);
});
// Playback state and camera updates.
function setDist(dv) {
  const dist = playback.setDistance(dv);
  const L = locate(dist),
    pos = L.pos,
    k = L.k,
    fr = L.fr;
  const now = performance.now();
  if (DATA.breaks && DATA.breaks[k]) detailCameraCenter = [pos[0], pos[1]];
  car.setLngLat(pos);
  const routeTime = tnum[k];
  carEl.classList.toggle(
    "in-tunnel",
    tunnelRanges.some(
      (range) => routeTime >= range.startMs && routeTime <= range.endMs,
    ),
  );
  if (now - lastTrailUpdate >= 80 || dist === 0 || dist === total) {
    lastTrailUpdate = now;
    map.getSource("trav").setData(routeFc(k, pos));
    map
      .getSource("traveled-route-connections")
      .setData(traveledRouteConnectionsFc(DATA.times[k]));
    if (byday) {
      const fe = {};
      for (let x = 0; x <= k; x++) {
        const d = dayKey(DATA.times[x]);
        (fe[d] = fe[d] || []).push(track[x]);
      }
      const cd = dayKey(DATA.times[k]);
      (fe[cd] = fe[cd] || []).push(pos);
      map.getSource("byday").setData({
        type: "FeatureCollection",
        features: Object.entries(fe).map(([d, co]) => ({
          type: "Feature",
          properties: { day: d },
          geometry: {
            type: "LineString",
            coordinates: co.length > 1 ? co : [co[0], co[0]],
          },
        })),
      });
    }
  }
  stayMarks.forEach((m) => {
    if (m.el.dataset.hid) return;
    m.el.style.display = dist >= m.d ? "" : "none";
  });
  const tv = tnum[k] + (tnum[k + 1] - tnum[k]) * fr;
  document.getElementById("hud-date").textContent = fmtNum(tv);
  const nextMoveMode = movingMode(k);
  if (nextMoveMode !== curMoveMode) {
    const previousMode = curMoveMode;
    curMoveMode = nextMoveMode;
    if (curMoveMode === "drive_fast") {
      detailTransitionUntil = 0;
      detailCameraCenter = null;
      const gradual =
        playback.isPlaying() &&
        (previousMode === "drive_slow" || previousMode === "walk");
      if (gradual) {
        const previousK = Math.max(0, k - 1);
        fastTransitionStart = now;
        fastTransitionFromKmh = displayKmh || speedKmhFor(previousK);
        cameraTransitionUntil = now + FAST_TRANSITION_MS;
        fitFastSegment(k, FAST_TRANSITION_MS);
      } else {
        fastTransitionStart = 0;
        cameraTransitionUntil = now + CAMERA_TRANSITION_MS;
        fitFastSegment(k);
      }
    } else {
      fastTransitionStart = 0;
      const fromGlobal = playback.isPlaying() && previousMode === "drive_fast",
        duration = fromGlobal ? DETAIL_TRANSITION_MS : CAMERA_TRANSITION_MS;
      detailTransitionUntil = fromGlobal ? now + duration : 0;
      cameraTransitionUntil = now + duration;
      detailCameraCenter = [pos[0], pos[1]];
      smoothedRoadTurn = roadTurnFor(k);
      currentDetailZoom =
        curMoveMode === "walk"
          ? walkZoomFor(k)
          : detailZoomFor(k, smoothedRoadTurn);
      const transitionView = cameraPolicy.viewFor(
        cameraPolicy.directiveAt(k),
        pos,
        {
          zoom: currentDetailZoom,
          pitch,
          bearing: 0,
          followFactor: curMoveMode === "walk" ? 0.075 : 0.055,
        },
      );
      map.easeTo({
        center: pos,
        zoom: transitionView.zoom,
        pitch: transitionView.pitch,
        bearing: transitionView.bearing,
        duration,
        easing: (t) => 1 - (1 - t) ** 3,
      });
    }
  }
  const fixedCamera = fixedCameraFor(k);
  if (fixedCamera && activeFixedCamera !== fixedCamera) {
    activeFixedCamera = fixedCamera;
    detailCameraCenter = [pos[0], pos[1]];
    fastTransitionStart = 0;
    detailTransitionUntil = 0;
    cameraTransitionUntil = now + 1800;
    fitFixedCamera(fixedCamera, 1800, pos);
  } else if (!fixedCamera && activeFixedCamera) {
    activeFixedCamera = null;
    if (curMoveMode !== "drive_fast") {
      detailCameraCenter = [pos[0], pos[1]];
      smoothedRoadTurn = roadTurnFor(k);
      currentDetailZoom = map.getZoom();
      cameraTransitionUntil = now + CAMERA_TRANSITION_MS;
      map.easeTo({
        center: pos,
        zoom:
          curMoveMode === "walk"
            ? walkZoomFor(k)
            : detailZoomFor(k, smoothedRoadTurn),
        pitch: pitch,
        bearing: 0,
        duration: CAMERA_TRANSITION_MS,
      });
    }
  }
  if (carEl) {
    if (curMoveMode === "walk") carEl.innerHTML = WALK_ICON;
    else carEl.textContent = curMoveMode === "drive_slow" ? "🚗" : "🚙";
  }
  const a0 = DATA.alts[k],
    a1 = DATA.alts[k + 1];
  const av =
    a0 != null && a1 != null ? Math.round(a0 + (a1 - a0) * fr) : a0 || a1;
  const measuredKmh = speedKmhFor(k);
  if (fastTransitionStart > 0) {
    const progress = smoothStep01(
      (now - fastTransitionStart) / FAST_TRANSITION_MS,
    );
    displayKmh = Math.round(
      fastTransitionFromKmh + (measuredKmh - fastTransitionFromKmh) * progress,
    );
  } else
    displayKmh = displayKmh
      ? Math.round(displayKmh + (measuredKmh - displayKmh) * 0.12)
      : measuredKmh;
  document.getElementById("hud-info").textContent =
    displayKmh + " km/h" + (av ? "  ·  海拔 " + av + " m" : "");
  document.getElementById("seek").value = Math.round(
    (dist / total) * SEEK_STEPS,
  );
  storyTimeline.update(dist, DATA.times[k]);
  if (
    activeFixedCamera?.follow_center &&
    now >= cameraTransitionUntil
  ) {
    if (!detailCameraCenter) detailCameraCenter = [pos[0], pos[1]];
    const follow = Number.isFinite(activeFixedCamera.follow_factor)
      ? activeFixedCamera.follow_factor
      : 0.025;
    detailCameraCenter[0] += (pos[0] - detailCameraCenter[0]) * follow;
    detailCameraCenter[1] += (pos[1] - detailCameraCenter[1]) * follow;
    const orientation = cameraPolicy.orientationFor(
      activeFixedCamera,
      detailCameraCenter,
    );
    map.jumpTo({
      center: detailCameraCenter,
      zoom: activeFixedCamera.zoom || activeFixedCamera.max_zoom || 14.2,
      pitch: orientation.pitch === null ? pitch : orientation.pitch,
      bearing: orientation.bearing,
    });
  }
  if (
    !activeFixedCamera &&
    now >= cameraTransitionUntil &&
    (curMoveMode === "walk" || curMoveMode === "drive_slow")
  ) {
    const rawTurn = roadTurnFor(k);
    smoothedRoadTurn += (rawTurn - smoothedRoadTurn) * 0.035;
    const automaticZoom =
        curMoveMode === "walk"
          ? walkZoomFor(k)
          : detailZoomFor(k, smoothedRoadTurn),
      view = cameraPolicy.viewFor(cameraPolicy.directiveAt(k), pos, {
        zoom: automaticZoom,
        pitch,
        bearing: 0,
        followFactor: curMoveMode === "walk" ? 0.075 : 0.055,
      }),
      zoomDiff = view.zoom - currentDetailZoom;
    if (Math.abs(zoomDiff) > 0.06)
      currentDetailZoom += Math.max(-0.012, Math.min(0.012, zoomDiff * 0.035));
    if (!detailCameraCenter) detailCameraCenter = [pos[0], pos[1]];
    const follow = view.followFactor;
    detailCameraCenter[0] += (pos[0] - detailCameraCenter[0]) * follow;
    detailCameraCenter[1] += (pos[1] - detailCameraCenter[1]) * follow;
    map.jumpTo({
      center: detailCameraCenter,
      zoom: currentDetailZoom,
      pitch: view.pitch,
      bearing: view.bearing,
    });
  }
}
// Overlay cards: locations, lodging, and supplies.
function clearLocationTimer() {
  clearTimeout(locationTimer);
  locationTimer = 0;
  locationTimerDeadline = 0;
  locationTimerRemaining = 0;
  locationTimerCallback = null;
}
function scheduleLocationTimer(callback, delay) {
  clearLocationTimer();
  locationTimerCallback = callback;
  locationTimerRemaining = Math.max(0, delay);
  if (locationPresentationPaused) return;
  locationTimerDeadline = performance.now() + locationTimerRemaining;
  locationTimer = setTimeout(() => {
    locationTimer = 0;
    locationTimerRemaining = 0;
    callback();
  }, locationTimerRemaining);
}
function pauseLocationPresentation() {
  if (locationPresentationPaused) return;
  locationPresentationPaused = true;
  if (locationTimer) {
    locationTimerRemaining = Math.max(0, locationTimerDeadline - performance.now());
    clearTimeout(locationTimer);
    locationTimer = 0;
  }
  document.getElementById("location-card").classList.add("presentation-paused");
}
function resumeLocationPresentation() {
  if (!locationPresentationPaused) return;
  locationPresentationPaused = false;
  document.getElementById("location-card").classList.remove("presentation-paused");
  if (locationTimerCallback && locationTimerRemaining > 0) {
    const callback = locationTimerCallback;
    const remaining = locationTimerRemaining;
    scheduleLocationTimer(callback, remaining);
  }
}
function hideLocationCard() {
  clearLocationTimer();
  clearTimeout(backpackLocationTimer);
  backpackLocationTimer = 0;
  const card = document.getElementById("location-card");
  card.classList.remove("show", "presentation-paused");
  void card.offsetWidth;
}
function showLocationCard(mark) {
  hideLocationCard();
  const card = document.getElementById("location-card"),
    name = mark.name || mark.title,
    k = mark.k,
    lead =
      mark.lead ||
      (name === "拉萨"
        ? "旅 程 开 始"
        : /[\u5c71\u53e3\u57ad\u53e3\u6c9f]/.test(name)
          ? "进 入"
          : "抵 达"),
    alt = DATA.alts[k],
    date = fmtNum(tnum[k]);
  card.classList.remove("city", "scenic", "village");
  if (mark.region_level) card.classList.add(mark.region_level);
  const displayDuration = Number.isFinite(mark.duration_ms) ? mark.duration_ms : 3200;
  card.style.setProperty("--location-duration", `${displayDuration}ms`);
  document.getElementById("location-lead").textContent = lead;
  document.getElementById("location-name").textContent = name;
  document.getElementById("location-meta").textContent = [
    mark.subtitle,
    date,
    alt ? "海拔 " + Math.round(alt) + " m" : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  document.getElementById("location-description").textContent =
    mark.description || mark.editorial_note || "";
  card.classList.add("show");
  card.classList.toggle("presentation-paused", locationPresentationPaused);
  scheduleLocationTimer(
    () => card.classList.remove("show"),
    displayDuration,
  );
}
function showSleep(ev) {
  hideLocationCard();
  const card = document.getElementById("sleep-card");
  document.getElementById("sleep-place").textContent = ev.name;
  document.getElementById("sleep-time").textContent =
    fmtNum(timeValue(ev.start)) + "  ·  住宿";
  card.classList.add("show");
  curMoveMode = "sleep";
  fastTransitionStart = 0;
  detailTransitionUntil = 0;
  activeFixedCamera = null;
  detailCameraCenter = null;
  if (carEl) carEl.textContent = "🏠";
  map.easeTo({
    center: ev.lonlat,
    zoom: 10.8,
    pitch: pitch,
    bearing: 0,
    duration: 900,
  });
  playback.pause("sleep");
  setTimeout(() => {
    card.classList.remove("show");
    document.getElementById("hud-date").textContent = fmtNum(timeValue(ev.end));
    if (playback.resume("sleep")) requestAnimationFrame(step);
  }, SLEEP_PAUSE_MS);
}
function fireTitleCards(from, to) {
  timelineRuntime
    .crossed("title", from, to)
    .forEach((event) => showLocationCard(event));
}
function hideSupplyCard(resume = false) {
  mediaOverlay.hide(resume);
}
function showSupplyCard(ev) {
  mediaOverlay.show(ev);
}
function fireSupplyEvents(from, to) {
  timelineRuntime
    .crossed("media", from, to)
    .forEach((event) => showSupplyCard(event));
}
function previewSupplyAtDistance(dv) {
  const pick = timelineRuntime.nearest("media", dv, 2500);
  if (pick) {
    pick.fired = true;
    showSupplyCard(pick);
  }
}
function step() {
  if (!playback.isPlaying()) return;
  const dist = playback.distance,
    cur = locate(dist),
    mm = movingMode(cur.k),
    city = isCompactCitySegment(cur.k),
    now = performance.now();
  let speedFactor =
    mm === "walk"
      ? city
        ? CITY_WALK_SPEED_FACTOR
        : WALK_SPEED_FACTOR
      : carPlaybackFactor();
  const playbackDirective = cameraPolicy.directiveAt(cur.k);
  if (Number.isFinite(playbackDirective?.playback_factor)) {
    speedFactor *= Math.max(0.02, playbackDirective.playback_factor);
  }
  speedFactor *= playback.factor;
  if (detailTransitionUntil > now)
    speedFactor = Math.min(speedFactor, DETAIL_TRANSITION_SPEED_FACTOR);
  else if (detailTransitionUntil) detailTransitionUntil = 0;
  if (mm === "drive_fast" && fastTransitionStart > 0) {
    const progress = (now - fastTransitionStart) / FAST_TRANSITION_MS;
    if (progress >= 1) fastTransitionStart = 0;
  }
  let frameStep = stepBase * playback.rate * speedFactor;
  if (mm === "walk" || mm === "drive_slow") {
    const s = movementSegment(cur.k);
    if (s) {
      const segmentDistance = Math.max(
          1,
          cum[Math.min(N - 1, s.endIndex)] - cum[Math.max(0, s.startIndex)],
        ),
        minFrames =
          mm === "walk"
            ? city
              ? MIN_CITY_WALK_FRAMES
              : MIN_WALK_FRAMES
            : city
              ? MIN_CITY_DETAIL_FRAMES
              : MIN_DETAIL_FRAMES;
      frameStep = Math.min(frameStep, segmentDistance / minFrames);
    }
  }
  const nd = dist + frameStep;
  fireTitleCards(dist, nd);
  fireSupplyEvents(dist, nd);
  const sleep = sleepEvents.find(
    (e) => !e.fired && e.d > dist + 1e-6 && e.d <= nd,
  );
  if (sleep) {
    playback.setDistance(sleep.d);
    setDist(playback.distance);
    sleep.fired = true;
    showSleep(sleep);
    return;
  }
  let hit = null;
  for (const m of stopMarks) {
    if (!m.paused && !m.el.dataset.hid && m.d > dist + 1e-6 && m.d <= nd) {
      if (!hit || m.d < hit.d) hit = m;
    }
  }
  if (hit) {
    playback.setDistance(hit.d);
    setDist(playback.distance);
    hit.paused = true;
    showLocationCard(hit);
    if (pauseSec > 0) {
      playback.pause("stop");
      setTimeout(() => {
        if (playback.resume("stop")) requestAnimationFrame(step);
      }, pauseSec * 1000);
      return;
    }
    requestAnimationFrame(step);
    return;
  }
  playback.setDistance(nd);
  if (playback.distance >= total) {
    setDist(total);
    playback.complete();
    return;
  }
  setDist(playback.distance);
  requestAnimationFrame(step);
}
function fitAll(duration = 800) {
  const b = track.reduce(
    (a, c) => [
      [Math.min(a[0][0], c[0]), Math.min(a[0][1], c[1])],
      [Math.max(a[1][0], c[0]), Math.max(a[1][1], c[1])],
    ],
    [
      [999, 999],
      [-999, -999],
    ],
  );
  map.fitBounds(b, { padding: 80, duration, pitch: pitch, bearing: 0 });
}

// UI controls call the playback core; map-specific reset work stays here.
function resetPlayback(options = {}) {
  playback.reset({ distance: 0, playing: Boolean(options.autoplay) });
  curDay = null;
  curMoveMode = "sleep";
  cameraTransitionUntil = 0;
  fastTransitionStart = 0;
  detailTransitionUntil = 0;
  activeFixedCamera = null;
  detailCameraCenter = null;
  displayKmh = 0;
  hideLocationCard();
  hideSupplyCard();
  stopMarks.concat(stayMarks).forEach((marker) => (marker.paused = false));
  sleepEvents.forEach((event) => (event.fired = false));
  timelineRuntime.reset();
  document.getElementById("sleep-card").classList.remove("show");
  setDist(0);
  if (options.autoplay) {
    resumeLocationPresentation();
    mediaOverlay.resumePresentation();
    step();
  }
}

new APP.PlaybackControls({
  player: playback,
  onPlay: () => {
    resumeLocationPresentation();
    mediaOverlay.resumePresentation();
    step();
  },
  onPause: () => {
    pauseLocationPresentation();
    mediaOverlay.pausePresentation();
  },
  onReplay: resetPlayback,
  onSeek: (fraction) => seekToDistance(fraction * total),
  onPauseSeconds: (seconds) => (pauseSec = seconds),
});
document.getElementById("pit").oninput = (e) => {
  pitch = +e.target.value;
  document.getElementById("pit-v").textContent = pitch + "°";
  map.easeTo({ pitch: pitch, bearing: 0, duration: 200 });
};
document.getElementById("zm").oninput = (e) => {
  zoom = +e.target.value / 10;
  document.getElementById("zm-v").textContent = zoom.toFixed(1);
  if (mode !== "overview") map.easeTo({ zoom: zoom, duration: 200 });
};

function seekToDistance(nd, options = {}) {
  playback.pause("user");
  playback.resume("media");
  playback.resume("sleep");
  playback.resume("stop");
  curMoveMode = "sleep";
  cameraTransitionUntil = 0;
  fastTransitionStart = 0;
  detailTransitionUntil = 0;
  activeFixedCamera = null;
  detailCameraCenter = null;
  displayKmh = 0;
  hideLocationCard();
  hideSupplyCard();
  stopMarks.concat(stayMarks).forEach((m) => (m.paused = m.d <= nd));
  sleepEvents.forEach((x) => (x.fired = x.d <= nd));
  timelineRuntime.reset(nd);
  document.getElementById("sleep-card").classList.remove("show");
  setDist(nd);
  if (options.previewMedia !== false) previewSupplyAtDistance(nd);
}

function locateBackpackCluster(cluster) {
  clearTimeout(backpackLocationTimer);
  hideSupplyCard(false);
  const target = routeModel.distanceAtTime(cluster.route_time);
  seekToDistance(target.d, { previewMedia: false });
  const center = Array.isArray(cluster.center) ? cluster.center : cluster.route_coordinate;
  map.easeTo({
    center,
    zoom: Math.max(12.8, Math.min(14.2, map.getZoom())),
    pitch,
    bearing: 0,
    duration: 900,
  });
  backpackLocationTimer = setTimeout(
    () =>
      showLocationCard({
        name: cluster.label,
        lead: "发 现 地 点",
        subtitle:
          cluster.items.length +
          " 件旅行素材" +
          (cluster.route_layer === "raw_accepted" ? " · 可信原始 GPS" : " · 动画路线"),
        k: target.k,
      }),
    940,
  );
}

function parseDebugTime(value) {
  const normalized = value
    .trim()
    .replace(/：/g, ":")
    .replace(/[./]/g, "-")
    .replace(/s+/g, " ");
  const current = new Date(
    tnum[Math.max(0, locate(playback.distance).k)],
  );
  let year = current.getFullYear();
  let month = current.getMonth() + 1;
  let day = current.getDate();
  let hour;
  let minute;
  let match = normalized.match(
    /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/,
  );
  if (match) {
    year = +(match[1] || year);
    month = +match[2];
    day = +match[3];
    hour = +match[4];
    minute = +match[5];
  } else {
    match = normalized.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!match) return null;
    hour = +match[1];
    minute = +match[2];
  }
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  )
    return null;
  const pad = (number) => String(number).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || timestamp < tnum[0] || timestamp > tnum[N - 1])
    return null;
  return { iso, timestamp, label: `${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}` };
}

function jumpToDebugTime() {
  const input = document.getElementById("debug-time"),
    status = document.getElementById("debug-time-status"),
    parsed = parseDebugTime(input.value);
  if (!parsed) {
    status.textContent = "时间无效";
    status.classList.add("error");
    input.select();
    return;
  }
  const target = routeModel.distanceAtTime(parsed.iso);
  seekToDistance(target.d);
  input.value = parsed.label;
  status.textContent = "已跳转";
  status.classList.remove("error");
}

document.getElementById("btn-debug-time").onclick = jumpToDebugTime;
document.getElementById("debug-time").addEventListener("keydown", (event) => {
  if (event.key === "Enter") jumpToDebugTime();
});

const regionPreviewSelect = document.getElementById("region-preview");
for (const region of DATA.previewRegions) {
  const option = document.createElement("option");
  option.value = region.id;
  option.textContent = region.label;
  regionPreviewSelect.append(option);
}
document.querySelector(".region-preview-row").hidden = !DATA.previewRegions.length;

function jumpToPreviewRegion() {
  const region = DATA.previewRegions.find((item) => item.id === regionPreviewSelect.value);
  if (!region) return;
  const target = routeModel.distanceAtTime(region.start);
  seekToDistance(target.d, { previewMedia: false });
  document.getElementById("region-preview-status").textContent = `已到 ${region.label}`;
  if (region.autoplay !== false) {
    if (playback.resume("user")) requestAnimationFrame(step);
  }
}

document.getElementById("btn-region-preview").onclick = jumpToPreviewRegion;
document.getElementById("btn-view").onclick = () => {
  const k = locate(playback.distance).k,
    m = movingMode(k);
  if (activeFixedCamera)
    fitFixedCamera(activeFixedCamera, 700, locate(playback.distance).pos);
  else if (m === "drive_fast") fitFastSegment(k, 700);
  else
    map.easeTo({
      center: locate(playback.distance).pos,
      zoom: m === "walk" ? walkZoomFor(k) : detailZoomFor(k),
      pitch: pitch,
      bearing: 0,
      duration: 700,
    });
};
document.getElementById("btn-peak").onclick = (e) => {
  showPeak = !showPeak;
  e.target.textContent = "山峰:" + (showPeak ? "显" : "隐");
  labels.forEach((L) => {
    if (L.el.classList.contains("peak"))
      L.el.style.display = showPeak ? "block" : "none";
  });
  declutter();
};
document.getElementById("btn-byday").onclick = (e) => {
  byday = !byday;
  e.target.textContent = "按天变色:" + (byday ? "开" : "关");
  map.setLayoutProperty("trav", "visibility", byday ? "none" : "visible");
  map.setLayoutProperty("bydayL", "visibility", byday ? "visible" : "none");
  setDist(playback.distance);
};
document.getElementById("sel-style").onchange = (e) => {
  const s = STYLES[e.target.value];
  map.setPaintProperty("bg", "background-color", s.bg);
  if (s.tiles) {
    map.setLayoutProperty("sat", "visibility", "visible");
    map.getSource("sat").setTiles(s.tiles);
  } else map.setLayoutProperty("sat", "visibility", "none");
  map.setPaintProperty("sat", "raster-saturation", s.saturation ?? 0);
  map.setPaintProperty("sat", "raster-contrast", s.contrast ?? 0);
  map.setPaintProperty("sat", "raster-brightness-min", s.brightnessMin ?? 0);
  map.setPaintProperty("sat", "raster-brightness-max", s.brightnessMax ?? 1);
  map.setPaintProperty("sat", "raster-hue-rotate", s.hue ?? 0);
  map.setPaintProperty("sat", "raster-opacity", s.opacity ?? 1);
  map.setPaintProperty("full", "line-color", s.full);
  map.setPaintProperty("route-connections", "line-color", s.full);
  map.setPaintProperty("traveled-route-connections", "line-color", s.trav);
  map.setPaintProperty(
    "traveled-route-connections",
    "line-width",
    s.travWidth ?? 4,
  );
  map.setPaintProperty(
    "traveled-route-connections",
    "line-blur",
    s.travBlur ?? 0.55,
  );
  map.setPaintProperty("trav", "line-color", s.trav);
  map.setPaintProperty("trav", "line-width", s.travWidth ?? 4);
  map.setPaintProperty("trav", "line-blur", s.travBlur ?? 0.55);
};
function enterRec() {
  document.body.classList.add("recording");
  resetPlayback({ autoplay: false });
  setTimeout(() => {
    if (playback.resume("user")) step();
  }, CAMERA_TRANSITION_MS + 250);
}
function exitRec() {
  document.body.classList.remove("recording");
  playback.pause("user");
}
document.getElementById("btn-rec").onclick = enterRec;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") exitRec();
});
