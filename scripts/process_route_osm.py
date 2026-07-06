#!/usr/bin/env python3
"""
Build road/path-aware route data from the original GPX.

Outputs:
  route_data/source/raw-track.json
  route_data/editorial/exclusions.json
  route_data/editorial/anchors.json
  route_data/navigation/matched-route.json
  route_data/processed/route-data.json
  route_data/processed/route-data.js
  route_data/processed/route-segments-summary.md

Notes:
  - Original GPX data is normalized into a read-only source layer.
  - Editorial exclusions/anchors are generated from route-overrides.json.
  - Driving/walking geometry is matched to cached OSM/OSRM road data.
  - Rendered points preserve provenance and are never reused as upstream input.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


BASE = Path(__file__).resolve().parents[1]
GPX = BASE / "2024.01.01-2024.12.31.gpx"
OUT_DIR = BASE / "route_data" / "processed"
SOURCE_DIR = BASE / "route_data" / "source"
EDITORIAL_DIR = BASE / "route_data" / "editorial"
NAVIGATION_DIR = BASE / "route_data" / "navigation"
CACHE_DIR = BASE / "route_data" / "osm_cache"
DRIVE_CACHE_DIR = BASE / "route_data" / "osrm_drive_cache"
OVERRIDES = BASE / "route_data" / "route-overrides.json"
EDITORIAL_PATHS = BASE / "route_data" / "editorial" / "manual-paths.json"
_LOCAL_DRIVE_GRAPHS: dict[str, tuple[object, list[tuple[float, float]]]] = {}
EVENT_OVERRIDE_KEYS = (
    "camera_ranges",
    "title_cards",
    "city_walk_ranges",
    "supply_events",
    "media_events",
    "story_events",
    "camera_directives",
    "preview_regions",
    "tunnel_ranges",
)


def materialize_route_connections(overrides: dict) -> list[dict]:
    specs = overrides.get("route_connections", [])
    if not specs:
        return []
    if not EDITORIAL_PATHS.exists():
        raise FileNotFoundError(f"missing editorial paths: {EDITORIAL_PATHS}")
    path_payload = json.loads(EDITORIAL_PATHS.read_text(encoding="utf-8"))
    paths = path_payload.get("paths", {})
    result = []
    for spec in specs:
        path_id = spec.get("path_id")
        coords = paths.get(path_id)
        if not coords:
            raise KeyError(f"missing route connection path: {path_id}")
        result.append({**spec, "coordinates": coords})
    return result


@dataclass
class Pt:
    t: datetime
    lon: float
    lat: float
    ele: float | None
    source: str = "raw"
    source_id: str | None = None
    generated: bool = False
    derived_from: list[str] | None = None


def hav_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    q = math.pi / 180
    x = (
        math.sin((lat2 - lat1) * q / 2) ** 2
        + math.cos(lat1 * q)
        * math.cos(lat2 * q)
        * math.sin((lon2 - lon1) * q / 2) ** 2
    )
    return 6371008.8 * 2 * math.asin(math.sqrt(x))


def parse_gpx() -> list[Pt]:
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    root = ET.parse(GPX).getroot()
    pts: list[Pt] = []
    for raw_index, trkpt in enumerate(root.findall(".//g:trkpt", ns)):
        time_el = trkpt.find("g:time", ns)
        if time_el is None:
            continue
        t = datetime.fromisoformat(time_el.text.replace("Z", "+00:00")).astimezone(
            timezone(timedelta(hours=8))
        )
        ele_el = trkpt.find("g:ele", ns)
        pts.append(
            Pt(
                t=t,
                lon=float(trkpt.attrib["lon"]),
                lat=float(trkpt.attrib["lat"]),
                ele=float(ele_el.text) if ele_el is not None else None,
                source="raw",
                source_id=f"gpx:{raw_index}",
                generated=False,
            )
        )
    return pts


def point_record(point: Pt, mode: str | None = None) -> dict:
    record = {
        "lon": round(point.lon, 7),
        "lat": round(point.lat, 7),
        "time": point.t.isoformat(),
        "alt": round(point.ele) if point.ele is not None else None,
        "source": point.source,
        "source_id": point.source_id,
        "generated": point.generated,
    }
    if point.derived_from:
        record["derived_from"] = point.derived_from
    if mode is not None:
        record["mode"] = mode
    return record


def filter_trip_points(pts: list[Pt]) -> list[Pt]:
    # Keep the travel period and remove airplane / impossible jumps.
    kept = [
        p
        for p in pts
        if "2024-12-22" <= p.t.date().isoformat() <= "2024-12-29"
    ]
    out = [kept[0]]
    for p in kept[1:]:
        prev = out[-1]
        dt_h = (p.t - prev.t).total_seconds() / 3600
        d_km = hav_m((prev.lon, prev.lat), (p.lon, p.lat)) / 1000
        if dt_h > 0 and d_km / dt_h > 300:
            continue
        out.append(p)
    # Remove isolated GPS spikes: a large detour through one point followed by
    # an immediate return near the original path. These otherwise force routing
    # through the wrong valley or lake shore.
    changed = True
    while changed and len(out) >= 3:
        changed = False
        cleaned = [out[0]]
        for i in range(1, len(out) - 1):
            a, b, c = cleaned[-1], out[i], out[i + 1]
            ab = hav_m((a.lon, a.lat), (b.lon, b.lat))
            bc = hav_m((b.lon, b.lat), (c.lon, c.lat))
            ac = hav_m((a.lon, a.lat), (c.lon, c.lat))
            dt1 = max(1.0, (b.t - a.t).total_seconds())
            dt2 = max(1.0, (c.t - b.t).total_seconds())
            spike = (
                ab >= 2500
                and bc >= 2500
                and ab / dt1 * 3.6 >= 110
                and bc / dt2 * 3.6 >= 110
                and ac <= max(1800, 0.22 * (ab + bc))
            )
            if spike:
                changed = True
                continue
            cleaned.append(b)
        cleaned.append(out[-1])
        out = cleaned
    return out


def speed_kmh(a: Pt, b: Pt) -> float:
    dt_h = (b.t - a.t).total_seconds() / 3600
    if dt_h <= 0:
        return 999.0
    return hav_m((a.lon, a.lat), (b.lon, b.lat)) / 1000 / dt_h


def segment_slow_clusters(
    pts: list[Pt], threshold_kmh: float = 12.0, min_duration_s: int = 90
) -> list[tuple[int, int]]:
    raw: list[tuple[int, int]] = []
    start: int | None = None
    for i in range(len(pts) - 1):
        slow = speed_kmh(pts[i], pts[i + 1]) <= threshold_kmh
        if slow and start is None:
            start = i
        if (not slow or i == len(pts) - 2) and start is not None:
            end = i + 1 if slow else i
            duration_s = (pts[end].t - pts[start].t).total_seconds()
            distance_m = sum(
                hav_m((pts[j - 1].lon, pts[j - 1].lat), (pts[j].lon, pts[j].lat))
                for j in range(start + 1, end + 1)
            )
            same_day = pts[start].t.date() == pts[end].t.date()
            # Keep actual walking/slow movement; discard overnight gaps and near-stationary clusters.
            if same_day and min_duration_s <= duration_s <= 5 * 3600 and distance_m >= 120:
                raw.append((start, end))
            start = None

    # Merge nearby slow clusters separated by tiny gaps.
    merged: list[tuple[int, int]] = []
    for a, b in raw:
        if not merged:
            merged.append((a, b))
            continue
        pa, pb = merged[-1]
        gap_s = (pts[a].t - pts[pb].t).total_seconds()
        gap_m = hav_m((pts[pb].lon, pts[pb].lat), (pts[a].lon, pts[a].lat))
        if gap_s <= 180 and gap_m <= 250:
            merged[-1] = (pa, b)
        else:
            merged.append((a, b))
    return merged


def densify_points(points: list[Pt], max_step_m: float = 60) -> list[Pt]:
    if len(points) < 2:
        return points
    out = [points[0]]
    for a, b in zip(points, points[1:]):
        d = hav_m((a.lon, a.lat), (b.lon, b.lat))
        steps = max(1, math.ceil(d / max_step_m))
        for s in range(1, steps + 1):
            f = s / steps
            if s == steps:
                out.append(b)
                continue
            derived = [value for value in (a.source_id, b.source_id) if value]
            out.append(
                Pt(
                    t=a.t + (b.t - a.t) * f,
                    lon=a.lon + (b.lon - a.lon) * f,
                    lat=a.lat + (b.lat - a.lat) * f,
                    ele=(
                        a.ele + (b.ele - a.ele) * f
                        if a.ele is not None and b.ele is not None
                        else b.ele
                    ),
                    source="rendered",
                    source_id=None,
                    generated=True,
                    derived_from=derived or None,
                )
            )
    return out


def load_overrides() -> dict:
    if not OVERRIDES.exists():
        return {"mode_ranges": [], "stays": []}
    return json.loads(OVERRIDES.read_text(encoding="utf-8"))


def override_mode(t: datetime, overrides: dict) -> str | None:
    for item in overrides.get("mode_ranges", []):
        start = datetime.fromisoformat(item["start"])
        end = datetime.fromisoformat(item["end"])
        if start <= t <= end:
            return item["mode"]
    return None


def stable_drive_modes(pts: list[Pt], overrides: dict) -> list[str]:
    """Classify once during preprocessing; never make the camera guess per frame."""
    n = len(pts)
    local_speed: list[float] = []
    for i in range(n):
        lo, hi = i, i
        while lo > 0 and (pts[i].t - pts[lo].t).total_seconds() < 300:
            lo -= 1
        while hi < n - 1 and (pts[hi].t - pts[i].t).total_seconds() < 300:
            hi += 1
        dt_h = (pts[hi].t - pts[lo].t).total_seconds() / 3600
        distance_km = sum(
            hav_m((pts[k - 1].lon, pts[k - 1].lat), (pts[k].lon, pts[k].lat))
            for k in range(lo + 1, hi + 1)
        ) / 1000
        local_speed.append(distance_km / dt_h if dt_h > 0 else 999.0)

    modes = ["drive_fast" if v >= 42 else "drive_slow" for v in local_speed]
    # Majority filter removes brief GPS-speed oscillations before creating segments.
    filtered = modes[:]
    radius = 12
    for i in range(n):
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        slow = sum(m == "drive_slow" for m in modes[lo:hi])
        filtered[i] = "drive_slow" if slow > (hi - lo) / 2 else "drive_fast"
        manual = override_mode(pts[i].t, overrides)
        if manual in {"drive_fast", "drive_slow", "walk"}:
            filtered[i] = manual
    return filtered


def build_sleep_events(pts: list[Pt], overrides: dict) -> list[dict]:
    events: list[dict] = []
    for stay in overrides.get("stays", []):
        day = datetime.fromisoformat(stay["date"]).date()
        same_day = [p for p in pts if p.t.date() == day]
        next_day = [p for p in pts if p.t.date() == day + timedelta(days=1)]
        if not same_day or not next_day:
            continue
        evening = [p for p in same_day if p.t.hour >= 18] or same_day[-1:]
        morning = [p for p in next_day if p.t.hour >= 7] or next_day[:1]
        if stay.get("lonlat"):
            target = tuple(stay["lonlat"])
            at = min(evening, key=lambda p: hav_m((p.lon, p.lat), target))
            lonlat = stay["lonlat"]
        else:
            at = evening[-1]
            lonlat = [round(at.lon, 7), round(at.lat, 7)]
        events.append(
            {
                "mode": "sleep",
                "name": stay["name"],
                "start": at.t.isoformat(),
                "end": morning[0].t.isoformat(),
                "lonlat": lonlat,
            }
        )
    return events


def remove_sleep_intervals(points: list[dict], events: list[dict]) -> list[dict]:
    """Remove overnight GPS drift and mark a zero-distance visual break."""
    windows = sorted(
        (
            datetime.fromisoformat(e["start"]),
            datetime.fromisoformat(e["end"]),
        )
        for e in events
    )
    result: list[dict] = []
    pending_breaks = [False] * len(windows)
    for point in points:
        t = datetime.fromisoformat(point["time"])
        inside = False
        for n, (start, end) in enumerate(windows):
            if start < t < end:
                inside = True
                pending_breaks[n] = True
                break
            if pending_breaks[n] and t >= end:
                point = dict(point)
                point["breakBefore"] = True
                pending_breaks[n] = False
        if not inside:
            result.append(point)
    return result


def apply_geometry_edits(points: list[dict], edits: list[dict]) -> list[dict]:
    """Replace a noisy/backtracking interval with a user-approved simple path."""
    result = points
    for edit in edits:
        if len(result) < 2:
            continue
        start_t = datetime.fromisoformat(edit["start"])
        end_t = datetime.fromisoformat(edit["end"])
        i = min(
            range(len(result)),
            key=lambda k: abs((datetime.fromisoformat(result[k]["time"]) - start_t).total_seconds()),
        )
        j = min(
            range(len(result)),
            key=lambda k: abs((datetime.fromisoformat(result[k]["time"]) - end_t).total_seconds()),
        )
        if i >= j:
            continue
        first, last = result[i], result[j]
        via = edit.get("via", [])
        if edit.get("path_id"):
            if not EDITORIAL_PATHS.exists():
                raise FileNotFoundError(f"missing editorial paths: {EDITORIAL_PATHS}")
            path_payload = json.loads(EDITORIAL_PATHS.read_text(encoding="utf-8"))
            via = path_payload.get("paths", {}).get(edit["path_id"])
            if via is None:
                raise KeyError(f"missing editorial path: {edit['path_id']}")
        via_coords = [(float(c[0]), float(c[1])) for c in via]
        if edit.get("authoritative_path_start") and via_coords:
            first = {**first, "lon": via_coords[0][0], "lat": via_coords[0][1]}
        if edit.get("authoritative_path_end") and via_coords:
            last = {**last, "lon": via_coords[-1][0], "lat": via_coords[-1][1]}
        anchors = [
            (float(first["lon"]), float(first["lat"])),
            *via_coords,
            (float(last["lon"]), float(last["lat"])),
        ]
        lengths = [hav_m(anchors[k - 1], anchors[k]) for k in range(1, len(anchors))]
        total_m = sum(lengths)
        if total_m <= 0:
            continue
        max_step = max(3.0, float(edit.get("max_step_m", 12)))
        first_t = datetime.fromisoformat(first["time"])
        last_t = datetime.fromisoformat(last["time"])
        first_alt, last_alt = first.get("alt"), last.get("alt")
        forced_mode = edit.get("mode")
        edit_id = edit.get("id") or f"geometry:{edit.get('name', 'unnamed')}"
        first_replacement = dict(first)
        if forced_mode:
            first_replacement["mode"] = forced_mode
        replacement = [first_replacement]
        travelled = 0.0
        for leg, leg_m in enumerate(lengths, start=1):
            a, b = anchors[leg - 1], anchors[leg]
            steps = max(1, math.ceil(leg_m / max_step))
            for n in range(1, steps + 1):
                f = n / steps
                progress = (travelled + leg_m * f) / total_m
                if leg == len(lengths) and n == steps:
                    last_replacement = dict(last)
                    if forced_mode:
                        last_replacement["mode"] = forced_mode
                    replacement.append(last_replacement)
                    continue
                alt = None
                if first_alt is not None and last_alt is not None:
                    alt = round(first_alt + (last_alt - first_alt) * progress)
                is_via_vertex = n == steps and leg < len(lengths)
                via_source = edit.get("via_source", "editorial_anchor")
                is_generated_via = via_source.startswith("navigation:")
                replacement.append(
                    {
                        "lon": round(a[0] + (b[0] - a[0]) * f, 7),
                        "lat": round(a[1] + (b[1] - a[1]) * f, 7),
                        "time": (first_t + (last_t - first_t) * progress).isoformat(),
                        "alt": alt,
                        "mode": forced_mode or first["mode"],
                        "source": via_source if is_via_vertex else "rendered",
                        "source_id": edit_id if is_via_vertex else None,
                        "generated": is_generated_via if is_via_vertex else True,
                        "derived_from": [edit_id],
                    }
                )
            travelled += leg_m
        result = result[:i] + replacement + result[j + 1 :]
        print(
            f"[geometry-edit] {edit.get('name', 'unnamed')} "
            f"removed={j - i + 1} added={len(replacement)}",
            flush=True,
        )
    return result


def apply_mode_overrides(points: list[dict], overrides: dict) -> list[dict]:
    """Refresh explicit editorial modes without rematching route geometry."""
    ranges = [
        (
            datetime.fromisoformat(item["start"]),
            datetime.fromisoformat(item["end"]),
            item["mode"],
        )
        for item in overrides.get("mode_ranges", [])
    ]
    refreshed = []
    for point in points:
        t = datetime.fromisoformat(point["time"])
        forced_mode = next((mode for start, end, mode in ranges if start <= t <= end), None)
        refreshed.append({**point, "mode": forced_mode} if forced_mode else point)
    return refreshed


def provenance_summary(points: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for point in points:
        source = point.get("source", "unknown")
        counts[source] = counts.get(source, 0) + 1
    return dict(sorted(counts.items()))


def build_segments(points: list[dict]) -> list[dict]:
    segments: list[dict] = []
    if not points:
        return segments
    start = 0
    for k in range(1, len(points) + 1):
        if k == len(points) or points[k]["mode"] != points[start]["mode"]:
            segments.append(
                {
                    "mode": points[start]["mode"],
                    "startIndex": start,
                    "endIndex": k - 1,
                    "start": points[start]["time"],
                    "end": points[k - 1]["time"],
                }
            )
            start = k
    return segments


def collect_editorial_anchors(overrides: dict) -> list[dict]:
    anchors: list[dict] = []
    for edit_index, edit in enumerate(overrides.get("geometry_edits", [])):
        edit_id = edit.get("id") or f"geometry-edit:{edit_index}"
        for via_index, lonlat in enumerate(edit.get("via", [])):
            anchors.append(
                {
                    "id": f"{edit_id}:via:{via_index}",
                    "role": "geometry_via",
                    "lonlat": lonlat,
                    "start": edit["start"],
                    "end": edit["end"],
                    "label": edit.get("name"),
                    "source": "editorial_anchor",
                }
            )
    for collection in ("story_events", "supply_events", "media_events", "title_cards"):
        for event_index, event in enumerate(overrides.get(collection, [])):
            lonlat = event.get("lonlat") or event.get("gps")
            event_time = event.get("time")
            if not lonlat and not event_time:
                continue
            anchors.append(
                {
                    "id": event.get("id") or f"{collection}:{event_index}",
                    "role": "story_trigger",
                    "collection": collection,
                    **({"lonlat": lonlat} if lonlat else {}),
                    **({"time": event_time} if event_time else {}),
                    "label": event.get("title") or event.get("name"),
                    "source": "editorial_anchor",
                }
            )
    return anchors


def write_layer_inputs(raw_points: list[Pt], kept_points: list[Pt], overrides: dict) -> None:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    EDITORIAL_DIR.mkdir(parents=True, exist_ok=True)
    kept_ids = {point.source_id for point in kept_points}
    trip_points = [
        point
        for point in raw_points
        if "2024-12-22" <= point.t.date().isoformat() <= "2024-12-29"
    ]
    normalized = []
    automatic_exclusions = []
    for point in trip_points:
        accepted = point.source_id in kept_ids
        record = point_record(point)
        record["accepted"] = accepted
        normalized.append(record)
        if not accepted:
            automatic_exclusions.append(
                {
                    "source_id": point.source_id,
                    "lonlat": [round(point.lon, 7), round(point.lat, 7)],
                    "time": point.t.isoformat(),
                    "reason": "automatic_invalid_jump_or_isolated_spike",
                }
            )
    raw_payload = {
        "schema_version": 1,
        "authoritative_source": GPX.name,
        "description": "原始 GPX 的规范化只读镜像；accepted 仅表示是否进入后续处理。",
        "point_count": len(normalized),
        "points": normalized,
    }
    editorial_ranges = []
    for index, edit in enumerate(overrides.get("geometry_edits", [])):
        start = datetime.fromisoformat(edit["start"])
        end = datetime.fromisoformat(edit["end"])
        affected_raw_ids = [
            point.source_id for point in trip_points if start < point.t < end
        ]
        editorial_ranges.append(
            {
                "id": edit.get("id") or f"geometry-edit:{index}",
                "name": edit.get("name"),
                "start": edit["start"],
                "end": edit["end"],
                "effect": "replace_interval_geometry",
                "excluded_raw_source_ids": affected_raw_ids,
            }
        )
    exclusion_payload = {
        "schema_version": 1,
        "automatic_points": automatic_exclusions,
        "editorial_ranges": editorial_ranges,
    }
    anchor_payload = {
        "schema_version": 1,
        "description": "人工新增、字幕/媒体触发及必须经过的叙事锚点。",
        "anchors": collect_editorial_anchors(overrides),
    }
    (SOURCE_DIR / "raw-track.json").write_text(
        json.dumps(raw_payload, ensure_ascii=False), encoding="utf-8"
    )
    (EDITORIAL_DIR / "exclusions.json").write_text(
        json.dumps(exclusion_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (EDITORIAL_DIR / "anchors.json").write_text(
        json.dumps(anchor_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_navigation_layer(points: list[dict]) -> None:
    NAVIGATION_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "description": "剔除无效原始点并完成 OSM/OSRM 道路匹配后的中间路线；人工几何修正尚未应用。",
        "point_count": len(points),
        "provenance": provenance_summary(points),
        "points": points,
    }
    (NAVIGATION_DIR / "matched-route.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def select_drive_anchors(points: list[Pt], spacing_m: float = 1200) -> list[Pt]:
    if len(points) <= 2:
        return points
    anchors = [points[0]]
    travelled = 0.0
    for a, b in zip(points, points[1:]):
        travelled += hav_m((a.lon, a.lat), (b.lon, b.lat))
        elapsed = (b.t - anchors[-1].t).total_seconds()
        if travelled >= spacing_m or (travelled >= 300 and elapsed >= 300):
            anchors.append(b)
            travelled = 0.0
    if anchors[-1] is not points[-1]:
        anchors.append(points[-1])
    return anchors


def interpolate_geometry(
    coords: list[tuple[float, float]], a: Pt, b: Pt, max_step_m: float = 120,
    navigation_source: str = "navigation:osrm",
) -> list[Pt]:
    if len(coords) < 2:
        return densify_points([a, b], max_step_m=max_step_m)
    dense: list[tuple[tuple[float, float], bool]] = [(coords[0], True)]
    for x, y in zip(coords, coords[1:]):
        steps = max(1, math.ceil(hav_m(x, y) / max_step_m))
        dense.extend(
            (
                (x[0] + (y[0] - x[0]) * s / steps, x[1] + (y[1] - x[1]) * s / steps),
                s == steps,
            )
            for s in range(1, steps + 1)
        )
    lengths = [0.0]
    for x, y in zip(dense, dense[1:]):
        lengths.append(lengths[-1] + hav_m(x[0], y[0]))
    total = lengths[-1] or 1.0
    result: list[Pt] = []
    derived = [value for value in (a.source_id, b.source_id) if value]
    for (coord, is_navigation_vertex), distance in zip(dense, lengths):
        f = distance / total
        result.append(
            Pt(
                t=a.t + (b.t - a.t) * f,
                lon=coord[0],
                lat=coord[1],
                ele=(
                    a.ele + (b.ele - a.ele) * f
                    if a.ele is not None and b.ele is not None
                    else b.ele
                ),
                source=navigation_source if is_navigation_vertex else "rendered",
                source_id=None,
                generated=True,
                derived_from=derived or None,
            )
        )
    return result


def osrm_leg_geometry(leg: dict) -> list[tuple[float, float]]:
    coords: list[tuple[float, float]] = []
    for step in leg.get("steps", []):
        geometry = step.get("geometry", {}).get("coordinates", [])
        part = [(float(x), float(y)) for x, y in geometry]
        if coords and part and coords[-1] == part[0]:
            coords.extend(part[1:])
        else:
            coords.extend(part)
    return coords


def route_drive_chunk(
    anchors: list[Pt], cache_name: str, allow_download: bool = True,
    reject_to_empty: bool = False,
) -> list[Pt]:
    import requests

    key_text = ";".join(f"{p.lon:.6f},{p.lat:.6f}" for p in anchors)
    key = hashlib.sha1(key_text.encode("utf-8")).hexdigest()[:16]
    DRIVE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = DRIVE_CACHE_DIR / f"{cache_name}_{key}.json"
    data: dict | None = None
    if cache_path.exists():
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    elif allow_download:
        base = os.environ.get("OSRM_URL", "https://router.project-osrm.org")
        url = f"{base}/route/v1/driving/{key_text}"
        response = requests.get(
            url,
            params={
                "steps": "true",
                "overview": "false",
                "geometries": "geojson",
                "alternatives": "false",
            },
            headers={"User-Agent": "VLogRouteProcessor/1.0 (offline cached map matching)"},
            timeout=90,
        )
        response.raise_for_status()
        data = response.json()
        cache_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        time.sleep(0.25)
    if not data or data.get("code") != "Ok" or not data.get("routes"):
        # A forced local OSM corridor must remain usable even when this exact
        # OSRM request is absent from cache or the public router rejected it.
        output: list[Pt] = []
        for a, b in zip(anchors, anchors[1:]):
            coords = local_corridor_geometry(a, b, only_forced=True)
            if not coords:
                if reject_to_empty:
                    return []
                part = densify_points([a, b], max_step_m=150)
            else:
                part = interpolate_geometry(
                    coords,
                    a,
                    b,
                    max_step_m=120,
                    navigation_source="navigation:osm",
                )
            if output and part:
                part = part[1:]
            output.extend(part)
        return output

    route = data["routes"][0]
    legs = route.get("legs", [])
    waypoints = data.get("waypoints", [])
    if len(legs) != len(anchors) - 1:
        return [] if reject_to_empty else densify_points(anchors, max_step_m=150)
    output: list[Pt] = []
    for i, (a, b, leg) in enumerate(zip(anchors, anchors[1:], legs)):
        coords = osrm_leg_geometry(leg)
        direct = hav_m((a.lon, a.lat), (b.lon, b.lat))
        routed = float(leg.get("distance", 0))
        elapsed_s = max(1.0, (b.t - a.t).total_seconds())
        snap_a = (
            hav_m((a.lon, a.lat), tuple(waypoints[i]["location"]))
            if i < len(waypoints)
            else 0
        )
        snap_b = (
            hav_m((b.lon, b.lat), tuple(waypoints[i + 1]["location"]))
            if i + 1 < len(waypoints)
            else 0
        )
        forced_local = local_corridor_geometry(a, b, only_forced=True)
        valid = bool(forced_local)
        navigation_source = "navigation:osm" if forced_local else "navigation:osrm"
        if forced_local:
            coords = forced_local
        else:
            valid = (
                len(coords) >= 2
                and snap_a <= 650
                and snap_b <= 650
                and routed <= max(8000, direct * 3.2)
                and routed <= max(6000, elapsed_s / 3600 * 135000 + 2500)
            )
        if not valid:
            local_coords = local_corridor_geometry(a, b)
            if local_coords:
                coords = local_coords
                valid = True
                navigation_source = "navigation:osm"
        if not valid and reject_to_empty:
            return []
        part = (
            interpolate_geometry(
                coords,
                a,
                b,
                max_step_m=120,
                navigation_source=navigation_source,
            )
            if valid
            else densify_points([a, b], max_step_m=150)
        )
        if output and part:
            part = part[1:]
        output.extend(part)
    return output


def match_drive_osrm(
    points: list[Pt], name: str, allow_download: bool = True, chunk_size: int = 48
) -> list[Pt]:
    anchors = select_drive_anchors(points)
    if len(anchors) < 2:
        return points
    output: list[Pt] = []
    chunk_no = 0
    start = 0
    while start < len(anchors) - 1:
        end = min(len(anchors), start + chunk_size)
        chunk = anchors[start:end]
        print(
            f"[drive] {name} chunk={chunk_no + 1} anchors={len(chunk)}",
            flush=True,
        )
        try:
            part = route_drive_chunk(
                chunk, f"{name}_{chunk_no:03d}", allow_download=allow_download
            )
        except Exception as exc:
            print(f"[warn] driving match failed {name} chunk={chunk_no + 1}: {exc}", flush=True)
            part = densify_points(chunk, max_step_m=150)
        if output and part:
            part = part[1:]
        output.extend(part)
        if end == len(anchors):
            break
        start = end - 1
        chunk_no += 1
    return output


def bridge_movement_gaps(
    points: list[dict], allow_download: bool = True, threshold_m: float = 180
) -> list[dict]:
    if len(points) < 2:
        return points
    result = [points[0]]
    for b in points[1:]:
        a = result[-1]
        distance = hav_m((a["lon"], a["lat"]), (b["lon"], b["lat"]))
        ta, tb = datetime.fromisoformat(a["time"]), datetime.fromisoformat(b["time"])
        elapsed = (tb - ta).total_seconds()
        if distance >= threshold_m and elapsed > 90 * 60:
            b = dict(b)
            b["breakBefore"] = True
        elif distance >= threshold_m and 0 < elapsed <= 90 * 60:
            pa = Pt(
                ta, a["lon"], a["lat"], a.get("alt"),
                source=a.get("source", "raw"),
                source_id=a.get("source_id"),
                generated=bool(a.get("generated", False)),
                derived_from=a.get("derived_from"),
            )
            pb = Pt(
                tb, b["lon"], b["lat"], b.get("alt"),
                source=b.get("source", "raw"),
                source_id=b.get("source_id"),
                generated=bool(b.get("generated", False)),
                derived_from=b.get("derived_from"),
            )
            cache_name = f"bridge_{ta.strftime('%m%d_%H%M%S')}_{tb.strftime('%H%M%S')}"
            try:
                bridge = route_drive_chunk(
                    [pa, pb], cache_name, allow_download=allow_download,
                    reject_to_empty=True,
                )
            except Exception as exc:
                print(f"[warn] bridge failed {cache_name}: {exc}", flush=True)
                bridge = []
            if bridge:
                bridge_mode = (
                    b["mode"] if b["mode"].startswith("drive") else a["mode"]
                )
                connector_in = densify_points([pa, bridge[0]], max_step_m=120)
                connector_out = densify_points([bridge[-1], pb], max_step_m=120)
                combined = connector_in[1:] + bridge[1:-1] + connector_out[1:-1]
                for p in combined:
                    result.append(point_record(p, bridge_mode))
            else:
                b = dict(b)
                b["breakBefore"] = True
        result.append(b)
    return result


def bbox_for(points: list[Pt], buffer_deg: float = 0.0025) -> tuple[float, float, float, float]:
    north = max(p.lat for p in points) + buffer_deg
    south = min(p.lat for p in points) - buffer_deg
    east = max(p.lon for p in points) + buffer_deg
    west = min(p.lon for p in points) - buffer_deg
    return north, south, east, west


def graph_from_bbox_cached(points: list[Pt], name: str, refresh: bool = False):
    import osmnx as ox

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    graph_path = CACHE_DIR / f"{name}.graphml"
    if graph_path.exists() and not refresh:
        return ox.load_graphml(graph_path)

    north, south, east, west = bbox_for(points)
    print(f"[osm] download {name}: N={north:.5f} S={south:.5f} E={east:.5f} W={west:.5f}")
    try:
        G = ox.graph_from_bbox(
            bbox=(north, south, east, west),
            network_type="walk",
            simplify=True,
            retain_all=True,
        )
    except TypeError:
        G = ox.graph_from_bbox(north, south, east, west, network_type="walk", simplify=True)
    ox.save_graphml(G, graph_path)
    return G


def overpass_ways_cached(points: list[Pt], name: str, refresh: bool = False) -> list[list[tuple[float, float]]]:
    import requests

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{name}.ways.json"
    if cache_path.exists() and not refresh:
        return json.loads(cache_path.read_text(encoding="utf-8"))
    if not refresh:
        day_prefix = "_".join(name.split("_")[:2])
        sibling_caches = sorted(CACHE_DIR.glob(f"{day_prefix}_*.ways.json"))
        if sibling_caches:
            ways: list[list[tuple[float, float]]] = []
            for sibling in sibling_caches:
                ways.extend(json.loads(sibling.read_text(encoding="utf-8")))
            print(
                f"[osm-light] reuse {len(sibling_caches)} same-day caches for {name}",
                flush=True,
            )
            return ways

    north, south, east, west = bbox_for(points)
    query = f"""
