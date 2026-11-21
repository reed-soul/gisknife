# Human-in-the-Loop (HITL) UI & Multi-Protocol Integration Reference

Use HITL UI **only when visual human judgment or local file drag-drop is genuinely needed** (e.g., drawing an exact boundary for an informal area like "Silicon Valley", uploading a private file in chat, or verifying EPSG:4547 axis swap visually). Never force a browser open for pure coordinate/CLI automation.

## 1. Ephemeral Localhost Picker (`gisknife pick`)

Works in ANY terminal agent (Claude Code, Codex CLI, raw zsh) with zero external server:
```bash
gisknife pick --mode bbox -o ./picked_area.geojson
gisknife pick --mode polygon -o ./custom_zone.geojson
gisknife pick --mode file -o ./dropped.geojson
```
Lifecycle: starts `127.0.0.1:<random-port>` → opens interactive MapLibre GL page → user draws BBox/Polygon or drops a GeoJSON/CSV → user clicks Confirm (`POST /submit`) → writes `./picked_area.geojson`, shuts down cleanly, prints compact JSON envelope.

## 2. Visual QA Preview (`gisknife preview`)

Embeds the layer in one HTML file. MapLibre and OSM basemap tiles require network access; this is not an offline viewer. Share the HTML only if you may share its embedded features and properties:
```bash
gisknife preview ./output.geojson -o ./output_preview.html --open
```

## 3. MCP Server & MCP Apps (`io.modelcontextprotocol/ui`)

Start the stdio MCP server for Claude Desktop, Cursor, or VS Code:
```bash
gisknife mcp
```
Registered tools (`@gisknife/mcp`):
- `gis_crs_convert`, `gis_fetch_boundary`, `gis_fetch_osm`, `gis_inspect`, `gis_convert`, `gis_analyze`, `gis_spatial_sql`, `gis_preview`, `gis_pick_area`.
- Interactive MCP Apps resources (`text/html;profile=mcp-app`):
  - `ui://gisknife/picker` (attached to `gis_pick_area`)
  - `ui://gisknife/preview` (attached to `gis_preview`)
  - `ui://gisknife/crs-disambiguator`

## 4. A2UI 1.0 + AG-UI + Vercel UI SDK (`@gisknife/a2ui-catalog`)

For the candidate web workbench and compatible renderers:
- **A2UI 1.0**: A complete `createSurface` renders one of six widgets (`MapBBoxPicker`, `CrsDisambiguator`, `PlaceDisambiguator`, `GeoSummaryCard`, `LayerQaReport`, `ExportDeliveryCard`); typed decisions use `callAgentFunction`. Incremental updates are not consumed by this renderer.
- **AG-UI**: Maps `gisknife` execution lifecycle to standard `@ag-ui/core` events (`RunStarted`, `StepStarted`, `StateDelta`, `CustomEvent` carrying A2UI payloads, `RunFinished`).
- **Vercel UI SDK (`@ui-sdk/core`)**: Headless accessible UI behavior contracts so the same GIS components render in Vue 3, React, or Web Components.

## 5. WebMCP & `gis.taoliapp.com` Workbench Handoff (`@gisknife/webmcp-bridge`)

Use `gisknife handoff centroid`, `bbox`, or `buffer --distance 500`. The URL contains a recipe only. A compatible workflow page keeps the selected local file in the browser. Browser `fetch_boundary` uses Nominatim, `fetch_osm` supports small boxes for roads/buildings, and export downloads the current GeoJSON result with user confirmation. CLI Overture and arbitrary GIS file export are not browser fetch tools. See `docs/release/0.1.0.md` in the repository for tested hosts.
