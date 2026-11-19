# CRS & Coordinate Transformation Reference

Use `gisknife crs` for point strings, DMS coordinates, WKT points, GeoJSON reprojection, and CSV batch coordinate rewriting.

## Common Commands

```bash
# Search EPSG database + China aliases
gisknife crs search 4547
gisknife crs search "CGCS2000"

# Single point or semicolon-delimited points
gisknife crs convert "500000,2500000" --from EPSG:4547 --to WGS84
gisknife crs convert "114°03'12\"E, 22°32'40\"N" --from WGS84 --to GCJ02
gisknife crs convert "POINT (500000 2500000)" --from 4547 --to 4326

# Batch rewrite CSV (preserves all non-coordinate columns verbatim)
gisknife crs convert --csv sites.csv -o sites_84.csv --from EPSG:4547 --to WGS84
gisknife crs convert --csv sites.csv -o sites_84.csv --from EPSG:4547 --to WGS84 --mode overwrite
gisknife crs convert --csv sites.csv -o sites_84.csv --from EPSG:4547 --to WGS84 --x-col easting --y-col northing

# Reproject GeoJSON
gisknife crs convert --file parcel.geojson -o parcel_84.geojson --from EPSG:4547 --to EPSG:4326
```

## Built-in Sniffer Guardrails (Critical for China Surveying Data)

`gisknife` runs automatic heuristics on inputs before returning final numbers:

1. **`ZONE_PREFIX_MISMATCH` (`EPSG:4547` vs `EPSG:4526`)**:
   - `EPSG:4547` = CGCS2000 / 3-degree Gauss-Kruger **CM 114E** (6-digit Easting near `500,000`).
   - `EPSG:4526` = CGCS2000 / 3-degree Gauss-Kruger **zone 38** (8-digit Easting near `38,500,000`).
   - More generally, for 3-degree zone `z` (25..45), zoned is `EPSG:${4488 + z}` and unzoned is `EPSG:${4509 + z}`.
   - If the user declares `4547` but passes `38500000, 2500000` (or vice versa), the sniffer emits `ZONE_PREFIX_MISMATCH` with the exact suggested EPSG code. Ask the user or re-run with `--auto-fix` once confirmed.

2. **`SUSPECTED_AXIS_SWAP` (China Surveying X=North, Y=East)**:
   - Chinese CAD / total-station / planning tables frequently label Northing (~`1,800,000`–`6,000,000`) as `X` and Easting (~`200,000`–`800,000` or `25,000,000`–`45,000,000`) as `Y`.
   - GIS standards expect `X = Easting`, `Y = Northing`.
   - When detected, `gisknife` emits `SUSPECTED_AXIS_SWAP`. Pass `--swap-axes` or `--auto-fix` after confirming with the user.

3. **`SUSPECTED_LAT_LON_SWAP`**:
   - When `--from EPSG:4326` receives `|x| <= 90` and `|y| > 90` (e.g. `22.54, 114.05`), the sniffer warns about `[lat, lon]` vs `[lon, lat]`.

4. **China Encrypted CRS (`GCJ02`, `BD09`)**:
   - `GCJ02` (Amap/Tencent/DataV GeoAtlas) and `BD09` (Baidu Maps) have nonlinear 50–700 m offsets relative to `WGS84`/`CGCS2000`.
   - Always check source metadata before assuming a China web-map GeoJSON is `WGS84`.

## CSV Column Auto-Detection

When `--x-col` / `--y-col` are omitted, `gisknife` checks common pairs (case-insensitive):
- `(lon, lat)`, `(lng, lat)`, `(longitude, latitude)`
- `(x, y)`, `(coord_x, coord_y)`, `(easting, northing)`
- `(经度, 纬度)`, `(东坐标, 北坐标)`

In `append` mode (default), output columns are named `<toCrsSafe>_x`, `<toCrsSafe>_y` (or `<toCrsSafe>_lon`, `<toCrsSafe>_lat` for geographic targets). In `overwrite` mode, the detected source columns are updated in place while retaining every other column unchanged.
