#!/usr/bin/env python3
"""Render satellite review images for windows selected by audit_route_windows.py."""

from __future__ import annotations

import argparse
import io
import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont


BASE = Path(__file__).resolve().parents[1]
AUDIT = BASE / "route_data/analysis/ten-minute-road-audit.json"
FINAL = BASE / "route_data/processed/route-data.json"
RAW = BASE / "route_data/source/raw-track.json"
OUTPUT = BASE / "route_data/analysis/screenshots"
TILE_CACHE = BASE / "cache/route_audit_tiles"
TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
WIDTH, HEIGHT = 1600, 1000
HEADER_H = 112


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value)


def world_pixel(coord, zoom: int):
    lon, lat = coord
    scale = 256 * (2**zoom)
    x = (lon + 180) / 360 * scale
    sin_lat = math.sin(math.radians(max(-85.05112878, min(85.05112878, lat))))
    y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * scale
    return x, y


def choose_zoom(coords) -> int:
    for zoom in range(17, 5, -1):
        pixels = [world_pixel(coord, zoom) for coord in coords]
        span_x = max(item[0] for item in pixels) - min(item[0] for item in pixels)
        span_y = max(item[1] for item in pixels) - min(item[1] for item in pixels)
        if span_x <= WIDTH - 160 and span_y <= HEIGHT - HEADER_H - 120:
            return zoom
    return 6


def font(size: int, bold: bool = False):
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size, index=1 if bold and "PingFang" in candidate else 0)
    return ImageFont.load_default()


def get_tile(session, zoom: int, x: int, y: int):
    wrapped_x = x % (2**zoom)
    cache = TILE_CACHE / str(zoom) / str(wrapped_x) / f"{y}.jpg"
    if cache.exists():
        return Image.open(cache).convert("RGB")
    response = session.get(TILE_URL.format(z=zoom, x=wrapped_x, y=y), timeout=20)
    response.raise_for_status()
    image = Image.open(io.BytesIO(response.content)).convert("RGB")
    cache.parent.mkdir(parents=True, exist_ok=True)
    image.save(cache, quality=92)
    return image


def draw_path(draw, points, origin, zoom, fill, width):
    if len(points) < 2:
        return
    pixels = []
    for point in points:
        x, y = world_pixel((point["lon"], point["lat"]), zoom)
        pixels.append((x - origin[0], y - origin[1]))
    draw.line(pixels, fill=(0, 0, 0, 190), width=width + 4, joint="curve")
    draw.line(pixels, fill=fill, width=width, joint="curve")


