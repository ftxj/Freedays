#!/usr/bin/env python3
"""Audit the final route in ten-minute windows without modifying geometry."""

from __future__ import annotations

import argparse
import bisect
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path


BASE = Path(__file__).resolve().parents[1]
FINAL = BASE / "route_data/processed/route-data.json"
RAW = BASE / "route_data/source/raw-track.json"
CONFIG = BASE / "route_data/route-audit-config.json"
JSON_OUT = BASE / "route_data/analysis/ten-minute-road-audit.json"
MD_OUT = BASE / "十分钟道路吸附检查.md"


def hav_m(a, b) -> float:
    q = math.pi / 180
    x = (
        math.sin((b[1] - a[1]) * q / 2) ** 2
        + math.cos(a[1] * q)
        * math.cos(b[1] * q)
        * math.sin((b[0] - a[0]) * q / 2) ** 2
    )
    return 6371008.8 * 2 * math.asin(math.sqrt(x))


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * q))
    return ordered[index]


def point_segment_m(point, start, end) -> float:
    lat = math.radians(point[1])
    scale_x = 111000 * math.cos(lat)
    px, py = point[0] * scale_x, point[1] * 111000
    ax, ay = start[0] * scale_x, start[1] * 111000
    bx, by = end[0] * scale_x, end[1] * 111000
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    fraction = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + fraction * dx), py - (ay + fraction * dy))


def distance_to_corridor(point, raw_points) -> float | None:
    coords = [(item["lon"], item["lat"]) for item in raw_points]
    if not coords:
        return None
    if len(coords) == 1:
        return hav_m(point, coords[0])
    return min(point_segment_m(point, coords[index - 1], coords[index]) for index in range(1, len(coords)))


