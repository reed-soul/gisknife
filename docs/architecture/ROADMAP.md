# Roadmap & `gis.taoliapp.com` Synergy

## Phase 1: MVP (Implemented in Initial Release)
- Root `SKILL.md` + 6 progressive-disclosure `references/*.md` guides (`npx skills add` compatible).
- `@gisknife/core`: Full EPSG catalog + CGCS2000/GCJ-02/BD-09, `EPSG:4547` vs `4526` & surveying X/Y axis sniffer, string/CSV/GeoJSON transform, multi-source boundary & OSM router, Overpass relation ring stitcher, light formats, QA, Turf ops, standalone MapLibre preview.
- `python/gisknife-engine`: `uv` / Python 3.12 heavy engine with DuckDB Spatial + `httpfs` (Overture S3), GeoPandas/Pyogrio (SHP GBK `.cpg` + `.zip`, GPKG, GeoParquet, FGB, DXF), `make_valid`, optional Rasterio.
- `@gisknife/picker`, `@gisknife/mcp`, `@gisknife/mcp-apps`, `@gisknife/a2ui-catalog`, `@gisknife/webmcp-bridge`, and `gisknife` CLI (`doctor`, `crs`, `fetch`, `convert`, `inspect`, `qa`, `analyze`, `sql`, `preview`, `pick`, `mcp`).

## Phase 2: Ecosystem & Extended Compute
- Publish `@gisknife/*` to npm and `gisknife-engine` to PyPI for true one-line zero-clone `npx gisknife` / `uvx gisknife-engine`.
- STAC catalog search (Planetary Computer / Earth Search) + AWS Terrarium / Copernicus GLO-30 COG elevation slice fetching.
- Native FlatGeobuf HTTP Range partial reads in `@gisknife/core`.
- Community-maintained static ADM4 index connectors (zero repo bloat).

## Phase 3: Deep Integration with `gis.taoliapp.com`
- Adopt `@gisknife/core` inside `gis.taoliapp.com` as the shared browser/CLI GIS kernel.
- Wire `@gisknife/a2ui-catalog` + AG-UI into `gis.taoliapp.com`'s L3 AI Copilot, backed by `@ui-sdk/core` primitives inside Vue 3.
- Seamless `#wf=` handoff: CLI workflows that require cartographic print layout (legend/grid/PDF), LiDAR/3D Cesium globe visualization, or interactive DAG debugging open directly in `gis.taoliapp.com`—keeping all user files 100% local.
