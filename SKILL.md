---
name: gisknife
description: >-
  AI-native GIS Swiss Army Knife (CLI + MCP + Python uvx). Use whenever the user
  asks to fetch administrative boundaries (global, US, China province/city/district/street),
  download OSM or Overture data (by place name, bbox, or interactive map pick),
  convert coordinates or batch-rewrite CSV/GeoJSON files (WGS84, EPSG, UTM,
  CGCS2000 EPSG:4547/4526, GCJ-02, BD-09), convert GIS formats (GeoJSON, CSV,
  KML, GPX, WKT, TopoJSON, Shapefile, GeoPackage, GeoParquet, FlatGeobuf, DXF,
  GeoTIFF), run spatial analysis or DuckDB Spatial SQL, inspect/QA topology, or
  generate visual HTML map previews.
license: MIT
metadata:
  author: reed-soul
  version: "0.1.0"
  homepage: "https://gis.taoliapp.com"
---

# gisknife — AI-Native GIS Swiss Army Knife

One root skill + zero-config dual-engine CLI (`gisknife` / `gk`) + optional MCP server (`gisknife mcp`).
Fast operations run directly in Node/TS; heavy formats (SHP/GPKG/GeoParquet/FGB/DXF/GeoTIFF), Overture S3 extraction, and Spatial SQL transparently dispatch to Python (`uvx gisknife-engine`).

## Mandatory Spatial Guardrails (Read Before Running Anything)

1. **Compact-Envelope Rule (Never Blow Context Window)**:
   `gisknife` always writes full spatial outputs to disk and returns a compact JSON summary (`path`, `crs`, `feature_count`, `bbox`, `geometry_types`, `sample_properties`, `warnings`). **Never** pass `--stdout` on multi-feature files or dump raw GeoJSON/CSV into chat.
2. **Project Before Measuring or Buffering**:
   Never run metric buffers, area, or length calculations directly in `EPSG:4326` degrees without geodesic math or automatic equal-area/UTM projection. Use `gisknife analyze` or `gisknife sql` (which enforce this automatically) and read `references/analyze-sql.md`.
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
| Boundaries (global, US, China city/street) / Silicon Valley OSM / DEM | `gisknife fetch` | [references/fetch.md](references/fetch.md) |
| Format convert (SHP/GPKG/Parquet/KML/DXF) / inspect / topology QA & fix | `gisknife convert`, `inspect`, `qa` | [references/convert-qa.md](references/convert-qa.md) |
| Buffer, clip, union, dissolve, Spatial SQL (DuckDB), Overture, raster | `gisknife analyze`, `sql` | [references/analyze-sql.md](references/analyze-sql.md) |
| Interactive map box pick, local file drop, MCP Apps, A2UI, WebMCP handoff | `gisknife pick`, `preview`, `mcp` | [references/hitl-ui.md](references/hitl-ui.md) |
| End-to-end recipes & `gis.taoliapp.com` workbench handoff (`#wf=`) | Multi-step pipelines | [references/recipes.md](references/recipes.md) |

## Quick Triage Commands

```bash
# 1. Verify TS + Python uvx dual-engine health
gisknife doctor

# 2. Convert a single point or batch CSV (EPSG:4547 -> WGS84)
gisknife crs convert "500000,2500000" --from EPSG:4547 --to WGS84
gisknife crs convert --csv input.csv -o output_wgs84.csv --from EPSG:4547 --to WGS84

# 3. Fetch boundaries & OSM (always writes file + prints compact JSON summary)
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson
gisknife fetch boundary "佛山" -o ./foshan.geojson
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson
gisknife fetch osm --place "Silicon Valley" --layers roads,buildings -o ./sv_osm.geojson

# 4. Interactive area selection when region is vague
gisknife pick -o ./area.geojson

# 5. Convert, QA, and visually verify
gisknife convert ./dc.geojson -o ./dc.gpkg
gisknife qa ./nanshan_streets.geojson --fix -o ./nanshan_clean.geojson
gisknife preview ./nanshan_clean.geojson -o ./nanshan_preview.html
```

## Runtime Invocation Fallback

If `gisknife` is not installed globally, invoke via `npx gisknife ...` (or `node <skill-dir>/packages/cli/dist/index.js ...` when running directly from a cloned skill directory). If `uv` is missing, lightweight CRS, Turf ops, GeoJSON/CSV/KML/GPX/WKT/TopoJSON conversion, boundary/OSM fetch, picker, and HTML preview still work purely in Node/TS.
