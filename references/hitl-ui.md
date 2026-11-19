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

Generates a single self-contained HTML file with MapLibre GL JS, layer toggles, click-to-inspect attribute popups, and a CRS/feature-count status badge:
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

For web/mobile copilots (including `gis.taoliapp.com` L3 AI Copilot):
- **A2UI 1.0**: Declarative JSON surface messages (`createSurface`, `updateComponents`, `updateDataModel`, `callAgentFunction`) strictly typed via Zod schemas (`MapBBoxPicker`, `CrsDisambiguator`, `PlaceDisambiguator`, `GeoSummaryCard`, `LayerQaReport`, `ExportDeliveryCard`).
- **AG-UI**: Maps `gisknife` execution lifecycle to standard `@ag-ui/core` events (`RunStarted`, `StepStarted`, `StateDelta`, `CustomEvent` carrying A2UI payloads, `RunFinished`).
- **Vercel UI SDK (`@ui-sdk/core`)**: Headless accessible UI behavior contracts so the same GIS components render in Vue 3, React, or Web Components.

## 5. WebMCP & `gis.taoliapp.com` Workbench Handoff (`@gisknife/webmcp-bridge`)

When a task needs heavy visual cartographic layout, 3D Cesium globe rendering, or chainable `#wf=` DAG editing, generate a handoff URL to `https://gis.taoliapp.com/#wf=...` using `buildWorkbenchHandoffUrl()`. Remember: **never upload user files to a server**; pass lightweight recipe specs or let users open local files directly in the browser workbench.
