#!/usr/bin/env python3
"""Build an hour-by-hour location table from the final rendered route."""

from __future__ import annotations

import argparse
import bisect
import json
import math
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path


BASE = Path(__file__).resolve().parents[1]
ROUTE = BASE / "route_data/processed/route-data.json"
MAP_CONTENT = BASE / "route_data/map-content.js"
CACHE = BASE / "route_data/editorial/hourly-geocodes.json"
OUTPUT = BASE / "逐小时时间地点表.md"
MODE_LABELS = {
    "walk": "步行",
    "drive_slow": "慢速行车/观景",
    "drive_fast": "行车",
    "sleep": "住宿",
    "inferred": "停留（推断）",
}


def hav_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    q = math.pi / 180
    x = (
        math.sin((b[1] - a[1]) * q / 2) ** 2
        + math.cos(a[1] * q)
        * math.cos(b[1] * q)
        * math.sin((b[0] - a[0]) * q / 2) ** 2
    )
    return 6371008.8 * 2 * math.asin(math.sqrt(x))


def load_landmarks() -> list[tuple[str, tuple[float, float]]]:
    text = MAP_CONTENT.read_text(encoding="utf-8")
    pattern = re.compile(
        r'name:\s*"([^"]+)"[\s\S]{0,180}?lonlat:\s*\[\s*([\d.]+),\s*([\d.]+)\s*\]'
    )
    return [
        (name, (float(lon), float(lat)))
        for name, lon, lat in pattern.findall(text)
    ]


def nearest_landmark(
    lonlat: tuple[float, float], landmarks: list[tuple[str, tuple[float, float]]]
) -> tuple[str, float] | None:
    if not landmarks:
        return None
    name, coord = min(landmarks, key=lambda item: hav_m(lonlat, item[1]))
    distance = hav_m(lonlat, coord)
    return (name, distance) if distance <= 8000 else None


def cache_key(lon: float, lat: float) -> str:
    return f"{lon:.5f},{lat:.5f}"


