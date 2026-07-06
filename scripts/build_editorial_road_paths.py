#!/usr/bin/env python3
"""Build reviewed road-repair geometry used by route geometry_edits.

This script is intentionally separate from normal playback generation. It
downloads OSRM geometry once, validates the result, and stores a reproducible
editorial navigation layer in route_data/editorial/manual-paths.json.
"""

from __future__ import annotations

import json
import math
import os
import argparse
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path


BASE = Path(__file__).resolve().parents[1]
OUTPUT = BASE / "route_data" / "editorial" / "manual-paths.json"
OSRM = os.environ.get("OSRM_URL", "https://router.project-osrm.org")

FIXES = {
    "d22_remove_fold_1504": ((90.785103, 29.040084), (90.826688, 29.030005)),
    "d22_remove_folds_1541_1615": ((90.96438, 28.981209), (90.965689, 28.892111)),
    "d22_road_1625_1645": ((90.965689, 28.892111), (90.877759, 28.895397)),
    "d22_road_1837": ((90.917932, 28.387498), (90.849432, 28.388869)),
    "d23_road_1552_1610": ((90.642678, 28.347931), (90.637007, 28.359819)),
    "d23_road_1709_1712": ((90.539636, 28.471021), (90.542169, 28.484208)),
    "d24_road_1121_1125": ((89.657909, 28.226582), (89.657386, 28.2225)),
    "d24_road_1250": ((89.344149, 27.978136), (89.376938, 27.962922)),
    "d24_remove_fold_1804": ((88.244741, 28.058793), (88.253308, 28.141586)),
    "d25_remove_fold_1315": ((87.180948, 28.355472), (86.990473, 28.409699)),
    "d25_remove_fold_1750": ((86.95126, 28.374659), (86.897997, 28.309705)),
    "d25_road_1814": ((86.891373, 28.309059), (86.821463, 28.234561)),
    "d25_road_1954": ((86.821224, 28.215077), (86.868217, 28.308211)),
    "d26_road_1026": ((87.049807, 28.483973), (87.064082, 28.493504)),
    "d26_peiku_rebuild": ((85.772635, 28.700711), (85.486564, 28.823599)),
    "d26_road_1610": ((85.427693, 28.933214), (85.368868, 28.930052)),
    "d27_viewpoint_outbound": ((85.328561, 28.390808), (85.413226, 28.364131)),
    # Second review pass: user-identified folds and off-road rendering.
    "d22_fold_1536_review": ((90.947706, 29.008676), (91.006552, 28.963707)),
    "d22_fold_1502_full_review": ((90.766204, 29.058698), (90.834690, 29.031349)),
    "d22_road_1733_review": ((90.823063, 28.715253), (90.794535, 28.594658)),
    "d22_road_1145_1155_review": ((91.020625, 29.554572), (90.865573, 29.364593)),
    "d22_road_1203_review": ((90.860379, 29.360931), (90.717369, 29.356286)),
    "d22_airport_outbound_review": ((90.717369, 29.356286), (90.499628, 29.263594)),
    "d22_airport_return_review": ((90.499628, 29.263594), (90.693538, 29.356058)),
    "d23_road_1548_1610_review": ((90.672517, 28.372467), (90.636424, 28.361831)),
    "d23_road_1716_review": ((90.542404, 28.484180), (90.537441, 28.523929)),
    "d23_road_1735_review": ((90.537441, 28.523929), (90.442710, 28.624957)),
    "d23_road_1802_1815_review": ((90.436453, 28.625162), (90.304298, 28.621266)),
    "d23_road_1837_review": ((90.246046, 28.650638), (90.119015, 28.680084)),
    "d23_road_1855_review": ((90.119015, 28.680084), (90.060172, 28.706062)),
    "d23_road_1915_1930_review": ((89.925766, 28.704888), (89.781856, 28.539555)),
    "d24_road_1020_review": (
        (89.617501, 28.456340),
        # Force the reviewed route onto the satellite-visible G219 corridor.
        # Without this waypoint OSRM leaves the trunk road south of the village
        # and follows an eastern secondary line that is not visible on imagery.
        (89.530000, 28.359000),
        (89.559204, 28.308198),
    ),
    "d24_road_1039_review": ((89.559204, 28.308198), (89.615334, 28.267019)),
    "d24_road_1130_1142_review": ((89.657135, 28.220649), (89.541176, 28.339232)),
    "d24_road_1216_1231_review": ((89.364182, 28.176086), (89.291781, 27.979025)),
    "d24_lake_visit_review": (
        (89.377779, 27.962871),
        (89.378752, 27.967687),
        (89.204896, 27.965624),
    ),
    "d24_road_1356_review": ((89.204896, 27.965624), (89.074133, 28.037985)),
    "d24_road_1418_review": ((89.087231, 28.157156), (88.954263, 28.264538)),
    "d24_road_1605_review": ((88.266974, 28.146392), (88.243343, 28.043257)),
    "d24_road_1815_1828_review": ((88.253308, 28.141586), (88.199907, 28.188247)),
    "d24_road_1840_review": ((88.132020, 28.166301), (87.982545, 28.164916)),
    "d24_road_1910_review": ((87.726247, 28.167971), (87.692752, 28.128687)),
    "d24_d25_overnight_connection": ((87.752438, 28.230014), (87.766923, 28.367286)),
    "d25_road_1300_review": ((87.281130, 28.331400), (86.973420, 28.401483)),
    "d25_road_1750_review": ((86.951260, 28.374659), (86.891373, 28.309059)),
    "d25_road_1947_1955_review": ((86.821224, 28.215077), (86.839226, 28.290857)),
    "d25_road_1959_2013_review": ((86.839226, 28.290857), (86.953015, 28.378580)),
    # Day 26 had no successful navigation provenance in the prior build.
    "d26_road_1003_1032_review": ((86.966307, 28.392399), (87.063259, 28.493703)),
    "d26_road_1032_1117_review": ((87.063259, 28.493703), (87.068921, 28.509430)),
    "d26_road_1120_1300_review": ((87.068921, 28.509430), (86.496681, 28.602685)),
    "d26_road_1301_1311_review": ((86.496681, 28.602685), (86.388107, 28.696452)),
    "d26_road_1311_1428_review": ((86.388107, 28.696452), (85.772635, 28.700711)),
    "d26_road_1300_1428_review": ((86.496681, 28.602685), (85.768995, 28.748510)),
    "d26_road_1552_1604_review": ((85.486564, 28.823599), (85.428346, 28.932562)),
    "d26_road_1615_1811_review": ((85.367172, 28.930504), (85.336831, 28.393998)),
    "d26_gyirong_to_naicun_connection": ((85.336831, 28.393998), (85.339737, 28.409307)),
    "d26_gyirong_evening_review": ((85.334726, 28.399469), (85.328832, 28.393277)),
    "d27_road_1041_1103_review": ((85.373174, 28.385730), (85.414393, 28.365654)),
    "d27_viewpoint_outbound_full_review": ((85.328551, 28.389689), (85.413226, 28.364131)),
    "d28_road_1550_1556_review": ((86.679082, 28.600620), (86.769506, 28.601654)),
    "d28_road_2018_2035_review": ((89.763447, 29.294951), (90.029136, 29.338403)),
    # OSRM reports an implausible 70 km detour for this 4.9 km trunk-road
    # interval. Keep the three accepted GPS anchors that lie on the visible
    # eastbound road and let the renderer densify between them.
    "d28_road_2045_2048_review": (
        (90.157382, 29.350226),
        (90.188639, 29.346162),
        (90.206291, 29.339685),
    ),
    "d28_road_1937_2020_review": ((88.985229, 29.212463), (89.793304, 29.290148)),
    "d28_road_2035_2157_review": ((90.029136, 29.338403), (91.070237, 29.634703)),
    "d29_road_1741_1802_review": ((90.990081, 29.526383), (90.894653, 29.289701)),
    "d29_road_2022_2035_review": ((90.924731, 29.300250), (91.033721, 29.595913)),
    "d28_lhasa_arrival_review": ((91.055992, 29.624629), (91.136942, 29.655041)),
    "d28_d29_overnight_connection": ((91.136937, 29.655009), (91.137197, 29.654995)),
}


