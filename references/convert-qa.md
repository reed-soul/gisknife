# Format Conversion, Inspection, and Topology QA Reference

## Dual-Engine Format Routing

`gisknife convert` automatically picks the fastest engine with zero extra flags:

| Format | Extension(s) | Read Engine | Write Engine | Notes |
|---|---|---|---|---|
| **GeoJSON** | `.geojson`, `.json` | TS Fast-path | TS Fast-path | RFC 7946 compliant |
| **CSV** | `.csv` | TS Fast-path (`papaparse`) | TS Fast-path | Preserves attributes; WKT or lon/lat cols |
| **KML / GPX** | `.kml`, `.gpx` | TS Fast-path (`@tmcw/togeojson`) | TS Fast-path | Lightweight vector interchange |
| **WKT** | `.wkt` | TS Fast-path (`wellknown`) | TS Fast-path | Single or line-delimited WKT |
| **TopoJSON** | `.topojson` | TS Fast-path | TS Fast-path | Topology-preserving compact JSON |
| **Shapefile** | `.shp`, `.zip` | Python `uvx` (`pyogrio`) | Python `uvx` (`pyogrio`) | Auto-detects GBK/UTF-8 `.cpg`; writes clean `.zip` |
| **GeoPackage** | `.gpkg` | Python `uvx` | Python `uvx` | Recommended modern replacement for SHP |
| **GeoParquet** | `.parquet`, `.geoparquet` | Python `uvx` (`duckdb`/`pyogrio`) | Python `uvx` | Cloud-native columnar format |
| **FlatGeobuf** | `.fgb` | Python `uvx` | Python `uvx` | HTTP Range-request friendly vector |
| **DXF (CAD)** | `.dxf` | Python `uvx` (OGR) | Python `uvx` (OGR) | Pair with `gisknife crs` for `EPSG:4547` |
| **GeoTIFF** | `.tif`, `.tiff` | Python `uvx` (`[raster]`) | Python `uvx` (`[raster]`) | Requires `gisknife-engine[raster]` extra |

## Commands

```bash
# Format conversion (auto-dispatches TS vs Python uvx)
gisknife convert ./dc.geojson -o ./dc.gpkg
gisknife convert ./parcels.zip -o ./parcels.geojson        # handles GBK .dbf encoding
gisknife convert ./parcels.geojson -o ./parcels_shp.zip    # packages .shp/.dbf/.shx/.prj/.cpg

# Inspect schema, CRS, bbox, geometry types without dumping geometry
gisknife inspect ./nanshan_streets.geojson

# Geometry QA & automated repair
gisknife qa ./nanshan_streets.geojson
gisknife qa ./nanshan_streets.geojson --fix -o ./nanshan_fixed.geojson
```

## Common Pitfalls Caught by `gisknife qa`

1. **Null or empty geometries** (common when parsing dirty CSVs or incomplete relations).
2. **Invalid coordinates** (`NaN`, `Infinity`, or out-of-range WGS84 `|lon| > 180` / `|lat| > 90` when CRS is geographic).
3. **Self-intersections / kinks** (`@turf/kinks` in TS, `shapely.make_valid` in Python).
4. **Unclosed polygon rings** or wrong RFC 7946 winding order (fixed via `@turf/rewind` / `clean-coords`).
5. **Shapefile GBK Mojibake**: Legacy Chinese `.shp` files often lack a `.cpg` file and use `GB18030`/`GBK`; Python `vector_ops` probes UTF-8 then falls back to `GB18030` automatically and always emits `UTF-8` `.cpg` on export.