def reverse_geocode(lon: float, lat: float) -> dict:
    query = urllib.parse.urlencode(
        {
            "lat": f"{lat:.6f}",
            "lon": f"{lon:.6f}",
            "format": "jsonv2",
            "accept-language": "zh-CN,zh,en",
            "zoom": 12,
            "addressdetails": 1,
        }
    )
    request = urllib.request.Request(
        f"https://nominatim.openstreetmap.org/reverse?{query}",
        headers={"User-Agent": "TibetVlogHourlyTimeline/1.0 (local editorial tool)"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def address_label(payload: dict) -> str:
    address = payload.get("address", {})
    locality = next(
        (
            address.get(key)
            for key in (
                "village",
                "town",
                "municipality",
                "hamlet",
                "locality",
                "suburb",
            )
            if address.get(key)
        ),
        None,
    )
    county = address.get("county") or address.get("city_district")
    city = address.get("city") or address.get("state_district")
    parts = []
    for value in (city, county, locality):
        if value and value not in parts and value not in ("中国", "西藏自治区"):
            parts.append(value)
    return " · ".join(parts) or payload.get("display_name", "位置待核").split(",")[0]


def floor_hour(value: datetime) -> datetime:
    return value.replace(minute=0, second=0, microsecond=0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true", help="Fetch missing OSM labels")
    args = parser.parse_args()

    data = json.loads(ROUTE.read_text(encoding="utf-8"))
    points = data["points"]
    for point in points:
        point["_dt"] = datetime.fromisoformat(point["time"])
    sleeps = [
        {**event, "_start": datetime.fromisoformat(event["start"]), "_end": datetime.fromisoformat(event["end"])}
        for event in data.get("events", [])
        if event.get("mode") == "sleep"
    ]
    landmarks = load_landmarks()
    geocodes = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}

    rows = []
    first_day = points[0]["_dt"].date()
    last_day = points[-1]["_dt"].date()
    day = first_day
    while day <= last_day:
        day_points = [point for point in points if point["_dt"].date() == day]
        day_start = datetime.combine(day, datetime.min.time(), points[0]["_dt"].tzinfo)
        day_end = day_start + timedelta(days=1)
        day_sleeps = [
            event for event in sleeps if event["_start"] < day_end and event["_end"] > day_start
        ]
        if day_points or day_sleeps:
            start_candidates = [day_points[0]["_dt"]] if day_points else []
            end_candidates = [day_points[-1]["_dt"]] if day_points else []
            start_candidates += [max(event["_start"], day_start) for event in day_sleeps]
            end_candidates += [min(event["_end"], day_end) for event in day_sleeps]
            start_hour = floor_hour(min(start_candidates))
            end_marker = max(end_candidates)
            end_hour = floor_hour(end_marker - timedelta(microseconds=1))
            hour = start_hour
            while hour <= end_hour:
                next_hour = hour + timedelta(hours=1)
                in_hour = [p for p in day_points if hour <= p["_dt"] < next_hour]
                sleep = next(
                    (event for event in sleeps if event["_start"] < next_hour and event["_end"] > hour),
                    None,
                )
                if in_hour:
                    midpoint = hour + timedelta(minutes=30)
                    point = min(in_hour, key=lambda p: abs((p["_dt"] - midpoint).total_seconds()))
                    modes = Counter(p.get("mode", "drive_fast") for p in in_hour)
                    mode = modes.most_common(1)[0][0]
                    rows.append({"day": day, "hour": hour, "point": point, "mode": mode, "sleep": None})
                elif sleep:
                    rows.append({"day": day, "hour": hour, "point": None, "mode": "sleep", "sleep": sleep})
                else:
                    rows.append({"day": day, "hour": hour, "point": None, "mode": "missing", "sleep": None})
                hour = next_hour
        day += timedelta(days=1)

    # Fill short recording gaps only when the known positions on both sides are
    # close enough to support a conservative "stayed nearby" inference.
    for index, row in enumerate(rows):
        if row["mode"] != "missing":
            continue
        previous = next((r for r in reversed(rows[:index]) if r.get("point")), None)
        following = next((r for r in rows[index + 1 :] if r.get("point")), None)
        if not previous or not following:
            continue
        before = previous["point"]
        after = following["point"]
        gap_hours = (following["hour"] - previous["hour"]).total_seconds() / 3600
        separation = hav_m((before["lon"], before["lat"]), (after["lon"], after["lat"]))
        if gap_hours <= 6 and separation <= 15000:
            row["point"] = before
            row["mode"] = "inferred"
            row["inferred"] = True

    missing = []
    for row in rows:
        point = row["point"]
        if not point:
            continue
        key = cache_key(point["lon"], point["lat"])
        if key not in geocodes:
            missing.append((key, point["lon"], point["lat"]))
    if missing and not args.fetch:
        raise SystemExit(f"missing {len(missing)} geocodes; rerun with --fetch")
    for index, (key, lon, lat) in enumerate(missing, 1):
        geocodes[key] = reverse_geocode(lon, lat)
        print(f"[geocode] {index}/{len(missing)} {key}", flush=True)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(geocodes, ensure_ascii=False, indent=2), encoding="utf-8")
        if index < len(missing):
            time.sleep(1.05)

    lines = [
        "# 西藏边境线 · 逐小时时间地点表",
        "",
        "> 基于网页当前使用的最终修正轨迹生成；时间为北京时间（UTC+8）。每小时取该小时内最接近 `HH:30` 的轨迹点作为代表位置。地名优先使用项目关键地点，其他地点使用 OpenStreetMap 逆地理编码。",
        "",
        "> `附近` 表示代表坐标距项目地标不超过 8 km；山区道路跨越范围较大，表格用于剪辑定位，不替代行政区划核验。",
        "",
    ]
    current_day = None
    for row in rows:
        if row["day"] != current_day:
            current_day = row["day"]
            lines += [
                f"## {current_day:%Y-%m-%d}",
                "",
                "| 时间段 | 大致位置 | 状态 | 海拔 | 代表 GPS |",
                "|---|---|---|---:|---|",
            ]
        hour = row["hour"]
        time_range = f"{hour:%H}:00–{(hour + timedelta(hours=1)):%H}:00"
        if row["sleep"]:
            event = row["sleep"]
            lon, lat = event["lonlat"]
            location = f"{event['name']}（住宿）"
            altitude = "—"
            gps = f"`[{lon:.6f}, {lat:.6f}]`"
        elif row["mode"] == "missing":
            location = "轨迹记录缺失"
            altitude = "—"
            gps = "—"
        else:
            point = row["point"]
            lon, lat = point["lon"], point["lat"]
            location = address_label(geocodes[cache_key(lon, lat)])
            landmark = nearest_landmark((lon, lat), landmarks)
            if landmark:
                location = f"{landmark[0]}附近 · {location}"
            if row.get("inferred"):
                location += "（按前后轨迹推断）"
            altitude = f"{round(point['alt'])} m" if point.get("alt") is not None else "—"
            gps = f"`[{lon:.6f}, {lat:.6f}]`"
        lines.append(
            f"| {time_range} | {location} | {MODE_LABELS.get(row['mode'], '无轨迹')} | {altitude} | {gps} |"
        )
    lines += [
        "",
        "## 住宿时间",
        "",
        "| 地点 | 开始 | 结束 |",
        "|---|---|---|",
    ]
    for event in sleeps:
        lines.append(f"| {event['name']} | {event['_start']:%m-%d %H:%M} | {event['_end']:%m-%d %H:%M} |")
    lines += [
        "",
        "地名数据：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，通过 Nominatim 逆地理编码获取。",
        "",
    ]
    OUTPUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"[ok] rows={len(rows)} output={OUTPUT}")


if __name__ == "__main__":
    main()
