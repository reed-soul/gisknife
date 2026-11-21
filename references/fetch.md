# Online Data Fetching (Beta): Boundaries, OSM, Overture

`gisknife fetch` routes queries across public zero-key APIs, optional BYOK regional APIs, and configurable remote static indexes, writes GeoJSON/GeoParquet to disk, and returns a compact summary envelope.

Online fetching is best-effort: provider outages, rate limits, and geographic gaps can prevent a result. A successful download does not prove coverage or grant reuse or redistribution rights. If an upstream provider fails, check the command result before using the output path, or process a local dataset instead.

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
| **China Province / City / District** (e.g. `佛山`, `深圳南山区`) | Aliyun DataV GeoAtlas v3 | Optional index; a failed district/children match does not fall back to its parent | CLI requests WGS84 by default; `--no-to-wgs84` keeps DataV's native coordinates |
| **China Subdistrict / Street (`--level street`)** (e.g. `深圳南山区`) | Configured static index | OSM Overpass within the matched parent or by child code; Amap only if street polygons exist | Check source, declared CRS and completeness; do not treat OSM as an official exhaustive register |
| **Global ADM0–ADM4** | geoBoundaries with `--iso3` | Nominatim administrative polygons | `WGS84`; ambiguous polygon results are not silently reduced to the first hit |

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
- **Informal Regions** (e.g. `"Silicon Valley"` / `"美国硅谷"`): Uses an approximate core bounding box, not an administrative polygon. Offer `gisknife pick` for a user-defined area.

Overpass writes GeoJSON. Overture requires `uv` and writes GeoParquet or GeoJSON, with its release in `source`. The 50,000-feature per-layer ceiling is a failure, not a silently truncated success. The request box selects matching features, not a geometric clip. Public providers can return HTTP errors or time out; use a new output path and inspect the command status before delivering any file.

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

- `GISKNIFE_INDEX_URL`: URL of the configured manifest with GeoJSON shard templates. Set only a trusted index with known coverage, CRS and redistribution terms.
- `TIANDITU_TOKEN`: Optional Tianditu API key (compliant China authoritative coordinates).
- `AMAP_KEY`: Optional Amap Web Service key.
- `GISKNIFE_CACHE_DIR`: Overrides `~/.cache/gisknife`. Pass `--no-cache` to bypass disk cache.

The project does not provide a hosted street index by default. With a trusted index configured, `gisknife fetch boundary "深圳南山区" --level street --source index --no-cache` checks its `china_adm4_geojson` shard without falling back to Overpass. Verify the shard's permitted use, CRS, and coverage independently.

## Compliance Rule

`gisknife` intentionally bundles **zero** un-audited China national/administrative boundary vector files. Boundary result envelopes include `source`, `crs`, and `complianceNote`; preserve them alongside delivered files. Engineering extraction does not grant permission for public map publication.
