# Data Sources, Routing Rules, Remote Static Index Spec & Compliance

## 1. Multi-Source Boundary Routing Matrix

| Query Profile | 1st Priority | 2nd Priority | 3rd / BYOK Fallback | Returned CRS |
|---|---|---|---|---|
| **United States (State / DC / County)** | US Census TIGERweb REST | geoBoundaries | OSM Nominatim | `EPSG:4326` (`WGS84`) |
| **China ADM1–ADM3 (Province / City / District)** | Aliyun DataV GeoAtlas v3 | Remote Static Index (`GISKNIFE_INDEX_URL`) | Tianditu (`TIANDITU_TOKEN`) / Amap (`AMAP_KEY`) / Nominatim | DataV = `GCJ02` (or `WGS84` when `--to-wgs84` is passed) |
| **China ADM4 (Subdistrict / Street / Town)** | Remote Static Index (`GISKNIFE_INDEX_URL`) | OSM Overpass (`admin_level=8\|9` inside parent area) | Amap / Tianditu BYOK | `EPSG:4326` (`WGS84`) |
| **Global ADM0–ADM4** | geoBoundaries REST API | OSM Nominatim (`polygon_geojson=1`) | OSM Overpass (`admin_level`) | `EPSG:4326` (`WGS84`) |

## 2. OSM & Overture Extraction Policy

| Extraction Area | Engine / Source | Reason |
|---|---|---|
| `≤ 600 km²` (neighborhood / district / Palo Alto slice) | Node/TS Overpass multi-mirror pool (`overpass-api.de`, `kumi.systems`, `maps.mail.ru`) + `osmStitcher` | Zero dependencies, fast, stitches boundary relations cleanly. |
| `> 600 km²` (whole Silicon Valley metro / province) or `--source overture` | Python `uvx` DuckDB `httpfs` querying Overture Maps S3 GeoParquet (`s3://overturemaps-us-west-2/release/...`) | Avoids Overpass `504 Gateway Timeout` and `429` rate limits via Parquet bbox predicate pushdown. |
| Ambiguous / Informal Name (e.g. `"Silicon Valley"`) | Preset region bbox OR `gisknife pick` HITL | Prevents silent mismatch between marketing terms and legal boundaries. |

## 3. Remote Static Index Manifest Specification (`GISKNIFE_INDEX_URL`)

`gisknife` does **not** bundle static boundary vector files inside its git repository. Organizations or community maintainers can publish static GeoJSON / FlatGeobuf / GeoParquet boundary shards on Cloudflare R2, GitHub Releases, or HuggingFace and point `gisknife` via `GISKNIFE_INDEX_URL=https://example.com/index.json`:

```json
{
  "version": 1,
  "name": "community-admin-index",
  "license": "ODbL-1.0",
  "crs": "EPSG:4326",
  "templates": {
    "china_adm4_geojson": "https://cdn.example.com/adm4/{adcode}.geojson",
    "china_adm3_fgb": "https://cdn.example.com/adm3/{adcode}.fgb",
    "global_adm_parquet": "https://cdn.example.com/global/{iso3}/adm{level}.parquet"
  }
}
```

When configured, `staticIndexProvider` checks `templates.china_adm4_geojson` (or matching template), fetches only the tiny target shard, caches it in `~/.cache/gisknife`, and stamps provenance onto the `ResultEnvelope`.

## 4. Disk Caching & Rate-Limit Etiquette

- Default cache path: `~/.cache/gisknife` (override via `GISKNIFE_CACHE_DIR`).
- Cache keys use SHA-256 over normalized `(provider, query, params)`.
- Overpass queries rotate across mirrors with exponential backoff and polite `User-Agent: gisknife/0.1`.
- Pass `--no-cache` to bypass cached entries for fresh pulls.

## 5. China Surveying & Boundary Compliance Policy

1. **Zero Bundled Vectors**: This repository intentionally contains **no** bundled China national or sub-national boundary vector files.
2. **Explicit Provenance & CRS**: Every fetched output embeds `source`, `crs` (`GCJ02` vs `WGS84`), and `compliance_note`.
3. **Authoritative Publication Guidance**: OpenStreetMap, DataV GeoAtlas, and geoBoundaries are suitable for internal spatial analysis, prototyping, and engineering work. For any public-facing publication, press release, or official China map display, practitioners **must** use officially audited standard maps from the Ministry of Natural Resources (自然资源部标准地图服务 / 天地图官方接口).
