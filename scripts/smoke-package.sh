#!/usr/bin/env bash
set -euo pipefail
packages=$(cd "${1:?Provide the directory made by pack-candidate.sh}" && pwd)
(cd "$packages" && shasum -a 256 -c SHA256SUMS)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
npm install --ignore-scripts --no-fund --no-audit "$packages"/*.tgz
cli="$work/node_modules/.bin/gisknife"
node_bin=$(command -v node)
mkdir empty-path
ln -s "$node_bin" empty-path/node
printf '%s\n' 'id,x,y' '样点,500000,2500000' '空行,,0' > survey.csv
PATH="$work/empty-path" "$cli" crs convert --csv survey.csv --from 4547 --to 84 -o survey-wgs84.csv > crs.json
PATH="$work/empty-path" "$cli" convert survey-wgs84.csv -o points.geojson > points.json
if PATH="$work/empty-path" "$cli" convert points.geojson -o missing.gpkg 2> missing-uv.json; then
  echo 'Expected GeoPackage conversion to fail without uv.' >&2
  exit 1
fi
test ! -e missing.gpkg
export UV_FIND_LINKS="$packages" UV_TOOL_DIR="$work/uv-tools"
uv tool run --from "$packages"/*.whl gisknife-engine --capabilities
"$cli" doctor > doctor.json
cat > parcel.geojson <<'JSON'
{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"acceptance-parcel"},"geometry":{"type":"Polygon","coordinates":[[[114,22],[114.01,22],[114.01,22.01],[114,22.01],[114,22]]]}}]}
JSON
"$cli" convert parcel.geojson -o parcel.gpkg > convert.json
"$cli" inspect parcel.gpkg > inspect.json
"$cli" convert parcel.gpkg -o roundtrip.geojson > roundtrip.json
"$cli" qa roundtrip.geojson --fix -o checked.geojson > qa.json
"$cli" sql "SELECT name, ST_Area_Spheroid(geom) AS area_m2, geom FROM ST_Read('checked.geojson')" --result-crs EPSG:4326 -o areas.geojson > sql.json
"$cli" preview areas.geojson -o preview.html > preview.json

node <<'JS'
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const crs = read('crs.json')
assert.equal(crs.transformedCount, 1)
assert.equal(crs.skippedCount, 1)
const points = read('points.geojson').features
assert.equal(points.length, 1)
assert.equal(points[0].properties.id, '样点')
assert.deepEqual(points[0].geometry.coordinates, [114, 22.5978229])
assert.match(read('missing-uv.json').error, /uv is not installed/)
assert.equal(read('doctor.json').pythonEngine.available, true)
const inspected = read('inspect.json')
assert.equal(inspected.featureCount, 1)
assert.deepEqual(inspected.bbox, [114, 22, 114.01, 22.01])
assert.equal(read('qa.json').issueCount, 0)
const areas = read('areas.geojson').features
assert.equal(areas.length, 1)
assert.equal(areas[0].properties.name, 'acceptance-parcel')
assert.ok(areas[0].properties.area_m2 > 1_000_000 && areas[0].properties.area_m2 < 1_200_000)
assert.equal(read('preview.json').featureCount, 1)
assert.match(readFileSync('preview.html', 'utf8'), /acceptance-parcel/)
JS
echo 'PASS: installed CLI, CSV/CRS, GeoPackage, QA, SQL and preview (no online map data).'
