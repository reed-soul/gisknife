# Multi-Protocol Interaction Architecture (Skill, CLI, Picker, MCP Apps, A2UI 1.0, AG-UI, Vercel UI SDK, WebMCP)

Each modern agent/UI protocol in `gisknife` solves a **distinct** layer of the stack. Never force one protocol to do another layer's job.

## 1. Protocol Responsibility Matrix

| Layer / Protocol | Standard / Package | Who Renders / Calls It | Best Used For in `gisknife` | Anti-Pattern (Do NOT Do) |
|---|---|---|---|---|
| **Agent Skill** | `agentskills.io` (`SKILL.md` + `references/`) | Claude Code, Codex, Cursor, Antigravity | Teaching the AI *when* to use which tool, enforcing spatial guardrails (`4547` vs `4526`, project-before-buffer), and keeping context clean. | Stuffing 5,000 lines of API docs into `SKILL.md`. |
| **Zero-Config CLI** | `packages/cli` (`gisknife` / `gk`) | Shell agents & human practitioners | 85%+ of workflows: point/CSV CRS rewrite, boundary/OSM fetch, format convert, Spatial SQL, HTML map preview. | Spawning a browser just to convert coordinates. |
| **Ephemeral Localhost Picker** | `packages/picker` (`127.0.0.1:0`) | Pure terminal agents lacking inline UI | Fallback HITL when the user must draw an informal BBox/Polygon or drag-drop a private file. Closes itself on submit. | Running a persistent background daemon. |
| **MCP + MCP Apps** | `@modelcontextprotocol/sdk` + `io.modelcontextprotocol/ui` (`packages/mcp`, `packages/mcp-apps`) | Claude Desktop/Web, Cursor, VS Code Copilot | Inline sandboxed `ui://` map box picker (`ui://gisknife/picker`), visual QA (`ui://gisknife/preview`), and CRS disambiguation (`ui://gisknife/crs-disambiguator`). | Streaming multi-MB GeoJSON text inside MCP tool replies. |
| **A2UI 1.0 + AG-UI** | Google A2UI v1.0 + `@ag-ui/core` (`packages/a2ui-catalog`) | `gis.taoliapp.com` L3 AI Copilot & cross-platform A2UI hosts | Streaming declarative GIS UI surfaces (`createSurface`, `updateComponents`, `updateDataModel`) & bidirectional `callAgentFunction` over AG-UI `CustomEvent` / `StateDelta`. | Expecting terminal CLIs (like raw zsh) to render A2UI JSON natively. |
| **Vercel UI SDK** | `@ui-sdk/core` (`packages/a2ui-catalog/src/uiSdkAdapter.ts`) | Vue 3 / React / Web Components renderers | Headless accessible UI primitives (focus trap, dialog, select, popover, keyboard nav) backing A2UI catalog widgets cleanly across frameworks. | Rewriting an entire existing Vue workbench just for hype. |
| **WebMCP** | `document.modelContext` (`packages/webmcp-bridge`) | Browser-native AI agents when `gis.taoliapp.com` is open | Exposing the browser workbench's 18+4 client-side WASM tools + generating `#wf=` handoff URLs from CLI to web workbench. | Making the CLI depend on headless Chrome + WebMCP for basic math. |

## 2. HITL Fallback Ladder (Degrades Gracefully Everywhere)

```text
Need visual user input (e.g., "Draw Silicon Valley" or "Confirm EPSG:4547 axis swap")?
  │
  ├─► Inside gis.taoliapp.com Copilot? ──► Stream A2UI 1.0 Surface via AG-UI (MapBBoxPicker / CrsDisambiguator)
  │
  ├─► Inside MCP Host supporting MCP Apps? ──► Return tool result + ui://gisknife/picker resource metadata
  │
  └─► Inside Terminal Agent / Raw CLI? ──► Launch @gisknife/picker on 127.0.0.1:<random-port> -> auto-close on POST /submit
```

## 3. Concrete Protocol Payloads

### A2UI 1.0 Surface Envelope (Carried inside AG-UI `CustomEvent`)

```json
{
  "type": "CUSTOM",
  "name": "a2ui.frame",
  "value": {
    "a2uiVersion": "1.0",
    "surfaceId": "gisknife-crs-check-1",
    "createSurface": {
      "catalogId": "gisknife.gis.v1",
      "rootComponentId": "crs-dialog"
    },
    "updateComponents": [
      {
        "id": "crs-dialog",
        "component": "CrsDisambiguator",
        "props": {
          "declaredCrs": "EPSG:4547",
          "suggestedCrs": "EPSG:4526",
          "reason": "Easting 38500000 contains 2-digit zone prefix 38 (EPSG:4526) rather than unzoned CM 114E (EPSG:4547).",
          "sampleInput": [38500000, 2500000]
        }
      }
    ]
  }
}
```

### MCP Apps Resource Binding (`packages/mcp`)

Tools such as `gis_pick_area` advertise `_meta: { ui: { resourceUri: "ui://gisknife/picker" } }` and `packages/mcp` serves `ui://gisknife/picker` with `mimeType: "text/html;profile=mcp-app"`. Inside the sandboxed iframe, the widget exchanges standard JSON-RPC `postMessage` frames (`ui/initialize`, `tools/call`, `ui/message`) to pass selected BBox/Polygon GeoJSON back to the host.
