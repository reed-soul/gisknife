# gisknife

CLI and stdio MCP server for local GIS work. Requires Node.js 22.12+; Python-backed formats, SQL and Overture also need `uv` on PATH. The CLI selects the matching `gisknife-engine` version. Install the Agent Skill separately if desired.

Prefer verified local artifacts when testing a release candidate. Registry installation by package name is for versions the project has published. The first Python-backed operation may download the engine or DuckDB extensions.

```sh
gisknife doctor
gisknife crs convert '500000,2500000' --from EPSG:4547 --to WGS84
gisknife inspect points.geojson
gisknife convert points.geojson -o points.gpkg
gisknife mcp
```

Use distinct input and output paths. Confirm ambiguous CRS and place choices. The map viewer embeds the layer in an HTML file but loads MapLibre and map tiles online.

**Online data fetching (`gisknife fetch`) is Beta.** Providers can fail or return incomplete coverage. Check the result, source, and terms before using or redistributing fetched data. A successful download is not official approval for map publication.
