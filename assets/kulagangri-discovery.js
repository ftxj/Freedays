"use strict";

const WALK_PATH = [
  [90.7414664, 28.2783087, 4756],
  [90.7409436, 28.2793582, 4755],
  [90.7404207, 28.2804077, 4754],
  [90.7398979, 28.2814573, 4752],
  [90.739375, 28.2825068, 4751],
  [90.7388522, 28.2835563, 4750],
  [90.7383294, 28.2846059, 4749],
  [90.7378065, 28.2856554, 4748],
  [90.7372837, 28.2867049, 4747],
  [90.7367608, 28.2877545, 4745],
  [90.736238, 28.288804, 4744],
];

const SUMMIT = [90.6098206, 28.4353632];
const VIEWPOINT = [90.736238, 28.288804];
const APPROACH_BEARING = 322.83;
const QUERY = new URLSearchParams(window.location.search);
const AUTOPLAY = QUERY.get("autoplay") === "1";
const PREVIEW_STAGE = QUERY.get("stage");
const MEDIA_TITLES = new Map([
  ["kulagangri-aerial.mp4", "白玛林措航拍"],
  ["kulagangri-hiker.mp4", "红衣徒步者"],
  ["kulagangri-ridge.mp4", "山脊上的我们"],
]);

const elements = {
  loading: document.getElementById("loading"),
  error: document.getElementById("error-state"),
  opening: document.getElementById("opening-copy"),
  walker: document.getElementById("walker"),
  beacon: document.getElementById("summit-beacon"),
  shade: document.getElementById("terrain-shade"),
  discovery: document.getElementById("discovery-card"),
  dock: document.getElementById("memory-dock"),
  play: document.getElementById("play-sequence"),
  skip: document.getElementById("skip-discovery"),
  transport: document.querySelector(".transport"),
  status: document.getElementById("sequence-status"),
  meta: document.getElementById("hud-meta"),
  videoStage: document.getElementById("video-stage"),
  video: document.getElementById("memory-video"),
  videoTitle: document.getElementById("video-title"),
  videoClose: document.getElementById("video-close"),
};

let map;
let ready = false;
let sequenceId = 0;
let animationFrame = 0;
let walkerMarker;
let summitMarker;
let sceneInitialized = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lineFeature(coords) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords.map((p) => p.slice(0, 2)) },
  };
}

function setStatus(text) {
  elements.status.textContent = text;
}

function setRouteProgress(indexFloat) {
  const end = Math.max(1, Math.ceil(indexFloat) + 1);
  const coords = WALK_PATH.slice(0, end).map((p) => p.slice(0, 2));
  const source = map.getSource("walked-route");
  if (source) source.setData(lineFeature(coords));
}

function interpolatePath(progress) {
  const scaled = progress * (WALK_PATH.length - 1);
  const index = Math.min(WALK_PATH.length - 2, Math.floor(scaled));
  const fraction = Math.min(1, scaled - index);
  const a = WALK_PATH[index];
  const b = WALK_PATH[index + 1];
  return {
    indexFloat: scaled,
    lon: a[0] + (b[0] - a[0]) * fraction,
    lat: a[1] + (b[1] - a[1]) * fraction,
    alt: a[2] + (b[2] - a[2]) * fraction,
  };
}

function positionWalker(position) {
  walkerMarker.setLngLat([position.lon, position.lat]);
  elements.meta.textContent = `步行 · 海拔 ${Math.round(position.alt)} m`;
}

function resetOverlayState() {
  elements.opening.classList.remove("hide");
  elements.walker.classList.remove("visible");
  elements.beacon.classList.remove("visible");
  elements.shade.classList.remove("active");
  elements.discovery.classList.remove("show", "leave");
  elements.dock.classList.remove("show");
  elements.transport.classList.remove("hide");
  closeVideo();
}

function cancelSequence() {
  sequenceId += 1;
  cancelAnimationFrame(animationFrame);
}

