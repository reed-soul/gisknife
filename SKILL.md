---
name: gisknife
description: >-
  AI-native GIS Swiss Army Knife (CLI + MCP + Python uvx). Use whenever the user
  asks to convert coordinates or batch-rewrite CSV/GeoJSON files (WGS84, EPSG, UTM,
  CGCS2000 EPSG:4547/4526, GCJ-02, BD-09), convert GIS formats (GeoJSON, CSV,
  KML, GPX, WKT, TopoJSON, Shapefile, GeoPackage, GeoParquet, FlatGeobuf, DXF,
  inspect GeoTIFF metadata), run spatial analysis or DuckDB Spatial SQL, inspect/QA topology, or
  generate visual HTML map previews. Also use for Beta online fetching of administrative
  boundaries (global, US, China province/city/district/street), OSM or Overture data
  (by place name, bbox, or interactive map pick).
license: MIT
metadata:
  author: reed-soul
  version: "0.1.0"
  homepage: "https://gis.taoliapp.com"
---

# gisknife — AI-Native GIS Swiss Army Knife

One root skill, a separately installed CLI (`gisknife` / `gk`), and an optional MCP server (`gisknife mcp`).
Node/TS handles light operations. Heavy formats (SHP/GPKG/GeoParquet/FGB/DXF), GeoTIFF metadata inspection, Spatial SQL, and Overture extraction need `uv` for the Python engine. Initial setup can require network access.

**Online data fetching is Beta.** Do not promise provider availability, coverage, or reuse rights. If a download fails, report it and offer to process a user-provided file. Do not pass off a stale output file or a different administrative level as the requested result.

## Mandatory Spatial Guardrails (Read Before Running Anything)

1. **Compact-Envelope Rule (Never Blow Context Window)**:
   Use file outputs and return the compact JSON summary (`outputPath`, `crs`, `featureCount`, `bbox`, `geometryTypes`, `sampleProperties`, `warnings`). **Never** pass `--stdout` on multi-feature files or dump raw GeoJSON/CSV into chat.
2. **Project Before Measuring or Buffering**:
   Use `gisknife analyze` for metric work; SQL executes your expressions as written. Choose geodesic math or an appropriate metric projection yourself in SQL. `--result-crs` labels already transformed coordinates; it does not transform them.
3. **CGCS2000 & China CRS Sniffing (`EPSG:4547` vs `4526`, Axis Swap, GCJ-02)**:
   Always inspect `warnings` from `gisknife crs convert`. If an input declares `EPSG:4547` (no zone prefix, ~500,000 Easting) but contains 8-digit Easting (`385xxxxx` -> `EPSG:4526`), or swaps surveying X=North / Y=East, **stop and confirm** with the user (or pass `--auto-fix` only when explicitly confirmed). Always state whether outputs are `WGS84` or `GCJ02`/`BD09`.
4. **Disambiguate Before Downloading**:
   When a place name is ambiguous (e.g. `"Washington"` -> State vs D.C.) or informal (e.g. `"Silicon Valley"`), present the returned candidates or launch `gisknife pick` (HITL map picker) before scraping massive regions.
5. **Visual QA & Compliance**:
   For client-facing deliverables or boundary extractions, recommend `gisknife preview <file>` to generate a standalone HTML map, and always preserve `source`, `crs`, and `compliance_note` metadata (never claim un-audited web sources are official national surveying maps).

## Progressive Disclosure Routing Table

Load ONLY the reference file needed for the current task:

| User Intent / Domain | CLI Entry | Load Reference |
|---|---|---|
| Coordinate string / CSV batch rewrite / EPSG search / `4547`↔`84` / GCJ-02 | `gisknife crs` | [references/crs.md](references/crs.md) |
| Online boundaries (global, US, China city/street), OSM, or Overture (Beta) | `gisknife fetch` | [references/fetch.md](references/fetch.md) |
| Format convert (SHP/GPKG/Parquet/KML/DXF) / inspect / topology QA & fix | `gisknife convert`, `inspect`, `qa` | [references/convert-qa.md](references/convert-qa.md) |
| Buffer, clip, union, dissolve, Spatial SQL (DuckDB), raster metadata | `gisknife analyze`, `sql`, `inspect` | [references/analyze-sql.md](references/analyze-sql.md) |
| Interactive map box pick, local file drop, MCP Apps, A2UI, WebMCP handoff | `gisknife pick`, `preview`, `mcp` | [references/hitl-ui.md](references/hitl-ui.md) |
| End-to-end recipes & `gis.taoliapp.com` workbench handoff (`#wf=`) | Multi-step pipelines | [references/recipes.md](references/recipes.md) |

## Quick Triage Commands

```bash
# 1. Verify TS + Python uvx dual-engine health
gisknife doctor

# 2. Convert a single point or batch CSV (EPSG:4547 -> WGS84)
gisknife crs convert "500000,2500000" --from EPSG:4547 --to WGS84
gisknife crs convert --csv input.csv -o output_wgs84.csv --from EPSG:4547 --to WGS84

# 3. Fetch boundaries and OSM (Beta; requires working online providers)
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson
gisknife fetch boundary "佛山" -o ./foshan.geojson
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson
gisknife fetch osm --place "Silicon Valley" --layers roads,buildings -o ./sv_osm.geojson

# 4. Interactive area selection when region is vague
gisknife pick -o ./area.geojson

# 5. Convert, QA, and visually verify a local layer
gisknife convert ./parcels.geojson -o ./parcels.gpkg
gisknife qa ./parcels.geojson --fix -o ./parcels_clean.geojson
gisknife preview ./parcels_clean.geojson -o ./parcels_preview.html
```

## Runtime Invocation Fallback

Before public release use `node packages/cli/dist/index.js` from a built checkout or the verified candidate tarballs. Do not fetch an unverified package by name. The Skill installer does not install Node, CLI or `uv`. Without `uv`, light operations still work; heavy formats, SQL and Overture do not. Map previews embed the data but load MapLibre and tiles over the network. See `references/hitl-ui.md` for workbench handoff.
