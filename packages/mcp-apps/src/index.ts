import { getCrsDisambiguatorAppHtml } from './apps/crsDisambiguatorApp.js'
import { getPickerAppHtml } from './apps/pickerApp.js'
import { getPreviewAppHtml } from './apps/previewApp.js'
import {
  MCP_APP_EXTENSION,
  MCP_APP_MIME_TYPE,
  MCP_APP_URIS,
  type McpAppResourceDescriptor,
} from './protocol.js'

export * from './protocol.js'
export { getPickerAppHtml, getPreviewAppHtml, getCrsDisambiguatorAppHtml }

export const MCP_APP_RESOURCES: McpAppResourceDescriptor[] = [
  {
    uri: MCP_APP_URIS.picker,
    name: 'gisknife-area-picker',
    title: 'Interactive Map Area Picker',
    description: 'Sandboxed MapLibre GL widget to pick an exact BBox inside MCP App hosts.',
    mimeType: MCP_APP_MIME_TYPE,
  },
  {
    uri: MCP_APP_URIS.preview,
    name: 'gisknife-layer-preview',
    title: 'GeoJSON Visual QA Preview',
    description: 'Interactive MapLibre GL layer preview for spatial QA inside MCP App hosts.',
    mimeType: MCP_APP_MIME_TYPE,
  },
  {
    uri: MCP_APP_URIS.crsDisambiguator,
    name: 'gisknife-crs-disambiguator',
    title: 'CGCS2000 & Axis Confirmation',
    description: 'Interactive CRS confirmation card for EPSG:4547 vs EPSG:4526 and XY swap.',
    mimeType: MCP_APP_MIME_TYPE,
  },
]

export function readMcpAppResourceHtml(uri: string): string | null {
  switch (uri) {
    case MCP_APP_URIS.picker:
      return getPickerAppHtml()
    case MCP_APP_URIS.preview:
      return getPreviewAppHtml()
    case MCP_APP_URIS.crsDisambiguator:
      return getCrsDisambiguatorAppHtml()
    default:
      return null
  }
}

export function buildMcpAppToolMeta(uri: string): Record<string, unknown> {
  return {
    ui: { resourceUri: uri },
    [MCP_APP_EXTENSION]: { resourceUri: uri },
  }
}