[out:json][timeout:45];
(
  way({south:.7f},{west:.7f},{north:.7f},{east:.7f})["highway"];
);
out geom;
"""
    print(f"[osm-light] download {name}: N={north:.5f} S={south:.5f} E={east:.5f} W={west:.5f}", flush=True)
    headers = {"User-Agent": "VLogRouteProcessor/1.0 (local offline route matching)"}
    url = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
    r = requests.post(url, data=query.encode("utf-8"), headers=headers, timeout=70)
    r.raise_for_status()
    data = r.json()
    ways: list[list[tuple[float, float]]] = []
    for el in data.get("elements", []):
        geom = el.get("geometry") or []
        coords = [(float(p["lon"]), float(p["lat"])) for p in geom if "lon" in p and "lat" in p]
        if len(coords) >= 2:
            ways.append(coords)
    cache_path.write_text(json.dumps(ways, ensure_ascii=False), encoding="utf-8")
    return ways


def overpass_drive_ways_cached(
    points: list[Pt], name: str, refresh: bool = False
) -> list[list[tuple[float, float]]]:
    import requests

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{name}.ways.json"
    if cache_path.exists() and not refresh:
        return json.loads(cache_path.read_text(encoding="utf-8"))
    north, south, east, west = bbox_for(points, buffer_deg=0.006)
    query = f"""
