# gisknife

[English](./README.md) | 简体中文

**面向 AI 时代的泛 GIS 瑞士军刀** —— 单入口 Agent Skill + 双引擎 CLI（Node/TS + Python `uvx`）+ MCP Apps + A2UI 1.0 + WebMCP。

只需要安装**这一个 Skill**，就能让 AI Agent（Claude Code、Codex、Cursor、Antigravity 等）直接帮你完成取数、坐标纠偏、CSV 批量转写、格式互转、空间 SQL、拓扑体检与地图可视化验收，无需折腾 Conda/GDAL 环境，也不会撑爆大模型上下文。

---

## 核心特性

- **开箱即用出文件，不只是“纸上谈兵”**：精简的 [`SKILL.md`](./SKILL.md) 路由器 + 渐进披露文档，直接驱动内置双计算引擎。
- **Node/TS 极速主干 + Python `uvx` 重算力**：
  - **Node/TS（`@gisknife/core`）**：毫秒级处理坐标与 CSV 批量转换、中国测绘防踩坑嗅探、全球/国内多源边界与 OSM 拉取、轻量格式互转、Turf 空间分析与单文件 HTML 地图预览。
  - **Python `uvx`（`python/gisknife-engine`）**：自动接管 Shapefile（自动修 GBK `.cpg` 乱码并打包 `.zip`）、GeoPackage、GeoParquet、FlatGeobuf、DXF、Overture S3 远程按框裁剪、DuckDB Spatial SQL 以及可选 GeoTIFF 栅格。
- **GIS 防静默翻车内核**：
  - **大几何不进上下文**：永远把结果落盘，仅向 Agent 返回精简 JSON 摘要（文件路径、CRS、要素数、BBox、警告与合规声明）。
  - **中国测绘高频坑自动嗅探**：精准识别 `EPSG:4547`（不带 38 带号，6 位东坐标）vs `EPSG:4526`（带 38 带号，8 位东坐标）混用、测量习惯 X=北/Y=东轴反写、以及 WGS84 / CGCS2000 / GCJ-02 / BD-09 偏移提醒。
  - **禁止在经纬度下裸算米级缓冲区**：自动采用测地线或投影转换。
- **默认零浏览器，只在必要时唤起交互**：
  - 需要用户手绘框选（如“硅谷”）或拖入本地文件时，按客户端自动选用 **MCP Apps（`ui://` 内嵌地图）** 或 **一次性 `127.0.0.1` 选区页（`gisknife pick`）**。
  - 提供 **A2UI 1.0 + AG-UI + Vercel UI SDK（`@ui-sdk/core`）** 组件协议及 **WebMCP** 桥接，可一键将复杂排版与 3D 预览交给 [gis.taoliapp.com](https://gis.taoliapp.com)（全程纯本地，文件不上传）。

---

## 快速开始

### 1. 作为 Agent Skill 安装

```bash
npx skills add reed-soul/gisknife
```

### 2. 本地源码构建与双引擎检查

前置依赖：Node.js 20+、`pnpm`、以及 [`uv`](https://docs.astral.sh/uv/)（用于自动管理 Python 3.12 重算引擎）。

```bash
pnpm install
pnpm build

# 同步 Python 重算引擎（通过 .python-version 自动选用 Python 3.12 预编译轮子）
cd python/gisknife-engine && uv sync --extra dev && cd ../..

# 检查双引擎与环境变量状态
node packages/cli/dist/index.js doctor
```

---

## 五个高频场景示例

```bash
# 1. 消歧并获取美国行政边界 + 转 GeoPackage
gisknife fetch boundary "Washington"                      # 自动返回州 vs 特区候选供确认
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson
gisknife convert ./dc.geojson -o ./dc.gpkg

# 2. 获取中国城市与深圳南山街道级边界
gisknife fetch boundary "佛山" --subdivisions --to-wgs84 -o ./foshan.geojson
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson

# 3. 获取硅谷 OSM 路网与建筑（支持手绘框选）
gisknife fetch osm --bbox "-122.18,37.41,-122.14,37.44" --layers roads,buildings -o ./palo_alto.geojson
gisknife fetch osm --place "Silicon Valley" --layers roads --source overture -o ./sv_roads.parquet

# 4. EPSG:4547 单点/CSV 批量转 WGS84（自动嗅探带号与 XY 轴反写，保留全部业务列）
gisknife crs convert "500000,2500000" --from EPSG:4547 --to WGS84
gisknife crs convert --csv survey_4547.csv -o survey_wgs84.csv --from EPSG:4547 --to WGS84

# 5. 拓扑体检修复、DuckDB Spatial SQL 与交互式 HTML 地图核验
gisknife qa ./nanshan_streets.geojson --fix -o ./nanshan_clean.geojson
gisknife sql "SELECT name, ST_Area_Spheroid(geom) AS area_m2, geom FROM ST_Read('./nanshan_clean.geojson')" -o ./areas.geojson
gisknife preview ./nanshan_clean.geojson -o ./nanshan_preview.html --open
```

---

## 架构文档与分包结构

- [`docs/architecture/ARCHITECTURE.zh-CN.md`](./docs/architecture/ARCHITECTURE.zh-CN.md)（[English](./docs/architecture/ARCHITECTURE.md)）—— 总体架构与双引擎设计
- [`docs/architecture/PROTOCOLS.md`](./docs/architecture/PROTOCOLS.md) —— Skill / CLI / Ephemeral Picker / MCP Apps / A2UI 1.0 + AG-UI + `@ui-sdk/core` / WebMCP 分层规范
- [`docs/architecture/DATA_SOURCES_AND_COMPLIANCE.md`](./docs/architecture/DATA_SOURCES_AND_COMPLIANCE.md) —— 多源路由规则、远程静态索引规范与测绘合规说明
- [`docs/architecture/ROADMAP.md`](./docs/architecture/ROADMAP.md) —— 演进路线及与 `gis.taoliapp.com` 协同策略

---

## 合规声明

本开源仓库**不内置**任何未经审图的中国国界或行政区划矢量数据。所有边界拉取工具均作为多源连接器运行，并在输出结果中强制标注数据来源、坐标系（如 `GCJ02` vs `WGS84`）及合规提示。用于公开出版、对外展示的中国地图，请务必使用自然资源部标准地图服务或官方天地图服务。

## 开源协议

[MIT](./LICENSE) © 2026 reed-soul