def turn_angle(a, b, c) -> float:
    lat = math.radians(b[1])
    v1 = ((a[0] - b[0]) * math.cos(lat), a[1] - b[1])
    v2 = ((c[0] - b[0]) * math.cos(lat), c[1] - b[1])
    n1, n2 = math.hypot(*v1), math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return 0
    cosine = max(-1, min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    interior = math.degrees(math.acos(cosine))
    return 180 - interior


def simplify_by_distance(coords, minimum_m: float):
    """Drop dense animation interpolation before looking for visual corners."""
    if len(coords) <= 2:
        return coords
    kept = [coords[0]]
    for coord in coords[1:-1]:
        if hav_m(kept[-1], coord) >= minimum_m:
            kept.append(coord)
    if kept[-1] != coords[-1]:
        kept.append(coords[-1])
    return kept


def path_distance(coords) -> float:
    return sum(hav_m(coords[index - 1], coords[index]) for index in range(1, len(coords)))


def profile_for(points, config):
    modes = Counter(point.get("mode", "drive_fast") for point in points)
    mode = modes.most_common(1)[0][0]
    midpoint = points[len(points) // 2]
    moment = midpoint["_dt"]
    coord = (midpoint["lon"], midpoint["lat"])
    for zone in config.get("offroad_zones", []):
        if datetime.fromisoformat(zone["start"]) <= moment <= datetime.fromisoformat(zone["end"]):
            if hav_m(coord, zone["center"]) <= zone["radius_m"]:
                return "offroad", mode, zone["name"]
    return ("walk" if mode == "walk" else "drive"), mode, None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshot-limit", type=int, default=30)
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    final = json.loads(FINAL.read_text(encoding="utf-8"))["points"]
    raw = json.loads(RAW.read_text(encoding="utf-8"))["points"]
    for point in final:
        point["_dt"] = datetime.fromisoformat(point["time"])
    raw = [point for point in raw if point.get("accepted", True)]
    for point in raw:
        point["_dt"] = datetime.fromisoformat(point["time"])
    raw_times = [point["_dt"] for point in raw]
    raw_by_day = defaultdict(list)
    for point in raw:
        raw_by_day[point["_dt"].date()].append(point)

    minutes = int(config.get("window_minutes", 10))
    grouped = defaultdict(list)
    for point in final:
        moment = point["_dt"]
        start = moment.replace(minute=(moment.minute // minutes) * minutes, second=0, microsecond=0)
        grouped[start].append(point)

    results = []
    for start, points in sorted(grouped.items()):
        end = start + timedelta(minutes=minutes)
        profile, mode, exception = profile_for(points, config)
        thresholds = config["profiles"][profile]
        sample_step = max(1, len(points) // 30)
        gps_offsets, raw_gaps = [], []
        overlap = timedelta(seconds=int(config.get("overlap_seconds", 60)))
        left = max(0, bisect.bisect_left(raw_times, start - overlap) - 1)
        right = min(len(raw), bisect.bisect_right(raw_times, end + overlap) + 1)
        raw_window = raw[left:right]
        raw_corridor = raw_by_day[start.date()]
        raw_gaps = [
            (raw_window[index]["_dt"] - raw_window[index - 1]["_dt"]).total_seconds()
            for index in range(1, len(raw_window))
        ]
        for point in points[::sample_step]:
            offset = distance_to_corridor((point["lon"], point["lat"]), raw_corridor)
            if offset is not None:
                gps_offsets.append(offset)
        coords = [(point["lon"], point["lat"]) for point in points]
        simplified = simplify_by_distance(coords, 8 if profile == "walk" else 25)
        angles = [
            turn_angle(simplified[i - 1], simplified[i], simplified[i + 1])
            for i in range(1, len(simplified) - 1)
        ]
        sharp_count = sum(angle >= thresholds["sharp_turn_warn_deg"] for angle in angles)
        extreme_turn_count = sum(angle >= 165 for angle in angles)
        travelled_m = path_distance(simplified)
        displacement_m = hav_m(simplified[0], simplified[-1]) if len(simplified) > 1 else 0
        detour_ratio = travelled_m / max(displacement_m, 50)
        reviewed_fraction = sum(
            any(str(item).startswith("geometry:") for item in point.get("derived_from", []))
            for point in points
        ) / len(points)
        navigation_fraction = sum(
            str(point.get("source", "")).startswith("navigation:") for point in points
        ) / len(points)
        local_osm_fraction = sum(point.get("source") == "navigation:osm" for point in points) / len(points)
        # Navigation vertices are separated by dense `rendered` interpolation,
        # so even a fully OSRM/OSM-matched window may contain only 10-40%
        # navigation-labelled points. Presence above 10% is sufficient evidence
        # that the geometry came from the road graph.
        trusted_geometry = reviewed_fraction >= 0.5 or navigation_fraction >= 0.1
        p95 = percentile(gps_offsets, 0.95)
        max_gap = max(raw_gaps, default=0)
        reasons = []
        severity = "ok"
        # A reviewed/navigation path often redistributes timestamps between sparse
        # GPS anchors. Its distance from the raw trace is useful context, but is
        # not evidence that it is off-road. Only weak-provenance geometry may be
        # escalated by this metric.
        if not trusted_geometry and p95 is not None and p95 >= thresholds["gps_p95_error_m"]:
            severity, reasons = "error", [f"未审核路线P95偏离原始GPS {p95:.0f}m"]
        elif not trusted_geometry and p95 is not None and p95 >= thresholds["gps_p95_warn_m"]:
            severity, reasons = "warn", [f"未审核路线P95偏离原始GPS {p95:.0f}m"]
        if max_gap >= thresholds["raw_gap_warn_s"]:
            if (
                severity == "ok"
                and not trusted_geometry
                and p95 is not None
                and p95 >= thresholds["gps_p95_warn_m"]
            ):
                severity = "warn"
            if severity != "ok" and not trusted_geometry:
                reasons.append(f"原始GPS空档 {max_gap/60:.1f}min")
        if (
            profile != "offroad"
            and not trusted_geometry
            and (extreme_turn_count >= 1 or sharp_count >= 3)
        ):
            if severity == "ok": severity = "warn"
            reasons.append(f"尖锐转角 {sharp_count} 个（近折返 {extreme_turn_count} 个）")
        if profile != "offroad" and not trusted_geometry and travelled_m >= 500 and detour_ratio >= 3.5:
            if severity == "ok": severity = "warn"
            reasons.append(f"绕行比 {detour_ratio:.1f}x")
        if (
            profile == "drive"
            and travelled_m >= 500
            and reviewed_fraction < 0.5
            and navigation_fraction < 0.1
            and p95 is not None
            and p95 >= thresholds["gps_p95_warn_m"]
        ):
            if severity == "ok": severity = "warn"
            reasons.append("缺少道路匹配来源")
        if exception:
            reasons.append(f"越野例外：{exception}")
        if travelled_m < 100:
            severity = "ok"
            reasons = []
        window_id = start.strftime("%Y%m%d-%H%M")
        review_note = config.get("accepted_windows", {}).get(window_id)
        if review_note:
            severity = "ok"
            reasons = []
        score = (
            (0 if trusted_geometry else (p95 or 0))
            + (0 if trusted_geometry else max_gap / 5)
            + sharp_count * 45
            + extreme_turn_count * 180
            + (max(0, detour_ratio - 1) * 60 if not trusted_geometry else 0)
        )
        results.append(
            {
                "id": window_id,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "profile": profile,
                "mode": mode,
                "severity": severity,
                "score": round(score, 1),
                "reasons": reasons,
                "review_note": review_note,
                "metrics": {
                    "point_count": len(points),
                    "gps_offset_median_m": round(percentile(gps_offsets, 0.5) or 0, 1),
                    "gps_offset_p95_m": round(p95 or 0, 1),
                    "gps_offset_max_m": round(max(gps_offsets, default=0), 1),
                    "raw_gap_max_s": round(max_gap, 1),
                    "sharp_turn_count": sharp_count,
                    "extreme_turn_count": extreme_turn_count,
                    "travelled_m": round(travelled_m, 1),
                    "displacement_m": round(displacement_m, 1),
                    "detour_ratio": round(detour_ratio, 2),
                    "reviewed_fraction": round(reviewed_fraction, 3),
                    "navigation_fraction": round(navigation_fraction, 3),
                    "local_osm_fraction": round(local_osm_fraction, 3),
                    "trusted_geometry": trusted_geometry,
                },
                "center": [points[len(points) // 2]["lon"], points[len(points) // 2]["lat"]],
            }
        )

    candidates = sorted(
        (result for result in results if result["severity"] != "ok"),
        key=lambda result: (result["severity"] == "error", result["score"]),
        reverse=True,
    )
    screenshot_ids = {result["id"] for result in candidates[: args.screenshot_limit]}
    for result in results:
        result["screenshot_requested"] = result["id"] in screenshot_ids
    payload = {
        "generated_at": datetime.now().astimezone().isoformat(),
        "window_minutes": minutes,
        "window_count": len(results),
        "candidate_count": len(candidates),
        "screenshot_count": len(screenshot_ids),
        "windows": results,
    }
    JSON_OUT.parent.mkdir(parents=True, exist_ok=True)
    JSON_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# 十分钟道路吸附检查",
        "",
        "> 自动审计只生成候选，不直接修改路线。P95 GPS 偏移用于筛选，最终以卫星图截图复核为准。",
        "",
        f"- 总窗口：{len(results)}",
        f"- 待复核：{len(candidates)}",
        f"- 首批截图：{len(screenshot_ids)}",
        "",
        "| 等级 | 时间 | 类型 | P95偏移 | GPS空档 | 来源 | 原因 | 截图 |",
        "|---|---|---|---:|---:|---|---|---|",
    ]
    for result in candidates:
        metrics = result["metrics"]
        source = f"审核{metrics['reviewed_fraction']:.0%} / 导航{metrics['navigation_fraction']:.0%}"
        shot = f"`route_data/analysis/screenshots/{result['id']}.png`" if result["screenshot_requested"] else "—"
        lines.append(
            f"| {result['severity']} | {result['start'][5:16].replace('T', ' ')} | {result['profile']} | "
            f"{metrics['gps_offset_p95_m']:.0f}m | {metrics['raw_gap_max_s']/60:.1f}min | {source} | "
            f"{'；'.join(result['reasons'])} | {shot} |"
        )
    MD_OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[ok] windows={len(results)} candidates={len(candidates)} screenshots={len(screenshot_ids)}")
    print(f"[ok] json={JSON_OUT}")
    print(f"[ok] markdown={MD_OUT}")


if __name__ == "__main__":
    main()