function checkSequence(id) {
  if (id !== sequenceId) throw new Error("sequence-cancelled");
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function animateWalk(duration, id) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = (now) => {
      if (id !== sequenceId) {
        reject(new Error("sequence-cancelled"));
        return;
      }
      const progress = Math.min(1, (now - start) / duration);
      const eased = easeInOut(progress);
      const point = interpolatePath(eased);
      positionWalker(point);
      setRouteProgress(point.indexFloat);
      if (progress < 1) animationFrame = requestAnimationFrame(tick);
      else resolve();
    };
    animationFrame = requestAnimationFrame(tick);
  });
}

function initialCamera() {
  map.jumpTo({
    center: [90.721, 28.314],
    zoom: 11.15,
    pitch: 32,
    bearing: APPROACH_BEARING,
  });
}

function approachCamera() {
  map.easeTo({
    center: [90.691, 28.349],
    zoom: 11.45,
    pitch: 58,
    bearing: APPROACH_BEARING,
    duration: 4300,
    easing: easeInOut,
  });
}

function heroCamera() {
  map.easeTo({
    center: [90.659, 28.389],
    zoom: 11.5,
    pitch: 68,
    bearing: APPROACH_BEARING,
    duration: 3800,
    easing: easeInOut,
  });
}

async function playSequence() {
  if (!ready) return;
  cancelSequence();
  const id = sequenceId;
  resetOverlayState();
  elements.play.disabled = true;
  elements.skip.disabled = true;
  elements.opening.classList.add("hide");
  setStatus("进入徒步路段");

  initialCamera();
  map.setTerrain({ source: "terrain", exaggeration: 1.18 });
  const start = interpolatePath(0);
  positionWalker(start);
  setRouteProgress(0);
  await wait(550);
  checkSequence(id);
  elements.walker.classList.add("visible");

  approachCamera();
  setStatus("三人沿山脊走向库拉岗日");
  await animateWalk(6500, id);
  checkSequence(id);

  setStatus("抬起视角，望向库拉岗日");
  heroCamera();
  map.setTerrain({ source: "terrain", exaggeration: 1.26 });
  await wait(2600);
  checkSequence(id);
  elements.beacon.classList.add("visible");
  await wait(1400);
  checkSequence(id);

  setStatus("发现地点 · 库拉岗日");
  elements.shade.classList.add("active");
  elements.discovery.classList.add("show");
  await wait(3100);
  checkSequence(id);

  elements.discovery.classList.add("leave");
  await wait(500);
  checkSequence(id);
  elements.discovery.classList.remove("show", "leave");
  elements.dock.classList.add("show");
  elements.transport.classList.add("hide");
  setStatus("地点影像已解锁");
  elements.play.disabled = false;
  elements.skip.disabled = false;
}

function showDiscoveryImmediately() {
  if (!ready) return;
  cancelSequence();
  resetOverlayState();
  elements.opening.classList.add("hide");
  elements.walker.classList.add("visible");
  elements.beacon.classList.add("visible");
  elements.shade.classList.add("active");
  positionWalker(interpolatePath(1));
  setRouteProgress(WALK_PATH.length - 1);
  map.setTerrain({ source: "terrain", exaggeration: 1.26 });
  map.jumpTo({
    center: [90.659, 28.389],
    zoom: 11.5,
    pitch: 68,
    bearing: APPROACH_BEARING,
  });
  elements.discovery.classList.add("show");
  elements.transport.classList.add("hide");
  setTimeout(() => {
    elements.discovery.classList.add("leave");
    setTimeout(() => {
      elements.discovery.classList.remove("show", "leave");
      elements.dock.classList.add("show");
    }, 500);
  }, 2600);
}

function openVideo(button) {
  const src = button.dataset.video;
  const filename = src.split("/").pop();
  elements.videoTitle.textContent = MEDIA_TITLES.get(filename) || "库拉岗日影像";
  elements.video.src = src;
  elements.videoStage.classList.add("show");
  elements.video.play().catch(() => {});
}

function closeVideo() {
  elements.video.pause();
  elements.video.removeAttribute("src");
  elements.video.load();
  elements.videoStage.classList.remove("show");
}