def render(window, final_points, raw_points, session):
    start, end = parse_time(window["start"]), parse_time(window["end"])
    context_start, context_end = start - timedelta(minutes=5), end + timedelta(minutes=5)
    selected = [point for point in final_points if start <= point["_dt"] <= end]
    context = [point for point in final_points if context_start <= point["_dt"] <= context_end]
    raw = [point for point in raw_points if context_start <= point["_dt"] <= context_end]
    fit_points = context + raw + selected
    if not fit_points:
        raise ValueError(f"No route points in {window['id']}")
    coords = [(point["lon"], point["lat"]) for point in fit_points]
    zoom = choose_zoom(coords)
    world = [world_pixel(coord, zoom) for coord in coords]
    center = ((min(x for x, _ in world) + max(x for x, _ in world)) / 2,
              (min(y for _, y in world) + max(y for _, y in world)) / 2)
    origin = (center[0] - WIDTH / 2, center[1] - (HEIGHT + HEADER_H) / 2)
    image = Image.new("RGB", (WIDTH, HEIGHT), "#111a22")
    min_tx, max_tx = math.floor(origin[0] / 256), math.floor((origin[0] + WIDTH) / 256)
    min_ty, max_ty = math.floor(origin[1] / 256), math.floor((origin[1] + HEIGHT) / 256)
    tiles = [
        (tile_x, tile_y)
        for tile_x in range(min_tx, max_tx + 1)
        for tile_y in range(min_ty, max_ty + 1)
        if 0 <= tile_y < 2**zoom
    ]
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(get_tile, session, zoom, tile_x, tile_y): (tile_x, tile_y)
            for tile_x, tile_y in tiles
        }
        for future in as_completed(futures):
            tile_x, tile_y = futures[future]
            tile = future.result()
            image.paste(tile, (round(tile_x * 256 - origin[0]), round(tile_y * 256 - origin[1])))
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw_path(draw, context, origin, zoom, (75, 206, 255, 210), 3)
    draw_path(draw, raw, origin, zoom, (255, 225, 74, 235), 4)
    draw_path(draw, selected, origin, zoom, (255, 59, 48, 255), 7)
    draw.rectangle((0, 0, WIDTH, HEADER_H), fill=(8, 12, 17, 225))
    title = f"{start:%m-%d %H:%M} — {end:%H:%M}  ·  {window['profile']}  ·  z{zoom}"
    draw.text((24, 15), title, font=font(30, True), fill="white")
    reason = "；".join(window["reasons"])
    draw.text((24, 57), reason[:88], font=font(18), fill=(255, 180, 174))
    draw.text((1120, 23), "━ 最终路线", font=font(18, True), fill=(255, 59, 48))
    draw.text((1280, 23), "━ 原始 GPS", font=font(18, True), fill=(255, 225, 74))
    draw.text((1440, 23), "━ 前后语境", font=font(18, True), fill=(75, 206, 255))
    draw.text((1120, 60), f"最终点 {len(selected)} · GPS点 {len(raw)}", font=font(17), fill=(225, 230, 235))
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def build_contact_sheets(paths):
    sheet_paths = []
    for sheet_index, offset in enumerate(range(0, len(paths), 12), 1):
        batch = paths[offset : offset + 12]
        sheet = Image.new("RGB", (1600, 750), "#101820")
        for index, path in enumerate(batch):
            image = Image.open(path).convert("RGB")
            image.thumbnail((400, 250), Image.Resampling.LANCZOS)
            x, y = (index % 4) * 400, (index // 4) * 250
            sheet.paste(image, (x, y))
        output = OUTPUT / f"contact-sheet-{sheet_index:02d}.jpg"
        sheet.save(output, quality=90)
        sheet_paths.append(output)
    return sheet_paths


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--contact-only", action="store_true")
    parser.add_argument("--ids", help="Comma-separated audit window IDs to render")
    args = parser.parse_args()
    audit = json.loads(AUDIT.read_text(encoding="utf-8"))
    final_points = json.loads(FINAL.read_text(encoding="utf-8"))["points"]
    raw_points = [point for point in json.loads(RAW.read_text(encoding="utf-8"))["points"] if point.get("accepted", True)]
    for point in final_points:
        point["_dt"] = parse_time(point["time"])
    for point in raw_points:
        point["_dt"] = parse_time(point["time"])
    requested_ids = set(args.ids.split(",")) if args.ids else None
    pool = (
        (item for item in audit["windows"] if item["id"] in requested_ids)
        if requested_ids is not None
        else (item for item in audit["windows"] if item.get("screenshot_requested"))
    )
    windows = sorted(
        pool, key=lambda item: (item["severity"] == "error", item["score"]), reverse=True,
    )[: args.limit]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.contact_only:
        existing = [OUTPUT / f"{item['id']}.png" for item in windows]
        sheets = build_contact_sheets([path for path in existing if path.exists()])
        print(f"[ok] contact_sheets={len(sheets)}")
        return
    session = requests.Session()
    session.headers["User-Agent"] = "TibetRouteAudit/1.0"
    failures = []
    for index, window in enumerate(windows, 1):
        output = OUTPUT / f"{window['id']}.png"
        try:
            image = render(window, final_points, raw_points, session)
            image.save(output, quality=94)
            print(f"[{index:02d}/{len(windows):02d}] {output.relative_to(BASE)}")
        except Exception as error:
            failures.append({"id": window["id"], "error": str(error)})
    if failures:
        print(json.dumps(failures, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    sheets = build_contact_sheets([OUTPUT / f"{window['id']}.png" for window in windows])
    print(f"[ok] screenshots={len(windows)} output={OUTPUT}")
    print(f"[ok] contact_sheets={len(sheets)}")


if __name__ == "__main__":
    main()
