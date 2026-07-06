#!/usr/bin/env node

// Fast structural contract test for the generated route and browser entrypoint.
// Browser-only interaction behavior lives in the focused Playwright tests.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

function fail(message) {
  throw new Error(message);
}

function read(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) fail(`Missing file: ${relativePath}`);
  return fs.readFileSync(absolutePath, "utf8");
}

function loadBrowserData(relativePaths) {
  // Generated JS assigns data onto window; a VM reads it without starting
  // MapLibre or a browser.
  const context = { window: {} };
  vm.createContext(context);
  for (const relativePath of relativePaths) {
    vm.runInContext(read(relativePath), context, { filename: relativePath });
  }
  return context.window;
}

const html = read("地图行驶动画.html");
const appSource = read("assets/map-animation.js");
new Function(appSource);
if (!html.includes('id="seek" min="0" max="100000"')) {
  fail("High-resolution seek control is missing or has regressed");
}
for (const id of ["region-preview", "btn-region-preview", "supply-image"]) {
  if (!html.includes(`id="${id}"`)) fail(`Regional preview UI element is missing: ${id}`);
}
for (const id of [
  "btn-story-editor", "story-editor", "story-editor-save", "story-editor-assets",
  "story-editor-time", "story-editor-photo-motion", "story-editor-photo-aspect",
  "story-editor-photo-duration", "story-editor-photo-scale", "story-timeline",
  "story-timeline-seek", "story-focus-timeline", "story-focus-seek",
  "backpack-selection-confirm",
]) {
  if (!html.includes(`id="${id}"`)) fail(`Manual story editor UI element is missing: ${id}`);
}

const architectureModules = [
  "assets/modules/route-model.js",
  "assets/modules/directive-engine.js",
  "assets/modules/playback-engine.js",
  "assets/modules/timeline-runtime.js",
  "assets/modules/playback-controls.js",
  "assets/modules/camera-policy.js",
  "assets/modules/media-overlay.js",
  "assets/modules/coordinate-picker.js",
  "assets/modules/material-backpack.js",
  "assets/modules/manual-story-editor.js",
  "assets/modules/story-timeline.js",
];
for (const modulePath of architectureModules) new Function(read(modulePath));

const requiredScripts = [
  "route_data/processed/route-data.js",
  "route_data/map-content.js",
  "assets/generated/media-backpack-data.js",
  "assets/generated/location-story-data.js",
  "assets/map-config.js",
  ...architectureModules,
  "assets/map-animation.js",
];
for (const script of requiredScripts) {
  if (!html.includes(script)) fail(`HTML does not load ${script}`);
}

const browserData = loadBrowserData([
  "route_data/processed/route-data.js",
  "route_data/map-content.js",
  "assets/generated/media-backpack-data.js",
  "assets/generated/location-story-data.js",
  "assets/map-config.js",
]);
const route = browserData.ROUTE_DATA;
const content = browserData.MAP_CONTENT;
const config = browserData.MAP_ANIMATION_CONFIG;
const backpack = browserData.MEDIA_BACKPACK_DATA;
const locationStories = browserData.LOCATION_STORY_DATA;
const overrides = JSON.parse(read("route_data/route-overrides.json"));
JSON.parse(read("route_data/route-overrides.schema.json"));
const dataModel = JSON.parse(read("route_data/data-model.json"));
const rawLayer = JSON.parse(read("route_data/source/raw-track.json"));
const exclusionLayer = JSON.parse(read("route_data/editorial/exclusions.json"));
const anchorLayer = JSON.parse(read("route_data/editorial/anchors.json"));
const navigationLayer = JSON.parse(read("route_data/navigation/matched-route.json"));
const manualPaths = JSON.parse(read("route_data/editorial/manual-paths.json"));
const mediaExclusions = JSON.parse(read("edit/media-backpack-exclusions.json"));

