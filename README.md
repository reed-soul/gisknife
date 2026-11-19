# gisknife

English | [简体中文](./README.zh-CN.md)

**The AI-native GIS Swiss Army Knife** — One Agent Skill + Dual-Engine CLI (Node/TS + Python `uvx`) + MCP Apps + A2UI 1.0 + WebMCP.

Install **one** Skill and let your AI agent (Claude Code, Codex, Cursor, Antigravity) handle real GIS work end-to-end without manual Conda/GDAL setup or blowing up your LLM context window.

---

## Why `gisknife`?

- **End-to-End Execution, Not Just Guidelines**: Unlike doc-only skill packs, `gisknife` pairs a concise [`SKILL.md`](./SKILL.md) router with a real dual-engine CLI (`gisknife` / `gk`) and MCP server.
- **Fast TS Core + Unlimited Python `uvx` Power**:
  - **Node/TS (`@gisknife/core`)** runs CRS transforms, China surveying sniffing, multi-source boundary/OSM fetches, light formats, Turf analysis, and MapLibre previews in milliseconds.
  - **Python `uvx` (`python/gisknife-engine`)** automatically handles Shapefile (with GBK `.cpg` fix & `.zip` bundling), GeoPackage, GeoParquet, FlatGeobuf, DXF, Overture S3 GeoParquet, DuckDB Spatial SQL, and optional GeoTIFF rasters.
- **Built-in Spatial Guardrails**:
  - Writes large outputs to disk and returns a **compact JSON envelope** (`path`, `crs`, `featureCount`, `bbox`, `warnings`, `complianceNote`) so large geometries never blow up chat context.
  - Automatically catches **CGCS2000 zone-prefix mismatches** (`EPSG:4547` 6-digit vs `EPSG:4526` 8-digit zone 38), **China surveying X=North / Y=East axis swaps**, **WGS84/GCJ-02/BD-09 offsets**, and **unprojected metric buffers**.
- **Works Headless by Default, Interactive Only When Needed**:
  - Launches an ephemeral `127.0.0.1` MapLibre picker (`gisknife pick`) or sandboxed **MCP Apps** widget (`ui://gisknife/picker`) only when human visual selection or file drop is needed.
  - Ships **A2UI 1.0 + AG-UI + `@ui-sdk/core`** catalog bindings and **WebMCP** descriptors aligned with [gis.taoliapp.com](https://gis.taoliapp.com).

---

## Quick Start

### 1. Install as an Agent Skill

```bash
npx skills add reed-soul/gisknife
```

### 2. Local Workspace Development & CLI

Requirements: Node.js 20+, `pnpm`, and [`uv`](https://docs.astral.sh/uv/) (for the Python 3.12 heavy engine).

```bash
pnpm install
pnpm build

# Sync the Python heavy compute engine (auto-uses Python 3.12 via .python-version)
cd python/gisknife-engine && uv sync --extra dev && cd ../..

# Check both engines
node packages/cli/dist/index.js doctor
```

---

## Five Everyday GIS Workflows

```bash
# 1. Disambiguate & fetch US boundaries (Census TIGER -> GeoPackage)
gisknife fetch boundary "Washington"                      # Prompts State vs D.C.
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson
gisknife convert ./dc.geojson -o ./dc.gpkg

# 2. Fetch China City & Subdistrict (Street) boundaries
gisknife fetch boundary "佛山" --subdivisions --to-wgs84 -o ./foshan.geojson
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson

# 3. Extract Silicon Valley OSM data (or interactive BBox pick)
gisknife fetch osm --bbox "-122.18,37.41,-122.14,37.44" --layers roads,buildings -o ./palo_alto.geojson
gisknife fetch osm --place "Silicon Valley" --layers roads --source overture -o ./sv_roads.parquet

# 4. Convert EPSG:4547 string or CSV to WGS84 (with zone-prefix & XY-swap sniffer)
gisknife crs convert "500000,2500000" --from EPSG:4547 --to WGS84
gisknife crs convert --csv survey_4547.csv -o survey_wgs84.csv --from EPSG:4547 --to WGS84

# 5. Spatial SQL, Topology QA & Standalone Visual Map Check
gisknife qa ./nanshan_streets.geojson --fix -o ./nanshan_clean.geojson
gisknife sql "SELECT name, ST_Area_Spheroid(geom) AS area_m2, geom FROM ST_Read('./nanshan_clean.geojson')" -o ./areas.geojson
gisknife preview ./nanshan_clean.geojson -o ./nanshan_preview.html --open
```

---

## Architecture & Packages

- [`docs/architecture/ARCHITECTURE.md`](./docs/architecture/ARCHITECTURE.md) ([中文版](./docs/architecture/ARCHITECTURE.zh-CN.md)) — Full dual-engine design & diagrams
- [`docs/architecture/PROTOCOLS.md`](./docs/architecture/PROTOCOLS.md) — Skill, CLI, Ephemeral Picker, MCP Apps, A2UI 1.0 + AG-UI + Vercel UI SDK, WebMCP
- [`docs/architecture/DATA_SOURCES_AND_COMPLIANCE.md`](./docs/architecture/DATA_SOURCES_AND_COMPLIANCE.md) — Multi-source routing, remote static index spec, China mapping compliance
- [`docs/architecture/ROADMAP.md`](./docs/architecture/ROADMAP.md) — Roadmap & `gis.taoliapp.com` workbench synergy

| Package | Purpose |
|---|---|
| [`@gisknife/core`](./packages/core) | Pure TS GIS core (CRS, sniffer, fetchers, format fast-path, QA, Turf ops, HTML preview) |
| [`@gisknife/picker`](./packages/picker) | Ephemeral localhost HITL BBox/Polygon/File picker |
| [`@gisknife/mcp-apps`](./packages/mcp-apps) | MCP Apps (`io.modelcontextprotocol/ui`) `ui://` interactive widgets |
| [`@gisknife/a2ui-catalog`](./packages/a2ui-catalog) | A2UI 1.0 GIS Component Catalog + AG-UI event bridge + `@ui-sdk/core` contracts |
| [`@gisknife/webmcp-bridge`](./packages/webmcp-bridge) | `document.modelContext` WebMCP tools + `gis.taoliapp.com/#wf=` handoff |
| [`@gisknife/mcp`](./packages/mcp) | Stdio MCP server combining tools + `ui://` resources |
| [`gisknife`](./packages/cli) | Unified CLI (`gisknife` / `gk`) + Python `uvx` RPC bridge |
| [`gisknife-engine`](./python/gisknife-engine) | Python 3.12 DuckDB Spatial + `httpfs` + GeoPandas/Pyogrio + Shapely + optional Rasterio |

---

## Compliance Notice

`gisknife` intentionally bundles **zero** un-audited China national or administrative boundary vector files. All boundary fetches preserve source, CRS, and compliance metadata. For official publication or public display of China maps, always use standard maps from the Ministry of Natural Resources (自然资源部标准地图服务).

## License

[MIT](./LICENSE) © 2026 reed-soul
