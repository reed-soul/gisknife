# Spatial Analysis, DuckDB Spatial SQL, and Heavy Python Engine Reference

## Spatial Analysis (`gisknife analyze`)

Available operators:
- **TS Fast-path (`@turf/turf`)**: `buffer`, `simplify`, `centroid`, `bbox`, `dissolve`, `union`, `intersect`, `difference`, `measure`, `grid-square`, `grid-hex`.
- **Python `uvx` (`geopandas`/`shapely`)**: automatically used for heavy formats (`.gpkg`, `.parquet`, `.shp`, `.fgb`), large datasets, `clip`, `spatial-join`, or when `--engine python` is passed.

### Silent Failure Guardrail: Units & Projections
- **Never** buffer degrees in `EPSG:4326` with planar math.
- `gisknife analyze buffer` uses geodesic/projected buffering (`--distance <meters>`). When delegating to Python `geopandas`, `vector_ops` automatically projects WGS84 inputs to the centroid's local UTM zone (or equal-area CRS for `area`) before computing, then projects back to the requested CRS.
- If a GeoJSON contains projected coordinates (e.g., `x > 180`) while claiming to be WGS84, `gisknife` emits a CRS mismatch error instead of silently returning garbage results.

```bash
# 500-meter buffer (automatically unit-safe)
gisknife analyze buffer ./stations.geojson --distance 500 -o ./stations_500m.geojson

# Simplify tolerance in degrees (for WGS84) or meters (with projected CRS)
gisknife analyze simplify ./nanshan_streets.geojson --tolerance 0.0005 -o ./nanshan_simple.geojson

# Spatial join / clip (routes to Python engine automatically)
gisknife analyze clip ./sv_roads.geojson --mask ./palo_alto.geojson -o ./pa_roads.geojson
gisknife analyze measure ./nanshan_streets.geojson
```

## DuckDB Spatial SQL (`gisknife sql`)

Write standard DuckDB Spatial SQL (`ST_Read`, `ST_Area`, `ST_Buffer`, `ST_Intersects`, `ST_DWithin`, `ST_Transform`, `httpfs` remote GeoParquet):

```bash
# Query local GeoJSON / GeoPackage / Shapefile / Parquet directly with SQL
gisknife sql \
  "SELECT name, ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:3857')) AS area_m2, geom FROM ST_Read('./nanshan_streets.geojson') ORDER BY area_m2 DESC" \
  -o ./nanshan_areas.geojson
```

Note: In DuckDB SQL, `ST_Area(geom)` on `EPSG:4326` geometry returns square degrees! Always `ST_Transform` to a local projected/equal-area EPSG or use `ST_Area_Spheroid(geom)` when working with lon/lat geometries.

## Raster & Optional Extras

For GeoTIFF inspection, reprojection, cropping, or spatial statistics (`PySAL`):
```bash
uv tool install "gisknife-engine[raster,stats]"
# or inside local repo:
uv sync --directory python/gisknife-engine --extra raster --extra stats
```
If `rasterio` is not installed, `gisknife` fails loudly with an actionable install command rather than guessing.