if (!Array.isArray(route?.points) || route.points.length < 2) {
  fail("Generated route has fewer than two points");
}
if (route.point_count !== route.points.length) {
  fail(`point_count mismatch: ${route.point_count} vs ${route.points.length}`);
}
if (!Array.isArray(route.segments) || !route.segments.length) {
  fail("Generated route has no movement segments");
}
if (route.schema_version !== 2 || !route.data_model || !route.provenance) {
  fail("Generated route is missing layered-data metadata");
}
if (!Array.isArray(dataModel.layers) || dataModel.layers.length !== 4) {
  fail("Route data model must define exactly four layers");
}
if (!Array.isArray(rawLayer.points) || rawLayer.point_count !== rawLayer.points.length) {
  fail("Raw GPS layer is invalid");
}
if (!Array.isArray(exclusionLayer.automatic_points) || !Array.isArray(exclusionLayer.editorial_ranges)) {
  fail("Editorial exclusion layer is invalid");
}
if (!Array.isArray(anchorLayer.anchors)) {
  fail("Editorial anchor layer is invalid");
}
if (!Array.isArray(navigationLayer.points) || navigationLayer.point_count !== navigationLayer.points.length) {
  fail("Navigation matched layer is invalid");
}
for (const edit of overrides.geometry_edits || []) {
  if (edit.path_id && !Array.isArray(manualPaths.paths?.[edit.path_id])) {
    fail(`Geometry edit references missing manual path: ${edit.path_id}`);
  }
}
const allowedSources = new Set([
  "raw",
  "editorial_anchor",
  "navigation:osm",
  "navigation:osrm",
  "rendered",
]);
for (const point of route.points) {
  if (!allowedSources.has(point.source) || typeof point.generated !== "boolean") {
    fail(`Invalid point provenance at ${point.time}`);
  }
}
function movementModeAt(isoTime) {
  const target = Date.parse(isoTime);
  const pointIndex = route.points.reduce(
    (best, point, index) =>
      Math.abs(Date.parse(point.time) - target) <
      Math.abs(Date.parse(route.points[best].time) - target)
        ? index
        : best,
    0,
  );
  return route.segments.find(
    (segment) => pointIndex >= segment.startIndex && pointIndex <= segment.endIndex,
  )?.mode;
}
if (movementModeAt("2024-12-22T11:32:00+08:00") !== "drive_slow") {
  fail("Lhasa exit detail camera regressed to global view around 11:32");
}
if (movementModeAt("2024-12-22T18:00:00+08:00") !== "drive_slow") {
  fail("December 22 18:00 must remain one continuous slow-driving section");
}
if (movementModeAt("2024-12-27T08:27:00+08:00") !== "drive_slow") {
  fail("Outbound trip to the Asia viewpoint must be slow driving");
}
if (movementModeAt("2024-12-27T09:15:00+08:00") !== "walk") {
  fail("Asia viewpoint visit must switch to walking after arrival");
}
for (const expected of [
  [90.736238, 28.288804],
  [88.238646, 28.009006],
  [85.404633, 28.357927],
  [91.158833, 29.649127],
]) {
  if (!route.points.some((point) => point.lon === expected[0] && point.lat === expected[1])) {
    fail(`Required editorial anchor is missing: ${expected.join(",")}`);
  }
}
if (!Array.isArray(content?.stops) || !Array.isArray(content?.peaks)) {
  fail("Map content is missing stops or peaks");
}
if (
  !config?.playback ||
  !config.playback.carScreenSpeed ||
  !config?.camera ||
  !config?.mapStyles
) {
  fail("Central map configuration is incomplete");
}
if (overrides.$schema !== "route-overrides.schema.json") {
  fail("route-overrides.json is not linked to its local schema");
}

const architecture = loadBrowserData([
  "assets/modules/route-model.js",
  "assets/modules/directive-engine.js",
  "assets/modules/camera-policy.js",
]).RouteDemo;
const sampleRoute = new architecture.RouteModel({
  track: [
    [90, 29],
    [90.01, 29.01],
  ],
  times: ["2024-12-22T10:00:00+08:00", "2024-12-22T10:10:00+08:00"],
  alts: [4000, 4100],
  breaks: [false, false],
  segments: [
    { mode: "walk", startIndex: 0, endIndex: 1 },
  ],
});
const sampleDirectives = new architecture.DirectiveEngine(sampleRoute).compile(
  [{ id: "sample", lonlat: [90.01, 29.01] }],
  "media",
);
if (sampleDirectives[0].k !== 1 || sampleDirectives[0].triggerKind !== "coordinate") {
  fail("Coordinate directive compiler is not resolving against the route model");
}

