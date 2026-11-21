# End-to-End GIS Recipes

Combine `gisknife` commands cleanly by chaining compact output file paths.

## Recipe 1: Ambiguous City/State Boundary + GeoPackage Delivery
```bash
# Step 1: Query "Washington" -> disambiguate cleanly
gisknife fetch boundary "Washington"
# Step 2: Fetch specific target after user confirms D.C.
gisknife fetch boundary "Washington, D.C." -o ./dc.geojson
# Step 3: Convert to GeoPackage & generate visual check
gisknife convert ./dc.geojson -o ./dc.gpkg
gisknife preview ./dc.geojson -o ./dc.html
```

## Recipe 2: China City & Subdistrict (Street) Boundaries
```bash
# City boundary (DataV GeoAtlas, de-offset to WGS84)
gisknife fetch boundary "佛山" --subdivisions --to-wgs84 -o ./foshan_districts.geojson

# District subdistricts / streets (OSM Overpass ADM4)
gisknife fetch boundary "深圳南山区" --level street -o ./nanshan_streets.geojson
gisknife qa ./nanshan_streets.geojson --fix -o ./nanshan_streets_clean.geojson
gisknife preview ./nanshan_streets_clean.geojson -o ./nanshan_streets.html
```

## Recipe 3: Silicon Valley OSM Roads & Buildings
```bash
# Small area fast extraction (Palo Alto slice)
gisknife fetch osm --bbox "-122.18,37.41,-122.14,37.44" --layers roads,buildings -o ./palo_alto_osm.geojson

# Whole Silicon Valley via Overture S3 GeoParquet (Python uvx DuckDB)
gisknife fetch osm --place "Silicon Valley" --layers roads --source overture -o ./sv_roads.parquet
```

## Recipe 4: Surveying CSV (`EPSG:4547` -> `WGS84`) with Safety Sniffing
```bash
# 1. Run conversion (auto-sniffs 4547 vs 4526 and surveying X/Y swap)
gisknife crs convert --csv survey_4547.csv -o survey_wgs84.csv --from EPSG:4547 --to WGS84

# 2. If sniffer reports SUSPECTED_AXIS_SWAP (X=North ~2.5M, Y=East ~500k), confirm and rerun:
gisknife crs convert --csv survey_4547.csv -o survey_wgs84.csv --from EPSG:4547 --to WGS84 --swap-axes

# 3. Convert CSV points to GeoJSON and inspect visually on a map
gisknife convert survey_wgs84.csv -o survey_wgs84.geojson
gisknife preview survey_wgs84.geojson -o survey_check.html
```

## Recipe 5: Hand off a local-file centroid workflow
Run `gisknife handoff centroid` (or `bbox`, or `buffer --distance 500`). Open the resulting `/tools/workflow#wf=...` URL on the compatible workbench, select a local GeoJSON file, run, and download. The CLI includes no file path or coordinates in the link. A result is not present until the browser actually runs the workflow. Print layout and 3D rendering are not handoff operators in 0.1.0.
