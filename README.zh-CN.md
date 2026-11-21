# gisknife

[English](./README.md) | 简体中文

**面向 AI 时代的泛 GIS 瑞士军刀** —— 单入口 Agent Skill + 双引擎 CLI（Node/TS + Python `uvx`）+ MCP Apps + A2UI 1.0 + WebMCP。

它让 AI 助手在本机交付 GIS 文件，而不是把整份空间数据塞进对话。Skill 是操作说明；真正取数、转换和检查文件的是另装的 CLI。**0.1.0 是本地候选版，尚未公开发布。** 安装实测、上线条件见[发布验收单](docs/release/0.1.0.md)。

首发以处理已有文件为主：坐标转换、格式转换、检查和空间分析。**联网取数为 Beta（试用）功能。** 能否取到数据、能取到哪些范围，由数据源决定。复用或对外分发前，请核对来源和使用条款。

---

## 核心特性

- **从指令到 GIS 文件**：[`SKILL.md`](./SKILL.md) 引导 AI 助手调用 CLI，实际转换和处理文件。
- **Node 和 Python 双引擎**：
  - **Node/TS（`@gisknife/core`）**：坐标与 CSV 批量转换、中国测绘坐标检查、轻量格式互转、Turf 空间分析、生成单文件 HTML 地图预览。
  - **Python（`python/gisknife-engine`）**：处理 Shapefile（包括 GBK `.cpg` 和 `.zip`）、GeoPackage、GeoParquet、FlatGeobuf、DXF、DuckDB Spatial SQL，以及可选的 GeoTIFF 元数据检查。Overture 按范围取数也使用该引擎，属于 Beta 功能。
- **GIS 防静默翻车内核**：
  - **大几何不进上下文**：永远把结果落盘，仅向 Agent 返回精简 JSON 摘要（文件路径、CRS、要素数、BBox、警告与合规声明）。
  - **中国测绘高频坑自动嗅探**：精准识别 `EPSG:4547`（不带 38 带号，6 位东坐标）vs `EPSG:4526`（带 38 带号，8 位东坐标）混用、测量习惯 X=北/Y=东轴反写、以及 WGS84 / CGCS2000 / GCJ-02 / BD-09 偏移提醒。
  - **禁止在经纬度下裸算米级缓冲区**：自动采用测地线或投影转换。
- **默认零浏览器，只在必要时唤起交互**：
  - 需要用户手绘框选（如“硅谷”）或拖入本地文件时，按客户端自动选用 **MCP Apps（`ui://` 内嵌地图）** 或 **一次性 `127.0.0.1` 选区页（`gisknife pick`）**。
  - `gisknife handoff centroid|bbox|buffer` 生成只含步骤的工作流链接。浏览器中再选本地文件；候选工作台已在本机测试，尚未部署到线上。底图、公开数据源和首次安装需要联网。

---

## 快速开始

### 1. 作为 Agent Skill 安装

```bash
npx skills add . --agent codex  # 在当前源码目录安装说明，不会安装 CLI
```

### 2. 本地源码构建与双引擎检查

前置依赖：Node.js 22.12+（源码构建推荐 Node 24）、`pnpm`、以及重算任务需要的 [`uv`](https://docs.astral.sh/uv/)。安装 Skill 只安装指令，不会替用户安装 CLI 或 `uv`。

安装工具、首次准备 Python 引擎或 DuckDB 扩展时可能需要联网。处理已有文件不依赖在线取数；打开预览页仍需联网加载 MapLibre 和底图瓦片。

```bash
pnpm install
pnpm build

# 同步 Python 重算引擎（通过 .python-version 自动选用 Python 3.12 预编译轮子）
cd python/gisknife-engine && uv sync --extra dev && cd ../..

# 检查双引擎与环境变量状态
node packages/cli/dist/index.js doctor
```

---

## 使用示例

示例使用已安装的 `gisknife` 命令。用源码构建的读者可在仓库根目录运行，将 `gisknife` 换成 `node packages/cli/dist/index.js`。

### 处理本地文件

图层示例使用你已有的 `parcels.geojson`：坐标系为 WGS84，几何为面，属性中有 `name` 字段。

```bash
# EPSG:4547 单点或 CSV 批量转 WGS84
gisknife crs convert "500000,2500000" --from EPSG:4547 --to WGS84
gisknife crs convert --csv survey_4547.csv -o survey_wgs84.csv --from EPSG:4547 --to WGS84

# 转换本地图层，检查几何并生成预览
gisknife convert ./parcels.geojson -o ./parcels.gpkg
gisknife qa ./parcels.geojson --fix -o ./parcels_clean.geojson
gisknife sql "SELECT name, ST_Area_Spheroid(geom) AS area_m2, geom FROM ST_Read('./parcels_clean.geojson')" -o ./areas.geojson
gisknife preview ./parcels_clean.geojson -o ./parcels_preview.html --open
```

### 联网取数（Beta）

以下示例需要联网。公共服务可能超时，返回的数据也可能不完整，尤其是街道边界。如何指定数据源、核对结果，见[取数说明](references/fetch.md)。

```bash
# 确认地点、获取美国行政边界并转为 GeoPackage
gisknife fetch boundary "Washington"                      # 自动返回州 vs 特区候选供确认
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson
gisknife convert ./dc.geojson -o ./dc.gpkg

# 获取中国城市与深圳南山街道级边界
gisknife fetch boundary "佛山" --subdivisions --to-wgs84 -o ./foshan.geojson
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson

# 获取帕洛阿尔托的 OSM 路网与建筑，或硅谷的 Overture 路网
gisknife fetch osm --bbox "-122.18,37.41,-122.14,37.44" --layers roads,buildings -o ./palo_alto.geojson
gisknife fetch osm --place "Silicon Valley" --layers roads --source overture -o ./sv_roads.parquet
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