const styleSelect = html.match(/<select id="sel-style">([\s\S]*?)<\/select>/)?.[1] || "";
const styleOptions = [...styleSelect.matchAll(/<option value="([^"]+)"/g)].map(
  (match) => match[1],
);
for (const style of styleOptions) {
  if (!config.mapStyles[style]) fail(`Missing map style config: ${style}`);
}

for (const event of route.supply_events || []) {
  for (const key of ["video", "poster"]) {
    if (event[key] && !fs.existsSync(path.join(ROOT, event[key]))) {
      fail(`Supply event media does not exist: ${event[key]}`);
    }
  }
}
for (const event of route.media_events || []) {
  if ((!Array.isArray(event.lonlat) || event.lonlat.length !== 2) && !event.time) {
    fail(`Media event has invalid lonlat: ${event.id || event.title}`);
  }
  for (const key of ["video", "poster", "image"]) {
    if (event[key] && !fs.existsSync(path.join(ROOT, event[key]))) {
      fail(`Media event asset does not exist: ${event[key]}`);
    }
  }
  for (const clip of event.clips || []) {
    if (!clip.video && !clip.image) {
      fail(`Media clip is missing video/image: ${event.id || event.title}`);
    }
    for (const key of ["video", "poster", "image"]) {
      if (clip[key] && !fs.existsSync(path.join(ROOT, clip[key]))) {
        fail(`Media clip asset does not exist: ${clip[key]}`);
      }
    }
  }
}
for (const event of route.story_events || []) {
  for (const key of ["video", "poster", "image"]) {
    if (event[key] && !fs.existsSync(path.join(ROOT, event[key]))) {
      fail(`Story event asset does not exist: ${event[key]}`);
    }
  }
}
if (!Array.isArray(backpack?.clusters) || backpack.cluster_count !== backpack.clusters.length) {
  fail("Media backpack cluster manifest is invalid");
}
const backpackThemeItems = (backpack.themes || []).flatMap((theme) => theme.items || []);
const backpackClusterItems = backpack.clusters.flatMap((cluster) => cluster.items || []);
const backpackItems = [...backpackThemeItems, ...backpackClusterItems];
if (backpack.item_count !== backpackItems.length || !backpackItems.length) {
  fail("Media backpack item_count is invalid");
}
const backpackIds = new Set();
const backpackPaths = new Set(backpackItems.map((item) => item.path.toLowerCase()));
if (backpack.theme_count !== (backpack.themes || []).length) {
  fail("Media backpack theme_count is invalid");
}
if (backpack.theme_item_count !== backpackThemeItems.length) {
  fail("Media backpack theme_item_count is invalid");
}
for (const theme of backpack.themes || []) {
  if (theme.group_type !== "theme" || !theme.id || !theme.label || !theme.items?.length) {
    fail(`Media backpack theme is invalid: ${theme.id || "unknown"}`);
  }
  for (const item of theme.items) {
    if (!item.id || backpackIds.has(item.id)) fail(`Duplicate backpack item: ${item.id}`);
    backpackIds.add(item.id);
    for (const key of ["path", "preview", "poster"]) {
      if (item[key] && !fs.existsSync(path.join(ROOT, item[key]))) {
        fail(`Backpack theme ${key} does not exist: ${item[key]}`);
      }
    }
  }
}
const dayOneTheme = (backpack.themes || []).find((theme) => theme.id === "theme-day-1");
if (
  dayOneTheme?.items.length !== 27 ||
  dayOneTheme.items[0]?.path !== "photo/DSC_8022.JPG" ||
  dayOneTheme.items.at(-1)?.path !== "photo/DSC_8048.JPG"
) {
  fail("Day 1 theme media is incomplete");
}
const dayTwoTheme = (backpack.themes || []).find((theme) => theme.id === "theme-day-2");
if (
  dayTwoTheme?.items.length !== 1 ||
  dayTwoTheme.items[0]?.path !== "photo/DSCF1920-1.jpg"
) {
  fail("Day 2 theme media is incomplete");
}
const themeAssignments = backpack.theme_cluster_assignments || [];
const assignmentPaths = new Set(themeAssignments.map((assignment) => assignment.path));
const assignedGroundItems = backpackClusterItems.filter((item) =>
  /^theme-day-(?:[3-9]|10)$/.test(item.source_theme_id || ""),
);
if (
  (backpack.themes || []).some((theme) => /^theme-day-(?:[3-9]|10)$/.test(theme.id)) ||
  backpack.theme_cluster_assignment_count !== themeAssignments.length ||
  themeAssignments.length !== assignedGroundItems.length ||
  themeAssignments.length < 1000 ||
  new Set(themeAssignments.map((assignment) => assignment.capture_time.slice(0, 10))).size !== 8
) {
  fail("Ground-trip no-GPS media was not fully merged into GPS clusters");
}
for (const assignment of themeAssignments) {
  const cluster = backpack.clusters.find((item) => item.id === assignment.cluster_id);
  const assignedItem = cluster?.items.find((item) => item.path === assignment.path);
  const referenceItem = cluster?.items.find((item) => item.path === assignment.gps_media_reference_path);
  const timeAnchor = cluster?.media_capture_time_anchors?.find(
    (anchor) => anchor.time === assignment.cluster_media_time_anchor,
  );
  if (
    !assignedItem ||
    ![
      "nearest_cluster_media_time_anchor",
      "semantic_confirmed_nearest_cluster",
      "semantic_tiebreak_nearby_cluster",
      "calibrated_nearest_cluster_session",
      "calibrated_semantic_confirmed_session",
      "calibrated_semantic_tiebreak_session",
    ].includes(assignedItem.assignment_method) ||
    assignedItem.assigned_cluster_time_anchor !== assignment.cluster_media_time_anchor ||
    assignedItem.calibrated_capture_time !== assignment.calibrated_capture_time ||
    assignedItem.time_calibration_offset_seconds !== assignment.time_calibration_offset_seconds ||
    !assignment.cluster_session_id ||
    timeAnchor?.session_id !== assignment.cluster_session_id ||
    !assignedItem.analyzed_location ||
    !["high", "medium", "low"].includes(assignedItem.assignment_confidence) ||
    !Array.isArray(assignedItem.assignment_candidates) ||
    assignedItem.assignment_candidates.length < 1 ||
    assignedItem.assignment_candidates.length > 3 ||
    !timeAnchor ||
    timeAnchor.gps_media_count !== assignment.cluster_gps_media_count ||
    !referenceItem ||
    referenceItem.source_theme_id ||
    assignmentPaths.has(assignment.gps_media_reference_path)
  ) {
    fail(`No-GPS media assignment is invalid: ${assignment.path}`);
  }
}
const noGpsAssignments = JSON.parse(read("log/3km/no_gps_cluster_assignments.json"));
if (noGpsAssignments.assignment_count !== themeAssignments.length) {
  fail("No-GPS assignment audit count is invalid");
}
if (
  noGpsAssignments.schema_version !== 2 ||
  noGpsAssignments.time_calibration?.global_offset_seconds !== 0 ||
  !Array.isArray(noGpsAssignments.time_calibration?.unreliable_anchor_paths)
) {
  fail("No-GPS time calibration metadata is invalid");
}
read("log/3km/无GPS素材重新归簇.md");
read("log/3km/无GPS素材时间校准变化.md");
if (
  !Array.isArray(locationStories?.regions) ||
  !Array.isArray(locationStories?.events) ||
  locationStories.region_count !== locationStories.regions.length ||
  locationStories.event_count !== locationStories.events.length ||
  locationStories.regions.length < 12 ||
  locationStories.events.length < 30
) {
  fail("Generated location story manifest is invalid");
}
const removedUnverifiedStoryIds = new Set([
  "director-sequence-yamdrok-portraits",
  "director-sequence-yamdrok-aerial-views",
  "director-sequence-kulagangri-walk",
  "director-sequence-kulagangri-glacier-details",
  "director-sequence-kulagangri-team",
  "director-sequence-kulagangri-lakeside-people",
  "director-sequence-border-wildlife",
  "director-sequence-kulagangri-frozen-lake-wide",
  "director-sequence-kulagangri-people-and-peak",
]);
if (locationStories.events.some((event) => removedUnverifiedStoryIds.has(event.id))) {
  fail("Removed unverified location story sequence was regenerated");
}
const storyEventIds = new Set();
for (const event of locationStories.events) {
  if (
    !event.id ||
    storyEventIds.has(event.id) ||
    !event.time ||
    !["title", "media"].includes(event.presentation)
  ) {
    fail(`Generated location story event is invalid: ${event.id || "missing-id"}`);
  }
  if (event.presentation === "title") {
    if (!event.title || !["city", "scenic", "village"].includes(event.region_level)) {
      fail(`Generated region tag is invalid: ${event.id}`);
    }
    storyEventIds.add(event.id);
    continue;
  }
  if (
    typeof event.pause !== "boolean" ||
    (event.pause === true && !event.video) ||
    !event.source_path ||
    !backpackPaths.has(event.source_path.toLowerCase()) ||
    (event.capture_time && event.capture_time.slice(0, 10) !== event.time.slice(0, 10) && !event.editorial_time_override)
  ) {
    fail(`Generated location story event is invalid: ${event.id || event.source_path}`);
  }
  storyEventIds.add(event.id);
  if (event.sequence_id) {
    if (
      !Array.isArray(event.clips) ||
      event.clips.length < 2 ||
      !Number.isFinite(event.auto_advance_ms) ||
      event.auto_advance_ms < 250
    ) {
      fail(`Generated location story sequence is invalid: ${event.id}`);
    }
    for (const clip of event.clips) {
      const clipPath = clip.image || clip.video;
      if (!clipPath || !fs.existsSync(path.join(ROOT, clipPath))) {
        fail(`Generated location story sequence clip is missing: ${event.id}`);
      }
    }
  }
  for (const key of ["image", "video", "poster"]) {
    if (event[key] && !fs.existsSync(path.join(ROOT, event[key]))) {
      fail(`Generated location story asset does not exist: ${event[key]}`);
    }
  }
  if (event.video && (!event.poster || event.autoplay !== true || event.muted !== true)) {
    fail(`Generated story video is missing playback metadata: ${event.id}`);
  }
}
for (const region of locationStories.regions) {
  if (
    !region.id ||
    !region.label ||
    !["city", "scenic", "village"].includes(region.level) ||
    !region.start ||
    !region.end ||
    !Array.isArray(region.enter_coordinate) ||
    !Array.isArray(region.exit_coordinate) ||
    !Array.isArray(region.main_coordinate) ||
    !Array.isArray(region.allowed_scene_groups) ||
    !Number.isInteger(region.max_story_nodes) ||
    region.max_story_nodes > 5
  ) {
    fail(`Generated location story region is invalid: ${region.id || "unknown"}`);
  }
  if (region.event_ids.some((id) => !storyEventIds.has(id))) {
    fail(`Generated location story region references a missing event: ${region.id}`);
  }
}
read("edit/地点素材触发剧本.md");
if (
  backpack.editorial_exclusion_count !== mediaExclusions.items.length ||
  backpack.editorial_exclusions?.length !== mediaExclusions.items.length
) {
  fail("Media backpack editorial exclusion metadata is invalid");
}
for (const originalExcludedPath of mediaExclusions.items) {
  const excludedPath = originalExcludedPath.toLowerCase();
  if (backpackPaths.has(excludedPath)) fail(`Excluded media is still rendered: ${excludedPath}`);
  if (!fs.existsSync(path.join(ROOT, originalExcludedPath))) {
    fail(`Excluded media file does not exist: ${originalExcludedPath}`);
  }
  if (/\.hei[cf]$/i.test(excludedPath)) {
    const stem = excludedPath.replace(/\.hei[cf]$/i, "");
    if (backpackPaths.has(`${stem}.mov`) || backpackPaths.has(`${stem}.mp4`)) {
      fail(`Excluded Live Photo motion is still rendered: ${stem}`);
    }
  }
}
for (const cluster of backpack.clusters) {
  if (!Array.isArray(cluster.center) || cluster.center.length !== 2 || !cluster.label) {
    fail(`Media backpack cluster is missing location data: ${cluster.id}`);
  }
  if (
    !cluster.route_time ||
    !Array.isArray(cluster.route_coordinate) ||
    cluster.route_coordinate.length !== 2 ||
    !["final", "raw_accepted"].includes(cluster.route_layer)
  ) {
    fail(`Media backpack cluster has no unique map destination: ${cluster.id}`);
  }
  const clusterRouteTime = Date.parse(cluster.route_time);
  if (
    !Number.isFinite(clusterRouteTime) ||
    clusterRouteTime < Date.parse(route.points[0].time) ||
    clusterRouteTime > Date.parse(route.points[route.points.length - 1].time)
  ) {
    fail(`Media backpack destination time is outside the route: ${cluster.id}`);
  }
  if (!cluster.items.some((item) => item.path === cluster.route_reference_item)) {
    fail(`Media backpack destination reference is missing: ${cluster.id}`);
  }
  for (const item of cluster.items || []) {
    if (!item.id || backpackIds.has(item.id)) fail(`Duplicate backpack item: ${item.id}`);
    backpackIds.add(item.id);
    for (const key of ["path", "preview", "poster", "motion_source"]) {
      if (item[key] && !fs.existsSync(path.join(ROOT, item[key]))) {
        fail(`Backpack ${key} does not exist: ${item[key]}`);
      }
    }
    if (
      item.preview_role === "live_photo" &&
      (item.preview_type !== "video" ||
        !item.motion_source ||
        !/\.hei[cf]$/i.test(item.path) ||
        backpackPaths.has(item.motion_source.toLowerCase()) ||
        !Array.isArray(item.related_files) ||
        !item.related_files.includes(item.path) ||
        !item.related_files.includes(item.motion_source))
    ) {
      fail(`Backpack Live Photo mapping is invalid: ${item.path}`);
    }
    if (/\.hei[cf]$/i.test(item.path) && item.preview_role === "image" && !/_preview\.jpg$/i.test(item.preview)) {
      fail(`Backpack HEIC has no browser JPEG preview: ${item.path}`);
    }
    if (/\.mov$/i.test(item.path) && item.preview_type === "video" && !/_web\.mp4$/i.test(item.preview)) {
      fail(`Backpack MOV has no browser MP4 preview: ${item.path}`);
    }
    for (const relatedPath of item.related_files || []) {
      if (!fs.existsSync(path.join(ROOT, relatedPath))) {
        fail(`Backpack related file does not exist: ${relatedPath}`);
      }
    }
  }
}
if (backpackPaths.has("photo/img_5959.heic") || backpackPaths.has("photo/img_5959.mov")) {
  fail("Excluded IMG_5959 Live Photo is still rendered");
}
for (const requiredSource of [
  "editorial_exclusions",
  "isEditoriallyExcludedMedia",
  "withoutExcludedMedia",
]) {
  if (!appSource.includes(requiredSource)) fail(`Runtime media exclusion is missing: ${requiredSource}`);
}
for (const id of [
  "btn-backpack",
  "material-backpack",
  "backpack-grid",
  "backpack-preview",
  "backpack-locate-cluster",
  "backpack-mark-bad",
  "backpack-copy-bad",
]) {
  if (!html.includes(`id="${id}"`)) fail(`Backpack UI element is missing: ${id}`);
}
for (const connection of route.route_connections || []) {
  if (!Array.isArray(connection.coordinates) || connection.coordinates.length < 2) {
    fail(`Route connection is missing geometry: ${connection.id || connection.name}`);
  }
}

