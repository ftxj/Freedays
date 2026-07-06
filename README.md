# 西藏边境线互动地图

以 MapLibre 和卫星影像呈现的旅行路线动画。网页主入口是 `地图行驶动画.html`，包含步行/驾车动画、稳定镜头、地点字幕和游戏式照片/视频事件。

## 本地预览

在项目根目录启动静态服务：

```bash
python3 -m http.server 8765
```

然后打开 `http://127.0.0.1:8765/地图行驶动画.html`。

## 数据与生成

- 人工可编辑的事件、镜头和路线修正：`route_data/route-overrides.json`
- 人工审核的道路几何：`route_data/editorial/manual-paths.json`
- 网页直接读取的生成数据：`route_data/processed/route-data.js`
- 路线分层与重建命令：`route_data/README.md`
- 代码职责与扩展方式：`地图动画开发说明.md`

修改后执行：

```bash
node scripts/validate_route_demo.js
```

## Git 策略

- 网页代码、路线分层数据、编辑指令和构建脚本使用普通 Git。
- `photo/` 和 `video/` 中只保留网页所用的压缩版素材，MP4 由 Git LFS 管理。
- 原始照片、原始视频、剪辑导出、虚拟环境、缓存和可重建的重复 JSON 不入库。
- 不要手工编辑 `route_data/processed/route-data.js`；它是为了让仓库克隆后可直接预览而保留的生成产物。
