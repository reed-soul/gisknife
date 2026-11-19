# Spatial Data Fetching Reference (Boundaries, OSM, Overture)

`gisknife fetch` routes queries across public zero-key APIs, optional BYOK regional APIs, and configurable remote static indexes, writes GeoJSON/GeoParquet to disk, and returns a compact summary envelope.

## 1. Administrative Boundaries (`gisknife fetch boundary`)

### Disambiguation Behavior
- Ambiguous queries like `"Washington"` or `"美国华盛顿"` return `"status": "disambiguation_required"` with candidate choices:
  1. `Washington State, USA` (US Census State FIPS `53`)
  2. `Washington, D.C., USA` (District of Columbia FIPS `11`)
- Present candidates to the user before proceeding, or pass `"Washington, D.C."` / `"Washington State"` / `--pick-first`.

### Routing Matrix
| Target Region / Level | Primary Source | Fallback Chain | Default CRS & Notes |
|---|---|---|---|
| **US States / DC / Counties** | US Census TIGERweb REST | geoBoundaries → Nominatim | `WGS84` (`EPSG:4326`), zero-key |
| **China Province / City / District** (e.g. `佛山`, `深圳南山区`) | Aliyun DataV GeoAtlas v3 | Remote Static Index → Tianditu/Amap BYOK → OSM Nominatim | DataV returns **`GCJ02`**. Pass `--to-wgs84` to de-offset to `WGS84` |
| **China Subdistrict / Street (`--level street`)** (e.g. `深圳南山区`) | Remote Static Index (`GISKNIFE_INDEX_URL`, if configured) | OSM Overpass (`admin_level=8\|9` inside parent area) → Amap/Tianditu BYOK | `WGS84` (from OSM/Static Index). Check `warnings` for completeness! |
| **Global ADM0–ADM4** | geoBoundaries API | OSM Nominatim (`polygon_geojson=1`) → Overpass | `WGS84` |

### Examples

```bash
# US Washington D.C.
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson

# China Foshan (with sub-districts & GCJ02 -> WGS84 de-offset)
gisknife fetch boundary "佛山" --subdivisions --to-wgs84 -o ./foshan_districts.geojson

# Shenzhen Nanshan District Streets (ADM4 / admin_level=8|9)
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson
```

## 2. OSM & Overture Extraction (`gisknife fetch osm`)

Never blind-query Overpass for giant metro areas. `gisknife` evaluates area size first:
- **Area ≤ 600 km² (or `--source overpass`)**: Uses multi-mirror Overpass pool (`overpass-api.de`, `kumi.systems`, `maps.mail.ru`) with exponential backoff + `osmStitcher` ring chaining.
- **Large Area (> 600 km²) or `--source overture`**: Routes to Python `uvx` DuckDB `httpfs` to query **Overture Maps S3 GeoParquet** with BBox pushdown (if `uv` is available), or advises narrowing BBox via `gisknife pick`.
- **Informal Regions** (e.g. `"Silicon Valley"` / `"美国硅谷"`): Resolves canonical core Silicon Valley BBox (`[-122.52, 37.12, -121.58, 37.60]`) and explicitly notes `"region_type": "informal"` in the envelope—suggest `gisknife pick` if the user wants a custom boundary.

### Examples

```bash
# Small/medium BBox in Palo Alto / Silicon Valley
gisknife fetch osm --bbox "-122.18,37.41,-122.14,37.44" --layers roads,buildings -o ./palo_alto.geojson

# Named informal region (auto-routes large area to Overture S3 or warns)
gisknife fetch osm --place "Silicon Valley" --layers roads --source overture -o ./sv_roads.geojson

# Interactive map selection when area is unclear
gisknife fetch osm --pick --layers roads,pois -o ./custom_osm.geojson
```

## 3. Optional Environment Variables (BYOK & Custom Indexes)

- `GISKNIFE_INDEX_URL`: Base URL or manifest URL for external static FlatGeobuf/GeoParquet/GeoJSON administrative indexes (see `docs/architecture/DATA_SOURCES_AND_COMPLIANCE.md`).
- `TIANDITU_TOKEN`: Optional Tianditu API key (compliant China authoritative coordinates).
- `AMAP_KEY`: Optional Amap Web Service key.
- `GISKNIFE_CACHE_DIR`: Overrides `~/.cache/gisknife`. Pass `--no-cache` to bypass disk cache.

## Compliance Rule

`gisknife` intentionally bundles **zero** un-audited China national/administrative boundary vector files. Every fetched boundary carries `source`, `crs`, and `compliance_note`. Remind users that public publication/official display of China maps requires official standard maps from the Ministry of Natural Resources (自然资源部标准地图服务).