const jiaruolaRegion = (route.preview_regions || []).find(
  (region) => region.id === "jiaruola-pass",
);
if (
  !jiaruolaRegion ||
  jiaruolaRegion.start !== "2024-12-22T13:18:30+08:00" ||
  jiaruolaRegion.autoplay !== true
) {
  fail("加若拉山口区域跳转配置不完整");
}
const jiaruolaPassMedia = (route.media_events || []).find(
  (event) => event.id === "jiaruola-pass-summit-memory",
);
if (
  jiaruolaPassMedia?.video !== "photo/IMG_6021_web.mp4" ||
  jiaruolaPassMedia?.poster !== "photo/IMG_6021_poster.jpg" ||
  jiaruolaPassMedia?.autoplay !== true ||
  jiaruolaPassMedia?.pause !== true
) {
  fail("加若拉山口 Live Photo 事件不完整");
}
const jiaruolaLakeMedia = (route.media_events || []).find(
  (event) => event.id === "jiaruola-yamdrok-reveal",
);
if (
  jiaruolaLakeMedia?.image !== "photo/DSC_8060.JPG" ||
  jiaruolaLakeMedia?.media_layout !== "landscape" ||
  jiaruolaLakeMedia?.priority !== "chapter" ||
  jiaruolaLakeMedia?.pause !== false
) {
  fail("加若拉下山羊湖原图事件不完整");
}
const jiaruolaCamera = (route.camera_directives || []).find(
  (item) => item.id === "jiaruola-scenic-stage",
);
if (
  !jiaruolaCamera ||
  jiaruolaCamera.mode !== "fixed_region" ||
  !Array.isArray(jiaruolaCamera.center) ||
  jiaruolaCamera.end !== "2024-12-22T14:50:00+08:00" ||
  jiaruolaCamera.zoom !== 13.4 ||
  jiaruolaCamera.bearing !== 198 ||
  jiaruolaCamera.follow_center !== true ||
  jiaruolaCamera.follow_factor !== 0.025 ||
  jiaruolaCamera.playback_factor !== 1.0
) {
  fail("加若拉山口固定景色镜头配置不完整");
}