function createMap() {
  map = new maplibregl.Map({
    container: "map",
    center: [90.721, 28.314],
    zoom: 11.15,
    pitch: 32,
    bearing: APPROACH_BEARING,
    maxPitch: 85,
    attributionControl: false,
    interactive: true,
    style: {
      version: 8,
      sources: {
        satellite: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          maxzoom: 18,
          attribution: "Imagery © Esri",
        },
        terrain: {
          type: "raster-dem",
          url: "https://tiles.mapterhorn.com/tilejson.json",
          tileSize: 512,
          encoding: "terrarium",
          maxzoom: 12,
        },
      },
      layers: [
        {
          id: "satellite",
          type: "raster",
          source: "satellite",
          paint: {
            "raster-saturation": -0.16,
            "raster-contrast": 0.08,
            "raster-brightness-min": 0.05,
            "raster-brightness-max": 0.94,
          },
        },
        {
          id: "terrain-shadows",
          type: "hillshade",
          source: "terrain",
          paint: {
            "hillshade-exaggeration": 0.28,
            "hillshade-shadow-color": "#0b1920",
            "hillshade-highlight-color": "#e8d6ac",
            "hillshade-accent-color": "#486c70",
          },
        },
      ],
      terrain: { source: "terrain", exaggeration: 1.18 },
      sky: {
        "sky-color": "#8ba9b4",
        "horizon-color": "#d5c6a5",
        "fog-color": "#b9ad91",
        "sky-horizon-blend": 0.42,
        "horizon-fog-blend": 0.14,
        "fog-ground-blend": 0.04,
      },
    },
  });

  map.once("style.load", () => {
    if (sceneInitialized) return;
    sceneInitialized = true;
    map.addSource("full-route", { type: "geojson", data: lineFeature(WALK_PATH) });
    map.addSource("walked-route", {
      type: "geojson",
      data: lineFeature(WALK_PATH.slice(0, 2)),
    });
    map.addLayer({
      id: "route-shadow",
      type: "line",
      source: "full-route",
      paint: {
        "line-color": "rgba(4, 12, 15, 0.72)",
        "line-width": 7,
        "line-blur": 3,
      },
    });
    map.addLayer({
      id: "full-route-line",
      type: "line",
      source: "full-route",
      paint: {
        "line-color": "rgba(238, 230, 202, 0.34)",
        "line-width": 2.2,
        "line-dasharray": [1.2, 1.3],
      },
    });
    map.addLayer({
      id: "walked-route-line",
      type: "line",
      source: "walked-route",
      paint: {
        "line-color": "#e0c174",
        "line-width": 4,
        "line-blur": 0.35,
      },
    });

    walkerMarker = new maplibregl.Marker({ element: elements.walker, anchor: "bottom" })
      .setLngLat(WALK_PATH[0].slice(0, 2))
      .addTo(map);
    summitMarker = new maplibregl.Marker({ element: elements.beacon, anchor: "bottom" })
      .setLngLat(SUMMIT)
      .addTo(map);

    ready = true;
    elements.loading.classList.add("hide");
    elements.play.disabled = false;
    elements.skip.disabled = false;
    setStatus("地形已就绪");
    initialCamera();
    if (PREVIEW_STAGE === "discovery") {
      setTimeout(showDiscoveryImmediately, 500);
    } else if (AUTOPLAY) {
      setTimeout(() => {
        playSequence().catch((error) => {
          if (error.message !== "sequence-cancelled") console.error(error);
        });
      }, 900);
    }
  });

  map.on("error", (event) => {
    const message = String(event?.error?.message || "");
    if (!message || /tile/i.test(message)) return;
    console.warn("Map error:", message);
  });

  setTimeout(() => {
    if (ready) return;
    elements.loading.classList.add("hide");
    elements.error.classList.add("show");
  }, 20000);
}

elements.play.disabled = true;
elements.skip.disabled = true;
elements.play.addEventListener("click", () => {
  playSequence().catch((error) => {
    if (error.message !== "sequence-cancelled") console.error(error);
  });
});
elements.skip.addEventListener("click", showDiscoveryImmediately);
elements.videoClose.addEventListener("click", closeVideo);
elements.videoStage.addEventListener("click", (event) => {
  if (event.target === elements.videoStage) closeVideo();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeVideo();
});
document.querySelectorAll(".memory-card").forEach((button) => {
  button.addEventListener("click", () => openVideo(button));
});

createMap();
