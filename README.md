# gisknife

English | [简体中文](./README.zh-CN.md)

**The AI-native GIS Swiss Army Knife** — One Agent Skill + Dual-Engine CLI (Node/TS + Python `uvx`) + MCP Apps + A2UI 1.0 + WebMCP.

The Skill teaches an agent to use a separately installed CLI. Most operations return a summary and a local file rather than sending a dataset to the model. **0.1.0 is a local release candidate, not a published package.** See the [release decision and installation matrix](docs/release/0.1.0.md).

The first release focuses on processing files you already have: coordinate transforms, format conversion, inspection, and spatial analysis. **Online data fetching is Beta.** Availability and coverage depend on the provider. Check the source and its terms before reusing or distributing fetched data.

---

## Why `gisknife`?

- **End-to-End Execution, Not Just Guidelines**: Unlike doc-only skill packs, `gisknife` pairs a concise [`SKILL.md`](./SKILL.md) router with a real dual-engine CLI (`gisknife` / `gk`) and MCP server.
- **Node and Python engines**:
  - **Node/TS (`@gisknife/core`)** handles coordinate transforms, China surveying checks, light formats, Turf analysis, and MapLibre preview generation.
  - **Python (`python/gisknife-engine`)** handles Shapefile (including GBK `.cpg` and `.zip`), GeoPackage, GeoParquet, FlatGeobuf, DXF, DuckDB Spatial SQL, and optional GeoTIFF metadata inspection. It also powers Overture extraction (Beta).
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
npx skills add . --agent codex  # from this checkout; installs instructions, not the CLI
```

### 2. Local Workspace Development & CLI

Requirements: Node.js 22.12+ (Node 24 recommended for source builds), `pnpm`, and [`uv`](https://docs.astral.sh/uv/) for the Python heavy engine. The Skill provides instructions; it does not install the CLI or `uv`.

Installing the tooling and initializing the engine or DuckDB extensions may require network access. Local file processing does not require fetching GIS data; the preview page still loads MapLibre and basemap tiles online.

```bash
pnpm install
pnpm build

# Sync the Python heavy compute engine (auto-uses Python 3.12 via .python-version)
cd python/gisknife-engine && uv sync --extra dev && cd ../..

# Check both engines
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js handoff centroid
```

---

## Workflows

The examples use the installed `gisknife` command. From a built checkout, run them from the repository root and replace `gisknife` with `node packages/cli/dist/index.js`.

### Work with existing files

The layer examples use your own WGS84 polygon file `parcels.geojson` with a `name` property.

```bash
# Convert EPSG:4547 coordinates or CSV to WGS84
gisknife crs convert "500000,2500000" --from EPSG:4547 --to WGS84
gisknife crs convert --csv survey_4547.csv -o survey_wgs84.csv --from EPSG:4547 --to WGS84

# Convert a local layer, check its geometry, and preview the result
gisknife convert ./parcels.geojson -o ./parcels.gpkg
gisknife qa ./parcels.geojson --fix -o ./parcels_clean.geojson
gisknife sql "SELECT name, ST_Area_Spheroid(geom) AS area_m2, geom FROM ST_Read('./parcels_clean.geojson')" -o ./areas.geojson
gisknife preview ./parcels_clean.geojson -o ./parcels_preview.html --open
```

### Fetch online data (Beta)

These examples need internet access. Public endpoints may time out or return incomplete coverage, including street boundaries. See the [fetching reference](references/fetch.md) for provider selection and what to check before using a result.

```bash
# Disambiguate and fetch US boundaries (Census TIGER -> GeoPackage)
gisknife fetch boundary "Washington"                      # Prompts State vs D.C.
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson
gisknife convert ./dc.geojson -o ./dc.gpkg

# Fetch China city and street boundaries
gisknife fetch boundary "佛山" --subdivisions --to-wgs84 -o ./foshan.geojson
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson

# Extract Palo Alto OSM data or Silicon Valley Overture roads
gisknife fetch osm --bbox "-122.18,37.41,-122.14,37.44" --layers roads,buildings -o ./palo_alto.geojson
gisknife fetch osm --place "Silicon Valley" --layers roads --source overture -o ./sv_roads.parquet
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
