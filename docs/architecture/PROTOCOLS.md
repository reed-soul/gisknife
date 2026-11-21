# Protocols shipped in 0.1.0

The CLI runs without a UI. The Agent Skill is instructions, not the runtime. Terminal sessions can request a temporary picker on loopback. MCP clients use stdio; MCP Apps, browser tools and declarative surfaces are separate interfaces, not interchangeable host requirements.

| Interface | Implemented contract | Fallback / boundary |
|---|---|---|
| MCP | Nine tools on `gisknife mcp`; heavy operations use the CLI's uv bridge | A plain stdio client receives text results; GIS output goes to an explicit local path |
| MCP Apps | Three HTML resources: picker, preview and CRS disambiguator. Tool metadata binds the URI; the iframe initializes, receives tool notifications and calls `ui/message` | BBox inside the host; terminal picker for files/polygons on the same machine. Preview includes layer data in UI-only metadata |
| A2UI + AG-UI | One complete v1.0 `createSurface` in an AG-UI CUSTOM event and one decision via `callAgentFunction`. The emitter can also produce run/step/state events | Six GIS component types; not a general-purpose incremental renderer, hosted LLM or network chat service |
| UI SDK | The Vue renderer uses native modal dialogs and keyboard controls, and `@ui-sdk/core` for announcements | A beta dependency; not a claim that arbitrary React/mobile hosts were tested |
| WebMCP | The browser registers 18 existing tools plus five on the candidate handoff page (render surface, bbox, boundary, OSM, export); registration ends on unmount | Feature-detected. Ordinary workflow upload/run/download needs no WebMCP |
| Handoff | The CLI puts a centroid, buffer or bbox recipe in the URL fragment. The user selects the file locally | Does not send input data to the website in the URL. MapLibre, tiles and explicitly requested public datasets use the network |

## Wire example

`@a2ui/web_core/v1_0` requires a root node named `root`. Component fields are on the node, not under a `props` wrapper:

```json
{"type":"CUSTOM","name":"a2ui.frame","value":{"version":"1.0","createSurface":{"surfaceId":"check-1","catalogId":"gisknife.gis.v1","components":[{"id":"root","component":"CrsDisambiguator","declaredCrs":"EPSG:4547","suggestedCrs":"EPSG:4526","reason":"Easting starts with zone 38"}]}}}
```

The renderer replies with a unique call ID. The caller, not the renderer, runs the confirmed conversion:

```json
{"version":"1.0","callAgentFunction":{"surfaceId":"check-1","functionCallId":"decision-1","callFunction":{"@call":"gisknife.confirmCrsChoice","choice":"EPSG:4526"}}}
```

See the [release matrix](../release/0.1.0.md) for the actual client, browser flags, versions and deployment status.