[out:json][timeout:60];
way({south:.7f},{west:.7f},{north:.7f},{east:.7f})
  ["highway"~"motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|service|track|road|living_street"]
  ["access"!~"no|private"];
out geom;
"""
    print(f"[osm-drive] download {name}", flush=True)
    response = requests.post(
        os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter"),
        data=query.encode("utf-8"),
        headers={"User-Agent": "VLogRouteProcessor/1.0 (local road corridor matching)"},
        timeout=90,
    )
    response.raise_for_status()
    ways: list[list[tuple[float, float]]] = []
    for item in response.json().get("elements", []):
        coords = [
            (float(p["lon"]), float(p["lat"]))
            for p in item.get("geometry", [])
            if "lon" in p and "lat" in p
        ]
        if len(coords) >= 2:
            ways.append(coords)
    cache_path.write_text(json.dumps(ways, ensure_ascii=False), encoding="utf-8")
    return ways


def local_corridor_geometry(
    a: Pt, b: Pt, only_forced: bool = False
) -> list[tuple[float, float]] | None:
    import networkx as nx

    for corridor in load_overrides().get("road_corridors", []):
        if only_forced and not corridor.get("force_local", False):
            continue
        start = datetime.fromisoformat(corridor["start"])
        end = datetime.fromisoformat(corridor["end"])
        if not (start <= a.t <= end and start <= b.t <= end):
            continue
        cache_path = CACHE_DIR / corridor["cache"]
        if not cache_path.exists():
            return None
        cache_key = str(cache_path)
        if cache_key not in _LOCAL_DRIVE_GRAPHS:
            ways = json.loads(cache_path.read_text(encoding="utf-8"))
            graph = nx.Graph()
            for way in ways:
                for x, y in zip(way, way[1:]):
                    u, v = tuple(x), tuple(y)
                    graph.add_edge(u, v, weight=hav_m(u, v))
            _LOCAL_DRIVE_GRAPHS[cache_key] = (graph, list(graph.nodes))
        graph, nodes = _LOCAL_DRIVE_GRAPHS[cache_key]

        def nearest(point: tuple[float, float]):
            node = min(
                nodes,
                key=lambda n: (n[0] - point[0]) ** 2 + (n[1] - point[1]) ** 2,
            )
            return node, hav_m(point, node)

        na, snap_a = nearest((a.lon, a.lat))
        nb, snap_b = nearest((b.lon, b.lat))
        if max(snap_a, snap_b) > float(corridor.get("max_snap_m", 600)):
            return None
        try:
            path = nx.shortest_path(graph, na, nb, weight="weight")
        except nx.NetworkXNoPath:
            return None
        length = sum(graph[u][v]["weight"] for u, v in zip(path, path[1:]))
        direct = hav_m((a.lon, a.lat), (b.lon, b.lat))
        if length > max(
            float(corridor.get("max_route_m", 12000)),
            direct * float(corridor.get("max_route_ratio", 4.5)),
        ):
            return None
        print(
            f"[local-road] {corridor['name']} {a.t:%H:%M:%S}–{b.t:%H:%M:%S} "
            f"direct={direct/1000:.2f}km road={length/1000:.2f}km",
            flush=True,
        )
        return path
    return None


def prepare_road_corridors(refresh: bool = False) -> None:
    points = filter_trip_points(parse_gpx())
    overrides = load_overrides()
    for corridor in overrides.get("road_corridors", []):
        cache_name = corridor.get("cache")
        if not cache_name:
            continue
        cache_path = CACHE_DIR / cache_name
        if cache_path.exists() and not refresh:
            print(f"[osm-drive] reuse {cache_name}", flush=True)
            continue
        start = datetime.fromisoformat(corridor["start"])
        end = datetime.fromisoformat(corridor["end"])
        selected = [point for point in points if start <= point.t <= end]
        if len(selected) < 2:
            print(f"[warn] no source points for road corridor {corridor['name']}")
            continue
        stem = cache_name.removesuffix(".ways.json")
        ways = overpass_drive_ways_cached(selected, stem, refresh=refresh)
        print(
            f"[osm-drive] prepared {cache_name} ways={len(ways)}",
            flush=True,
        )


def snap_walk_lightweight(points: list[Pt], name: str, refresh: bool = False) -> list[Pt]:
    from shapely.geometry import LineString, Point
    from shapely.ops import nearest_points

    ways = overpass_ways_cached(points, name, refresh=refresh)
    if not ways:
        print(f"[warn] no OSM ways for {name}", flush=True)
        return points
    lines = [LineString(w) for w in ways if len(w) >= 2]
    out: list[Pt] = []
    max_deg = 0.0012  # about 100-130m here; beyond this keep original GPX.
    for p in points:
        pt = Point(p.lon, p.lat)
        best = min(lines, key=lambda line: line.distance(pt))
        if best.distance(pt) <= max_deg:
            snapped = best.interpolate(best.project(pt))
            out.append(
                Pt(
                    t=p.t,
                    lon=float(snapped.x),
                    lat=float(snapped.y),
                    ele=p.ele,
                    source="navigation:osm",
                    generated=True,
                    derived_from=[p.source_id] if p.source_id else None,
                )
            )
        else:
            out.append(p)
    return densify_points(out, max_step_m=20)


def edge_geometry(G, u, v) -> list[tuple[float, float]]:
    data = min(G.get_edge_data(u, v).values(), key=lambda d: float(d.get("length", 1e9)))
    geom = data.get("geometry")
    if geom is not None:
        return [(float(x), float(y)) for x, y in geom.coords]
    return [(float(G.nodes[u]["x"]), float(G.nodes[u]["y"])), (float(G.nodes[v]["x"]), float(G.nodes[v]["y"]))]


def match_walk(points: list[Pt], name: str, refresh: bool = False) -> list[Pt]:
    if len(points) < 3:
        return points
    day_prefix = "_".join(name.split("_")[:2])
    has_same_day_cache = any(CACHE_DIR.glob(f"{day_prefix}_*.ways.json"))
    if not refresh and not has_same_day_cache and not (
        CACHE_DIR / f"{name}.graphml"
    ).exists():
        print(f"[warn] no cached walking network for {name}; keep GPX geometry", flush=True)
        return densify_points(points, max_step_m=20)
    import networkx as nx
    import osmnx as ox

    ox.settings.requests_timeout = 45
    ox.settings.overpass_rate_limit = True
    ox.settings.overpass_url = os.environ.get(
        "OVERPASS_URL", "https://overpass.kumi.systems/api/interpreter"
    )
    try:
        return snap_walk_lightweight(points, name, refresh=refresh)
    except Exception as e:
        print(f"[warn] lightweight snap failed {name}: {e}", flush=True)
    try:
        G = graph_from_bbox_cached(points, name, refresh=refresh)
        sample = points[:: max(1, len(points) // 35)]
        if sample[-1] is not points[-1]:
            sample.append(points[-1])
        nodes = ox.distance.nearest_nodes(G, X=[p.lon for p in sample], Y=[p.lat for p in sample])
        coords: list[tuple[float, float]] = []
        for a, b in zip(nodes, nodes[1:]):
            if a == b:
                continue
            try:
                path = nx.shortest_path(G, a, b, weight="length")
            except Exception:
                continue
            for u, v in zip(path, path[1:]):
                seg = edge_geometry(G, u, v)
                if coords and seg and coords[-1] == seg[0]:
                    coords.extend(seg[1:])
                else:
                    coords.extend(seg)
        if len(coords) < 2:
            return points

        # Interpolate timestamps/elevations along matched geometry.
        out: list[Pt] = []
        total = sum(hav_m(coords[i - 1], coords[i]) for i in range(1, len(coords))) or 1
        acc = 0.0
        t0, t1 = points[0].t, points[-1].t
        e0, e1 = points[0].ele, points[-1].ele
        derived = [p.source_id for p in (points[0], points[-1]) if p.source_id]
        out.append(
            Pt(
                t=t0,
                lon=coords[0][0],
                lat=coords[0][1],
                ele=e0,
                source="navigation:osm",
                generated=True,
                derived_from=derived or None,
            )
        )
        for i in range(1, len(coords)):
            acc += hav_m(coords[i - 1], coords[i])
            f = min(1.0, acc / total)
            out.append(
                Pt(
                    t=t0 + (t1 - t0) * f,
                    lon=coords[i][0],
                    lat=coords[i][1],
                    ele=(e0 + (e1 - e0) * f if e0 is not None and e1 is not None else e1),
                    source="navigation:osm",
                    generated=True,
                    derived_from=derived or None,
                )
            )
        return densify_points(out, max_step_m=25)
    except Exception as e:
        print(f"[warn] map-match failed {name}: {e}")
        return points


def build(
    refresh_osm: bool = False,
    summary_only: bool = False,
    max_clusters: int | None = None,
    include_regex: str | None = None,
    match_driving: bool = True,
) -> None:
    raw_points = parse_gpx()
    pts = filter_trip_points(raw_points)
    overrides = load_overrides()
    write_layer_inputs(raw_points, pts, overrides)
    drive_modes = stable_drive_modes(pts, overrides)
    clusters = segment_slow_clusters(pts)
    print(f"[gpx] points={len(pts)} slow_clusters={len(clusters)}", flush=True)
    if include_regex:
        rx = re.compile(include_regex)
        clusters = [
            (a, b)
            for a, b in clusters
            if rx.search(f"walk_{pts[a].t.strftime('%m%d_%H%M')}_{pts[b].t.strftime('%H%M')}")
        ]
    if max_clusters is not None:
        clusters = clusters[:max_clusters]

    # Manual walk ranges are authoritative; automatic slow clusters only propose walk
    # where the override file explicitly agrees.
    clusters = [
        (a, b)
        for a, b in clusters
        if all(override_mode(pts[k].t, overrides) == "walk" for k in range(a, b + 1))
    ]
    cluster_by_start = {a: (a, b) for a, b in clusters}
    i = 0
    out: list[dict] = []
    segments_summary: list[str] = []
    while i < len(pts):
        if i in cluster_by_start:
            a, b = cluster_by_start[i]
            raw = pts[a : b + 1]
            name = f"walk_{raw[0].t.strftime('%m%d_%H%M')}_{raw[-1].t.strftime('%H%M')}"
            print(
                f"[walk] {name} {raw[0].t:%m-%d %H:%M}–{raw[-1].t:%H:%M} raw={len(raw)}",
                flush=True,
            )
            matched = raw if summary_only else match_walk(raw, name, refresh=refresh_osm)
            use = matched
            use_modes = ["walk"] * len(use)
            i = b + 1
            segments_summary.append(
                f"- `{name}` {raw[0].t:%m-%d %H:%M}–{raw[-1].t:%H:%M} "
                f"raw={len(raw)} matched={len(matched)}"
            )
        else:
            mode = drive_modes[i]
            j = i + 1
            if mode == "walk":
                while (
                    j < len(pts)
                    and j not in cluster_by_start
                    and drive_modes[j] == "walk"
                ):
                    j += 1
                use = densify_points(pts[i:j], max_step_m=20)
                use_modes = ["walk"] * len(use)
                i = j
            else:
                raw_start = i
                # Road geometry is independent of cinematic fast/slow labels, so keep
                # one continuous routing request across those camera-mode boundaries.
                while (
                    j < len(pts)
                    and j not in cluster_by_start
                    and drive_modes[j] != "walk"
                    and (pts[j].t - pts[j - 1].t).total_seconds() <= 90 * 60
                ):
                    j += 1
                raw_drive = pts[i:j]
                drive_name = (
                    f"drive_{raw_drive[0].t.strftime('%m%d_%H%M')}_"
                    f"{raw_drive[-1].t.strftime('%H%M')}"
                )
                use = (
                    densify_points(raw_drive, max_step_m=150)
                    if summary_only
                    else match_drive_osrm(
                        raw_drive, drive_name, allow_download=match_driving
                    )
                )
                use_modes = []
                q = 0
                for routed_point in use:
                    while q + 1 < len(raw_drive) and abs(
                        (raw_drive[q + 1].t - routed_point.t).total_seconds()
                    ) <= abs((raw_drive[q].t - routed_point.t).total_seconds()):
                        q += 1
                    use_modes.append(drive_modes[raw_start + q])
                i = j
        for p, point_mode in zip(use, use_modes):
            out.append(point_record(p, point_mode))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sleep_events = build_sleep_events(pts, overrides)
    out = bridge_movement_gaps(out, allow_download=match_driving)
    out = remove_sleep_intervals(out, sleep_events)
    write_navigation_layer(out)
    out = apply_geometry_edits(out, overrides.get("geometry_edits", []))
    # Do not let a single sparse GPS sample create a visible camera flash.
    for k in range(1, len(out) - 1):
        if (
            out[k]["mode"] in {"drive_fast", "drive_slow"}
            and out[k - 1]["mode"] != out[k]["mode"]
            and out[k + 1]["mode"] != out[k]["mode"]
        ):
            out[k]["mode"] = out[k + 1]["mode"]
    # Compact contiguous segments make playback/camera decisions deterministic.
    segments = build_segments(out)
    payload = {
        "schema_version": 2,
        "data_model": {
            "raw": "route_data/source/raw-track.json",
            "editorial_exclusions": "route_data/editorial/exclusions.json",
            "editorial_anchors": "route_data/editorial/anchors.json",
            "navigation": "route_data/navigation/matched-route.json",
            "rendered": "route_data/processed/route-data.json",
        },
        "generated_from": GPX.name,
        "point_count": len(out),
        "provenance": provenance_summary(out),
        "points": out,
        "segments": segments,
        "events": sleep_events,
        "camera_ranges": overrides.get("camera_ranges", []),
        "title_cards": overrides.get("title_cards", []),
        "city_walk_ranges": overrides.get("city_walk_ranges", []),
        "supply_events": overrides.get("supply_events", []),
        "media_events": overrides.get("media_events", []),
        "story_events": overrides.get("story_events", []),
        "camera_directives": overrides.get("camera_directives", []),
        "preview_regions": overrides.get("preview_regions", []),
        "tunnel_ranges": overrides.get("tunnel_ranges", []),
        "route_connections": materialize_route_connections(overrides),
    }
    (OUT_DIR / "route-data.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    (OUT_DIR / "route-data.js").write_text(
        "window.ROUTE_DATA=" + json.dumps(payload, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    (OUT_DIR / "route-segments-summary.md").write_text(
        "# Route Processing Summary\n\n" + "\n".join(segments_summary) + "\n",
        encoding="utf-8",
    )
    print(f"[ok] wrote {OUT_DIR/'route-data.json'} points={len(out)}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-osm", action="store_true", help="redownload OSM cache")
    ap.add_argument("--summary-only", action="store_true", help="do not download OSM, only summarize slow clusters")
    ap.add_argument("--max-clusters", type=int, default=None, help="process only first N slow clusters")
    ap.add_argument("--include-regex", default=None, help="only process slow clusters whose generated name matches regex")
    ap.add_argument(
        "--no-driving-match",
        action="store_true",
        help="do not download missing OSRM driving geometry; cached geometry is still reused",
    )
    ap.add_argument(
        "--events-only",
        action="store_true",
        help="reuse processed geometry and refresh only hand-maintained event metadata",
    )
    ap.add_argument(
        "--geometry-edits-only",
        action="store_true",
        help="apply hand-maintained geometry edits to processed route without rematching roads",
    )
    ap.add_argument(
        "--prepare-road-corridors",
        action="store_true",
        help="download/cache OSM driving ways for configured road corridors",
    )
    args = ap.parse_args()
    if args.prepare_road_corridors:
        prepare_road_corridors(refresh=args.refresh_osm)
        return
    if args.events_only or args.geometry_edits_only:
        route_path = OUT_DIR / "route-data.json"
        payload = json.loads(route_path.read_text(encoding="utf-8"))
        overrides = json.loads(OVERRIDES.read_text(encoding="utf-8"))
        raw_points = parse_gpx()
        trip_points = filter_trip_points(raw_points)
        write_layer_inputs(raw_points, trip_points, overrides)
        if args.geometry_edits_only:
            navigation_path = NAVIGATION_DIR / "matched-route.json"
            if not navigation_path.exists():
                raise SystemExit(
                    "navigation/matched-route.json is missing; run a full route build first"
                )
            navigation_payload = json.loads(
                navigation_path.read_text(encoding="utf-8")
            )
            payload["points"] = apply_geometry_edits(
                navigation_payload["points"], overrides.get("geometry_edits", [])
            )
            payload["points"] = apply_mode_overrides(payload["points"], overrides)
            payload["point_count"] = len(payload["points"])
            payload["segments"] = build_segments(payload["points"])
            payload["provenance"] = provenance_summary(payload["points"])
        for key in EVENT_OVERRIDE_KEYS:
            payload[key] = overrides.get(key, [])
        payload["events"] = build_sleep_events(trip_points, overrides)
        payload["route_connections"] = materialize_route_connections(overrides)
        route_path.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        (OUT_DIR / "route-data.js").write_text(
            "window.ROUTE_DATA=" + json.dumps(payload, ensure_ascii=False) + ";\n",
            encoding="utf-8",
        )
        print(
            f"[ok] refreshed {'geometry and ' if args.geometry_edits_only else ''}"
            f"event metadata in {route_path} points={payload['point_count']} "
            f"media={len(payload['media_events'])}",
            flush=True,
        )
        return
    build(
        refresh_osm=args.refresh_osm,
        summary_only=args.summary_only,
        max_clusters=args.max_clusters,
        include_regex=args.include_regex,
        match_driving=not args.no_driving_match,
    )


if __name__ == "__main__":
    main()
