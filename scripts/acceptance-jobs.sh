#!/usr/bin/env bash
set -euo pipefail
cli=$(cd "$(dirname "$0")/../packages/cli/dist" && pwd)/index.js
work=${1:-$(mktemp -d)}
mkdir -p "$work"
cd "$work"
if [ -n "$(ls -A)" ]; then echo 'Use an empty evidence directory.' >&2; exit 1; fi
echo "Beta provider diagnostics (not a release gate). Evidence: $PWD"
gis() { node "$cli" "$@"; }
gis fetch boundary Washington > ambiguity.log
jq -e '.status == "disambiguation_required" and (.candidates|length)>=2' ambiguity.log >/dev/null
gis fetch boundary 'Washington, D.C.' --no-cache -o dc.geojson > dc.log
gis convert dc.geojson -o dc.gpkg > dc-convert.log
gis inspect dc.gpkg > dc-inspect.log
jq -e '.featureCount==1 and .bbox[0] > -77.2 and .bbox[2] < -76.8 and .bbox[1] > 38.7 and .bbox[3] < 39.1' dc-inspect.log >/dev/null
gis fetch boundary 佛山 --subdivisions --no-cache -o foshan.geojson > foshan.log
jq -e '[.features[].properties.name]|sort == (["禅城区","南海区","顺德区","高明区","三水区"]|sort)' foshan.geojson >/dev/null
gis fetch boundary 深圳南山区 --level street --no-cache -o streets.geojson > streets.log
jq -e '[.features[].properties.name]|sort == (["南头街道","南山街道","沙河街道","蛇口街道","招商街道","粤海街道","桃源街道","西丽街道"]|sort)' streets.geojson >/dev/null
bbox='-122.17,37.41,-122.165,37.415'
gis fetch osm --bbox "$bbox" --source overpass --layers roads --no-cache -o roads.geojson > roads.log
gis fetch osm --bbox "$bbox" --source overture --layers roads -o roads.parquet > overture.log
for file in roads.geojson roads.parquet; do
  gis inspect "$file" > "$file.inspect.log"
  jq -e '.featureCount>0 and (.geometryTypes|index("LineString")!=null) and .bbox[0] < -122.165 and .bbox[2] > -122.17' "$file.inspect.log" >/dev/null
done
for code in 4547 4526; do
  easting=500000; if [ "$code" = 4526 ]; then easting=38500000; fi
  printf 'id,x,y\n样点,%s,2500000\n空行,,0\n' "$easting" > "in-$code.csv"
  gis crs convert --csv "in-$code.csv" --from "$code" --to WGS84 -o "out-$code.csv" > "convert-$code.log"
  jq -e '.transformedCount==1 and .skippedCount==1' "convert-$code.log" >/dev/null
  gis convert "out-$code.csv" -o "points-$code.geojson" > "points-$code.log"
  jq -e '.features|length==1 and .[0].properties.id=="样点" and .[0].geometry.coordinates==[114,22.5978229]' "points-$code.geojson" >/dev/null
done
gis qa streets.geojson --fix -o clean.geojson > qa.log
gis sql "SELECT name, ST_Area_Spheroid(geom) AS area_m2, geom FROM ST_Read('./clean.geojson')" -o areas.geojson > areas.log
gis preview areas.geojson -o preview.html > preview.log
jq -e '.issueCount==0 and .featureCount==8' qa.log >/dev/null
jq -e '(.features|length)==8 and all(.features[]; .properties.area_m2>0)' areas.geojson >/dev/null
test -s preview.html
echo 'PASS: live Beta provider diagnostics and dependent file readback.'
