#!/usr/bin/env python3
"""Find A -> B -> A -> B style repeated travel in a route.

The default input is the accepted portion of the normalized raw GPX layer. The
script only reports candidates; it never edits route data or overrides.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path


BASE = Path(__file__).resolve().parents[1]
LAYER_INPUTS = {
    "raw": BASE / "route_data" / "source" / "raw-track.json",
    "navigation": BASE / "route_data" / "navigation" / "matched-route.json",
    "final": BASE / "route_data" / "processed" / "route-data.json",
}
DEFAULT_JSON = BASE / "route_data" / "analysis" / "backtrack-candidates.json"
DEFAULT_MD = BASE / "route_data" / "analysis" / "backtrack-candidates.md"


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


@dataclass(frozen=True)
class Point:
    index: int
    t: datetime
    lon: float
    lat: float

    @property
    def coord(self) -> tuple[float, float]:
        return self.lon, self.lat


@dataclass
class Candidate:
    a1: Point
    b1: Point
    a2: Point
    b2: Point
    leg_m: float
    path_ab_m: float
    path_ba_m: float
    path_ab2_m: float
    close_a_m: float
    close_b_m: float
    score: float

    @property
    def start(self) -> datetime:
        return self.a1.t

    @property
    def end(self) -> datetime:
        return self.b2.t


def load_points(path: Path, include_rejected: bool) -> list[Point]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw = payload["points"] if isinstance(payload, dict) else payload
    points = []
    for item in raw:
        if not include_rejected and item.get("accepted") is False:
            continue
        points.append(
            Point(
                index=len(points),
                t=datetime.fromisoformat(item["time"]),
                lon=float(item["lon"]),
                lat=float(item["lat"]),
            )
        )
    points.sort(key=lambda point: point.t)
    return [Point(i, p.t, p.lon, p.lat) for i, p in enumerate(points)]


class SpatialIndex:
    def __init__(self, points: list[Point], cell_deg: float = 0.0012):
        self.points = points
        self.cell_deg = cell_deg
        self.cells: dict[tuple[int, int], list[int]] = {}
        for point in points:
            self.cells.setdefault(self.cell(point.coord), []).append(point.index)

    def cell(self, coord: tuple[float, float]) -> tuple[int, int]:
        return (
            math.floor(coord[0] / self.cell_deg),
            math.floor(coord[1] / self.cell_deg),
        )

    def nearby(self, coord: tuple[float, float], radius_m: float) -> list[int]:
        cx, cy = self.cell(coord)
        span = max(1, math.ceil(radius_m / (self.cell_deg * 90000)))
        result: list[int] = []
        for x in range(cx - span, cx + span + 1):
            for y in range(cy - span, cy + span + 1):
                for index in self.cells.get((x, y), []):
                    if hav_m(coord, self.points[index].coord) <= radius_m:
                        result.append(index)
        return result


def path_prefix(points: list[Point]) -> list[float]:
    prefix = [0.0]
    for a, b in zip(points, points[1:]):
        # Do not turn overnight/time-gap jumps into travelled distance.
        if timedelta(0) < b.t - a.t <= timedelta(minutes=30):
            prefix.append(prefix[-1] + hav_m(a.coord, b.coord))
        else:
            prefix.append(prefix[-1])
    return prefix


def path_distance(prefix: list[float], start: int, end: int) -> float:
    return max(0.0, prefix[end] - prefix[start])


def detect(
    points: list[Point],
    return_radius_m: float,
    revisit_radius_m: float,
    min_leg_m: float,
    min_cycle_minutes: float,
    max_cycle_minutes: float,
    max_follow_minutes: float,
) -> list[Candidate]:
    index = SpatialIndex(points)
    prefix = path_prefix(points)
    raw_candidates: list[Candidate] = []
    min_cycle = timedelta(minutes=min_cycle_minutes)
    max_cycle = timedelta(minutes=max_cycle_minutes)
    max_follow = timedelta(minutes=max_follow_minutes)

    for a2 in points:
        earlier = [
            i
            for i in index.nearby(a2.coord, return_radius_m)
            if i < a2.index and min_cycle <= a2.t - points[i].t <= max_cycle
        ]
        # Nearby stationary samples produce many equivalent starts. Keep a
        # bounded, time-distributed subset before evaluating the excursion.
        earlier = earlier[-24:]
        for a1_index in earlier:
            a1 = points[a1_index]
            if a2.index - a1.index < 3:
                continue
            middle = points[a1.index + 1 : a2.index]
            if not middle:
                continue
            b1 = max(middle, key=lambda p: hav_m(a1.coord, p.coord))
            leg_m = hav_m(a1.coord, b1.coord)
            if leg_m < min_leg_m:
                continue
            future = [
                i
                for i in index.nearby(b1.coord, revisit_radius_m)
                if i > a2.index
                and timedelta(seconds=30) <= points[i].t - a2.t <= max_follow
            ]
            if not future:
                continue
            b2_index = min(future, key=lambda i: points[i].t)
            b2 = points[b2_index]
            if b2.t - a1.t > max_cycle + max_follow:
                continue
            path_ab_m = path_distance(prefix, a1.index, b1.index)
            path_ba_m = path_distance(prefix, b1.index, a2.index)
            path_ab2_m = path_distance(prefix, a2.index, b2.index)
            # Each leg must contain meaningful motion, not just GPS points that
            # happen to land near A or B.
            if min(path_ab_m, path_ba_m, path_ab2_m) < min_leg_m * 0.65:
                continue
            close_a_m = hav_m(a1.coord, a2.coord)
            close_b_m = hav_m(b1.coord, b2.coord)
            score = leg_m + min(path_ab_m, path_ba_m, path_ab2_m) - 2 * (
                close_a_m + close_b_m
            )
            raw_candidates.append(
                Candidate(
                    a1,
                    b1,
                    a2,
                    b2,
                    leg_m,
                    path_ab_m,
                    path_ba_m,
                    path_ab2_m,
                    close_a_m,
                    close_b_m,
                    score,
                )
            )

    # Greedily retain the strongest representative of overlapping detections.
    selected: list[Candidate] = []
    for candidate in sorted(raw_candidates, key=lambda item: item.score, reverse=True):
        duplicate = False
        for kept in selected:
            overlap_s = max(
                0.0,
                (min(candidate.end, kept.end) - max(candidate.start, kept.start)).total_seconds(),
            )
            shorter_s = min(
                (candidate.end - candidate.start).total_seconds(),
                (kept.end - kept.start).total_seconds(),
            )
            same_places = (
                hav_m(candidate.a1.coord, kept.a1.coord) <= return_radius_m * 2
                and hav_m(candidate.b1.coord, kept.b1.coord) <= revisit_radius_m * 2
            ) or (
                hav_m(candidate.a1.coord, kept.b1.coord) <= revisit_radius_m * 2
                and hav_m(candidate.b1.coord, kept.a1.coord) <= return_radius_m * 2
            )
            overlap_ratio = overlap_s / shorter_s if shorter_s > 0 else 0
            if (same_places and overlap_ratio >= 0.45) or overlap_ratio >= 0.8:
                duplicate = True
                break
        if not duplicate:
            selected.append(candidate)
    return sorted(selected, key=lambda item: item.start)


def overlap_status(candidate: Candidate) -> list[str]:
    path = BASE / "route_data" / "editorial" / "exclusions.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    labels = []
    for item in payload.get("editorial_ranges", []):
        start = datetime.fromisoformat(item["start"])
        end = datetime.fromisoformat(item["end"])
        if max(start, candidate.start) <= min(end, candidate.end):
            labels.append(item.get("name") or item["id"])
    return labels


def candidate_record(candidate: Candidate) -> dict:
    covered = overlap_status(candidate)
    path_ratio = max(
        candidate.path_ab_m,
        candidate.path_ba_m,
        candidate.path_ab2_m,
    ) / max(1.0, candidate.leg_m)
    if path_ratio <= 2.5 and max(candidate.close_a_m, candidate.close_b_m) <= 100:
        confidence = "high"
    elif path_ratio <= 5.0 and max(candidate.close_a_m, candidate.close_b_m) <= 160:
        confidence = "medium"
    else:
        confidence = "low"
    return {
        "start": candidate.a1.t.isoformat(),
        "first_arrival": candidate.b1.t.isoformat(),
        "returned": candidate.a2.t.isoformat(),
        "second_arrival": candidate.b2.t.isoformat(),
        "a": [round(candidate.a1.lon, 7), round(candidate.a1.lat, 7)],
        "b": [round(candidate.b1.lon, 7), round(candidate.b1.lat, 7)],
        "a_return_error_m": round(candidate.close_a_m),
        "b_revisit_error_m": round(candidate.close_b_m),
        "direct_leg_m": round(candidate.leg_m),
        "travelled_legs_m": [
            round(candidate.path_ab_m),
            round(candidate.path_ba_m),
            round(candidate.path_ab2_m),
        ],
        "already_covered_by": covered,
        "status": "already_covered" if covered else "review",
        "confidence": confidence,
        "max_path_to_direct_ratio": round(path_ratio, 2),
        "score": round(candidate.score, 1),
    }


def write_reports(candidates: list[Candidate], json_path: Path, md_path: Path, args) -> None:
    records = [candidate_record(candidate) for candidate in candidates]
    payload = {
        "generated_at": datetime.now().astimezone().isoformat(),
        "input": str(args.input),
        "pattern": "A -> B -> A -> B",
        "parameters": {
            "return_radius_m": args.return_radius_m,
            "revisit_radius_m": args.revisit_radius_m,
            "min_leg_m": args.min_leg_m,
            "min_cycle_minutes": args.min_cycle_minutes,
            "max_cycle_minutes": args.max_cycle_minutes,
            "max_follow_minutes": args.max_follow_minutes,
        },
        "candidate_count": len(records),
        "candidates": records,
    }
    json_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# A→B→A→B 折返候选",
        "",
        "本报告只标记候选，不自动删除轨迹。时间均沿用路线中的中国标准时间。",
        "",
    ]
    if not records:
        lines.append("未发现符合当前阈值的候选。")
    for number, record in enumerate(records, 1):
        covered = "；已由人工修正覆盖：" + "、".join(record["already_covered_by"]) if record["already_covered_by"] else "；待检查"
        lines.extend(
            [
                f"## {number}. {record['start'][5:16].replace('T', ' ')}–{record['second_arrival'][11:16]}；置信度 {record['confidence']}{covered}",
                "",
                f"- A 出发：`{record['start']}` `{record['a']}`",
                f"- 第一次到 B：`{record['first_arrival']}` `{record['b']}`",
                f"- 返回 A：`{record['returned']}`，误差约 {record['a_return_error_m']} m",
                f"- 再到 B：`{record['second_arrival']}`，误差约 {record['b_revisit_error_m']} m",
                f"- A/B 直线距离约 {record['direct_leg_m']} m；三段实际轨迹约 {record['travelled_legs_m']} m",
                f"- 最长实际路径/直线距离比：{record['max_path_to_direct_ratio']}",
                "",
            ]
        )
    md_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--layer",
        choices=sorted(LAYER_INPUTS),
        default="raw",
        help="named route layer to inspect (default: raw)",
    )
    parser.add_argument("--input", type=Path, help="custom input; overrides --layer")
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--markdown", type=Path, default=DEFAULT_MD)
    parser.add_argument("--include-rejected", action="store_true")
    parser.add_argument("--return-radius-m", type=float, default=120)
    parser.add_argument("--revisit-radius-m", type=float, default=150)
    parser.add_argument("--min-leg-m", type=float, default=200)
    parser.add_argument("--min-cycle-minutes", type=float, default=3)
    parser.add_argument("--max-cycle-minutes", type=float, default=180)
    parser.add_argument("--max-follow-minutes", type=float, default=120)
    args = parser.parse_args()
    args.input = args.input or LAYER_INPUTS[args.layer]
    points = load_points(args.input, args.include_rejected)
    candidates = detect(
        points,
        args.return_radius_m,
        args.revisit_radius_m,
        args.min_leg_m,
        args.min_cycle_minutes,
        args.max_cycle_minutes,
        args.max_follow_minutes,
    )
    write_reports(candidates, args.json, args.markdown, args)
    review = sum(not overlap_status(candidate) for candidate in candidates)
    print(
        f"[ok] points={len(points)} candidates={len(candidates)} review={review} "
        f"json={args.json} markdown={args.markdown}"
    )


if __name__ == "__main__":
    main()