const requiredPreviewRegions = new Set([
  "lhasa-life-day0",
  "lhasa-departure",
  "supply-water",
  "jiaruola-pass",
  "jiaruola-yamdrok-descent",
  "potala-palace-return",
  "zongjiao-lukang-park",
  "barkhor-street",
]);
for (const region of route.preview_regions || []) requiredPreviewRegions.delete(region.id);
if (requiredPreviewRegions.size) {
  fail(`新增区域跳转缺失: ${[...requiredPreviewRegions].join(", ")}`);
}

const configuredStoryEvents = new Map(
  (route.story_events || []).map((event) => [event.id, event]),
);
for (const [id, asset] of [
  ["lhasa-life-day0-dinner", "photo/IMG_5973_web.mp4"],
  ["lhasa-life-day0-potala-night", "photo/IMG_6004_web.mp4"],
  ["lhasa-departure-start", "photo/IMG_6016_web.mp4"],
  ["barkhor-prostration", "video/VID_20241229_163348.mp4"],
]) {
  const event = configuredStoryEvents.get(id);
  if (!event || event.video !== asset || event.presentation !== "media") {
    fail(`新增剧本视频事件不完整: ${id}`);
  }
}

const descentEvents = (route.media_events || [])
  .filter((event) => event.id.startsWith("jiaruola-yamdrok-"))
  .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
