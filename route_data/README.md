# 路线数据分层

路线由四层数据顺序构建，禁止反向使用成片插值点污染上游数据。

1. `source/raw-track.json`：原始 GPX 的只读规范化镜像。`accepted` 表示点是否通过自动异常过滤；真正的原始事实仍以根目录 GPX 为准。
2. `editorial/exclusions.json` 与 `editorial/anchors.json`：人工剔除区间、被剔除的原始点 ID、手工坐标和字幕/媒体关键点。其维护入口是 `route-overrides.json`。
3. `navigation/matched-route.json`：使用 OSM/OSRM 道路数据匹配后的中间路线，尚未应用人工几何修正。
4. `processed/route-data.json` 与 `.js`：加入人工修正和播放插值后的最终网页数据。

最终点的 `source` 可为：

- `raw`：保留下来的原始 GPX 点。
- `editorial_anchor`：人工指定、必须经过的关键点。
- `navigation:osm`：来自本地 OSM 道路网络。
- `navigation:osrm`：来自 OSRM 导航路线。
- `rendered`：为动画连续性生成的插值点。

`source_id` 指向原始点或人工规则；`derived_from` 记录生成依据；`generated` 区分事实/人工锚点和计算生成点。

完整构建：

```bash
venv-mv/bin/python scripts/process_route_osm.py --no-driving-match
```

只修改人工几何时，脚本会从第三层重新生成第四层，不会在旧成片路线之上重复修改：

```bash
python3 scripts/process_route_osm.py --geometry-edits-only
```

所有生成层均不可手工编辑。

隧道显示由 `route-overrides.json > tunnel_ranges` 驱动。只能放入 OSM `tunnel=yes` 或经卫星图/现场资料确认的区间；不要因为 GPS 缺失就直接标记为隧道。

复杂的人工道路重建使用 `route-overrides.json` 中的 `geometry_edits[].path_id`，实际几何保存在 `editorial/manual-paths.json`。这些点属于经过审核的导航来源，不应被误标成原始 GPS。重新下载这些道路路径：

```bash
python3 scripts/build_editorial_road_paths.py
```

## 扫描重复折返

检测 `A → B → A → B` 异常模式，只生成候选报告，不修改路线：

```bash
python3 scripts/find_route_backtracks.py
```

输出：

- `analysis/backtrack-candidates.json`：供后续脚本或剪辑规则使用。
- `analysis/backtrack-candidates.md`：包含四个大概时间、A/B 坐标、三段路程和置信度。

默认扫描通过基础过滤的原始 GPS 点，最短 A/B 距离为 200 米。可通过 `--min-leg-m`、`--return-radius-m`、`--max-cycle-minutes` 等参数调整灵敏度。

道路匹配本身也可能在稀疏 GPS 之间生成折返，因此还要扫描第三层：

```bash
python3 scripts/find_route_backtracks.py --layer navigation \
  --json route_data/analysis/navigation-backtrack-candidates.json \
  --markdown route_data/analysis/navigation-backtrack-candidates.md
```

## 十分钟道路审计

按十分钟窗口区分驾车、步行与已知越野段，并结合原始 GPS、人工审核来源、OSM/OSRM 来源和折返形态生成候选报告：

```bash
venv-mv/bin/python scripts/audit_route_windows.py --screenshot-limit 30
```

对候选窗口生成“最终路线红线 + 原始 GPS 黄线 + 前后语境蓝线”的卫星图：

```bash
venv-mv/bin/python scripts/capture_route_audit_screenshots.py --limit 30
```

详细结论见根目录 `轨迹卫星图复核报告.md`。截图只用于复核，不进入 Git。