def hav_m(a, b) -> float:
    q = math.pi / 180
    x = (
        math.sin((b[1] - a[1]) * q / 2) ** 2
        + math.cos(a[1] * q)
        * math.cos(b[1] * q)
        * math.sin((b[0] - a[0]) * q / 2) ** 2
    )
    return 6371008.8 * 2 * math.asin(math.sqrt(x))


def route(waypoints):
    start, end = waypoints[0], waypoints[-1]
    coords = ";".join(f"{point[0]},{point[1]}" for point in waypoints)
    query = urllib.parse.urlencode(
        {
            "overview": "full",
            "geometries": "geojson",
            "steps": "false",
            "alternatives": "false",
        }
    )
    request = urllib.request.Request(
        f"{OSRM}/route/v1/driving/{coords}?{query}",
        headers={"User-Agent": "VLogRouteProcessor/1.0 (reviewed editorial road repairs)"},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise RuntimeError(f"OSRM failed: {payload.get('code')}")
    result = payload["routes"][0]
    geometry = result["geometry"]["coordinates"]
    snap_start = hav_m(start, geometry[0])
    snap_end = hav_m(end, geometry[-1])
    if max(snap_start, snap_end) > 1500:
        raise RuntimeError(
            f"OSRM snapped endpoint too far: start={snap_start:.0f}m end={snap_end:.0f}m"
        )
    direct = hav_m(start, end)
    routed = float(result["distance"])
    if len(geometry) < 2 or routed > max(12000, direct * 5.0):
        raise RuntimeError(
            f"unreasonable OSRM path direct={direct/1000:.1f}km routed={routed/1000:.1f}km"
        )
    return [[round(float(lon), 7), round(float(lat), 7)] for lon, lat in geometry], routed


def add_peiku_offroad_spur(coords):
    # Preserve a short dirt-road excursion toward Shishapangma, while keeping
    # the rest of the Peku Tso passage on the main highway. The old endpoint
    # [85.645797, 28.714785] repeats as an identical GPS jump and is not a
    # credible destination; do not turn that artefact into a 4.6 km straight.
    # The raw recording jumps north between 14:23 and 14:28 and then comes
    # straight back, producing an off-road triangle. The story excursion was
    # toward Shishapangma, i.e. south. Start at the reviewed main-road junction,
    # make one restrained southbound dirt-road out-and-back, then continue west.
    south_join = [85.772635, 28.700711]
    cut = min(
        range(len(coords)),
        key=lambda i: hav_m(coords[i], south_join),
    )
    south_spur = [
        south_join,
        [85.772200, 28.690500],
        [85.771500, 28.679000],
        [85.770600, 28.668000],
        [85.769500, 28.658000],
    ]
    return (
        south_spur
        + list(reversed(south_spur[:-1]))
        + coords[cut + 1 :]
    )


def simplify_d23_1714_wave(coords):
    """Remove the tiny editorially distracting road wiggle around 17:14."""
    wave = [90.545223, 28.494239]
    return [
        point
        for index, point in enumerate(coords)
        if index in (0, len(coords) - 1) or hav_m(point, wave) > 80
    ]


def replace_d22_1158_hook(coords):
    """Keep the reviewed main road, then use the real GPS road tail at 11:58."""
    tail = [
        [90.902172, 29.388071],
        [90.885945, 29.372651],
        [90.876804, 29.367409],
        [90.875778, 29.366887],
        [90.870950, 29.364618],
        [90.869913, 29.364241],
        [90.869057, 29.363863],
        [90.868187, 29.363500],
        [90.867323, 29.363160],
        [90.866486, 29.362823],
        [90.865355, 29.362455],
        [90.860379, 29.360931],
    ]
    cut = min(range(len(coords)), key=lambda index: hav_m(coords[index], tail[0]))
    return coords[:cut] + tail


def clean_d22_1203_road_corridor(coords):
    """Drop the endpoint U-turns OSRM adds at the east-side interchange."""
    if len(coords) < 67:
        return coords
    return [coords[0], *coords[66:]]


def clean_d28_1937_start_fold(coords):
    """Remove OSRM's false westbound U-turn at the 19:37 route seam."""
    if len(coords) < 27:
        return coords
    prefix = [
        [88.985223, 29.212368],
        [88.986556, 29.212388],
        [88.987550, 29.212336],
        [88.988552, 29.212282],
        [88.989866, 29.212224],
    ]
    return prefix + coords[26:]


def reviewed_d28_2018_2035_corridor():
    """Keep the road corridor but remove its duplicated A-B-A-B traversal."""
    navigation = json.loads(
        (BASE / "route_data" / "navigation" / "matched-route.json").read_text(
            encoding="utf-8"
        )
    )["points"]
    first_leg = [
        [point["lon"], point["lat"]]
        for point in navigation
        if "2024-12-28T20:18:37+08:00"
        <= point["time"]
        <= "2024-12-28T20:20:13+08:00"
    ]
    onward_leg = [
        [point["lon"], point["lat"]]
        for point in navigation
        if "2024-12-28T20:21:54.878480+08:00"
        <= point["time"]
        <= "2024-12-28T20:35:15+08:00"
    ]
    if not first_leg or not onward_leg:
        raise RuntimeError("missing navigation points for d28 20:18-20:35 repair")
    return first_leg + onward_leg


def reviewed_d22_airport_return(outbound):
    """Reuse the confirmed outbound road in reverse, then join the real GPS tail."""
    reversed_road = list(reversed(outbound))
    join = [90.645101, 29.322994]
    cut = min(range(len(reversed_road)), key=lambda index: hav_m(reversed_road[index], join))
    tail = [
        join,
        [90.652559, 29.324627],
        [90.656042, 29.326216],
        [90.662821, 29.329019],
        [90.666579, 29.332073],
        [90.679063, 29.343805],
        [90.688783, 29.352719],
        [90.693538, 29.356058],
    ]
    return [[90.499628, 29.263594]] + reversed_road[: cut + 1] + tail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ids",
        nargs="*",
        help="Only rebuild these path ids and merge them into the existing file.",
    )
    args = parser.parse_args()
    existing = (
        json.loads(OUTPUT.read_text(encoding="utf-8"))
        if OUTPUT.exists()
        else {"paths": {}, "metadata": {}}
    )
    paths = dict(existing.get("paths", {}))
    metadata = dict(existing.get("metadata", {}))
    selected = set(args.ids or FIXES.keys())
    unknown = selected.difference(FIXES)
    if unknown:
        raise KeyError(f"unknown path ids: {sorted(unknown)}")
    for path_id, waypoints in FIXES.items():
        if path_id not in selected:
            continue
        start, end = waypoints[0], waypoints[-1]
        if path_id == "d28_d29_overnight_connection":
            coords = [list(start), list(end)]
            distance = hav_m(start, end)
        elif path_id == "d28_road_2018_2035_review":
            coords = reviewed_d28_2018_2035_corridor()
            distance = sum(
                hav_m(coords[index - 1], coords[index])
                for index in range(1, len(coords))
            )
        elif path_id == "d28_road_2045_2048_review":
            coords = [list(point) for point in waypoints]
            distance = sum(
                hav_m(coords[index - 1], coords[index])
                for index in range(1, len(coords))
            )
        else:
            coords, distance = route(waypoints)
        if path_id == "d26_peiku_rebuild":
            coords = add_peiku_offroad_spur(coords)
        elif path_id == "d23_road_1716_review":
            coords = simplify_d23_1714_wave(coords)
        elif path_id == "d22_road_1145_1155_review":
            coords = replace_d22_1158_hook(coords)
        elif path_id == "d22_road_1203_review":
            coords = clean_d22_1203_road_corridor(coords)
        elif path_id == "d28_road_1937_2020_review":
            coords = clean_d28_1937_start_fold(coords)
        elif path_id == "d22_airport_return_review":
            coords = reviewed_d22_airport_return(paths["d22_airport_outbound_review"])
        # Geometry post-processors can replace router detours or add reviewed
        # off-road spurs, so metadata must describe the final stored path.
        distance = sum(
            hav_m(coords[index - 1], coords[index])
            for index in range(1, len(coords))
        )
        paths[path_id] = coords
        metadata[path_id] = {
            "provider": (
                "editorial overnight connector"
                if path_id == "d28_d29_overnight_connection"
                else "reviewed navigation corridor with duplicate legs removed"
                if path_id == "d28_road_2018_2035_review"
                else "reviewed accepted GPS road anchors"
                if path_id == "d28_road_2045_2048_review"
                else
                "reviewed reverse corridor + GPS anchors"
                if path_id == "d22_airport_return_review"
                else "OSRM"
            ),
            "start": list(start),
            "end": list(end),
            "routed_distance_m": round(distance),
            "point_count": len(coords),
        }
        print(f"[road-fix] {path_id} distance={distance/1000:.1f}km points={len(coords)}")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "generated_at": datetime.now().astimezone().isoformat(),
                "metadata": metadata,
                "paths": paths,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"[ok] wrote {OUTPUT}")


if __name__ == "__main__":
    main()