if (
  descentEvents.length !== 5 ||
  descentEvents.map((event) => event.image).join("|") !==
    ["DSC_8057.JPG", "DSC_8058.JPG", "DSC_8059.JPG", "DSC_8060.JPG", "DSC_8065.JPG"]
      .map((name) => `photo/${name}`)
      .join("|") ||
  descentEvents.some((event) => event.pause !== false)
) {
  fail("加若拉山口下降段的五次羊湖照片触发不完整");
}

const duckBurst = (route.media_events || []).find(
  (event) => event.id === "zongjiao-lukang-duck-burst",
);
if (
  !duckBurst ||
  duckBurst.clips?.length !== 14 ||
  duckBurst.auto_advance_ms !== 420 ||
  !read("assets/modules/media-overlay.js").includes("startImageSequence")
) {
  fail("宗角禄康公园鸭群自动连拍配置不完整");
}
if (
  (route.camera_ranges || []).some(
    (range) =>
      Date.parse(range.start) <= Date.parse(jiaruolaCamera.end) &&
      Date.parse(range.end) >= Date.parse(jiaruolaCamera.start),
  )
) {
  fail("加若拉山口区域仍有额外镜头切换");
}
const climbModes = route.points.filter(
  (point) =>
    point.time >= "2024-12-22T13:20:00+08:00" &&
    point.time <= "2024-12-22T13:42:00+08:00",
);
if (!climbModes.length || climbModes.some((point) => point.mode !== "drive_slow")) {
  fail("加若拉盘山路未完整设为慢车模式");
}

console.log(
  [
    "Route demo validation passed",
    `points=${route.points.length}`,
    `segments=${route.segments.length}`,
    `stops=${content.stops.length}`,
    `peaks=${content.peaks.length}`,
    `styles=${Object.keys(config.mapStyles).length}`,
    `media=${(route.media_events || []).length}`,
    `backpack=${backpack.item_count}/${backpack.cluster_count}+${backpack.theme_count}theme`,
    `raw=${rawLayer.points.length}`,
    `anchors=${anchorLayer.anchors.length}`,
  ].join(" | "),
);
