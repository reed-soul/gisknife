export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean
  untrustedContentHint?: boolean
  consequentialHint?: boolean
}

export interface WebMcpToolDescriptor {
  name: string
  description: string
  category: 'crs' | 'format' | 'spatial' | 'generator' | 'sql' | 'tiles' | 'hitl' | 'fetch'
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  annotations?: WebMcpToolAnnotations
}

export interface WebMcpExecutableTool extends WebMcpToolDescriptor {
  execute: (
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>
}

const HINT_READ: WebMcpToolAnnotations = { readOnlyHint: true }
const HINT_UNTRUSTED_READ: WebMcpToolAnnotations = {
  readOnlyHint: true,
  untrustedContentHint: true,
}

/**
 * Canonical WebMCP tool catalog aligned with gis.taoliapp.com's 18 browser-native
 * tools plus 4 HITL/fetch tools (`pick_map_bbox`, `fetch_boundary`, `fetch_osm`,
 * `export_current_session`).
 */
export const WEBMCP_TOOL_CATALOG: WebMcpToolDescriptor[] = [
  // Existing 18 gis.taoliapp.com tools
  {
    name: 'convert_coordinates',
    category: 'crs',
    description: 'Convert a single coordinate pair between CRS (WGS84, EPSG, GCJ02, BD09).',
    inputSchema: {
      type: 'object',
      properties: {
        lon: { type: 'number' },
        lat: { type: 'number' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['lon', 'lat', 'from', 'to'],
    },
    annotations: HINT_READ,
  },
  {
    name: 'batch_convert_coordinates',
    category: 'crs',
    description: 'Batch convert coordinate tuples between CRS.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinates: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['coordinates', 'from', 'to'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'get_supported_crs',
    category: 'crs',
    description: 'List supported CRS and EPSG definitions.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: HINT_READ,
  },
  {
    name: 'validate_crs',
    category: 'crs',
    description: 'Check whether a CRS code or alias is supported.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
    annotations: HINT_READ,
  },
  {
    name: 'get_supported_formats',
    category: 'format',
    description: 'List supported input and output vector/raster formats.',
    inputSchema: { type: 'object', properties: {} },
    annotations: HINT_READ,
  },
  {
    name: 'convert_format',
    category: 'format',
    description: 'Convert vector text/binary payload between GIS formats.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        fromFormat: { type: 'string' },
        toFormat: { type: 'string' },
      },
      required: ['content', 'fromFormat', 'toFormat'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'batch_convert_format',
    category: 'format',
    description: 'Batch convert multiple GIS files to a target format.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object' } },
        toFormat: { type: 'string' },
      },
      required: ['files', 'toFormat'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_buffer',
    category: 'spatial',
    description: 'Generate geodesic/projected buffer polygons around GeoJSON features.',
    inputSchema: {
      type: 'object',
      properties: { geojson: { type: 'object' }, distanceMeters: { type: 'number' } },
      required: ['geojson', 'distanceMeters'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_intersect',
    category: 'spatial',
    description: 'Compute geometric intersection between GeoJSON polygon layers.',
    inputSchema: {
      type: 'object',
      properties: { layerA: { type: 'object' }, layerB: { type: 'object' } },
      required: ['layerA', 'layerB'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_union',
    category: 'spatial',
    description: 'Union GeoJSON polygon features.',
    inputSchema: {
      type: 'object',
      properties: { geojson: { type: 'object' } },
      required: ['geojson'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_difference',
    category: 'spatial',
    description: 'Subtract layerB polygons from layerA.',
    inputSchema: {
      type: 'object',
      properties: { layerA: { type: 'object' }, layerB: { type: 'object' } },
      required: ['layerA', 'layerB'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_simplify',
    category: 'spatial',
    description: 'Simplify GeoJSON geometries using Douglas-Peucker.',
    inputSchema: {
      type: 'object',
      properties: { geojson: { type: 'object' }, tolerance: { type: 'number' } },
      required: ['geojson', 'tolerance'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_explode',
    category: 'spatial',
    description: 'Explode GeoJSON geometries into individual point vertices.',
    inputSchema: {
      type: 'object',
      properties: { geojson: { type: 'object' } },
      required: ['geojson'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_flatten',
    category: 'spatial',
    description: 'Flatten Multi* GeoJSON geometries into single-part features.',
    inputSchema: {
      type: 'object',
      properties: { geojson: { type: 'object' } },
      required: ['geojson'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'spatial_measure',
    category: 'spatial',
    description: 'Measure geodesic area and length of GeoJSON features.',
    inputSchema: {
      type: 'object',
      properties: { geojson: { type: 'object' } },
      required: ['geojson'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'generate_geometry',
    category: 'generator',
    description: 'Generate synthetic grids, Voronoi, TIN, or random points.',
    inputSchema: {
      type: 'object',
      properties: { generator: { type: 'string' }, bbox: { type: 'array' } },
      required: ['generator', 'bbox'],
    },
    annotations: HINT_READ,
  },
  {
    name: 'run_sql_query',
    category: 'sql',
    description: 'Run read-only Spatial SQL over loaded GeoJSON/Parquet via DuckDB-WASM.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'inspect_pmtiles_url',
    category: 'tiles',
    description: 'Inspect metadata and zoom/layer catalog of a remote PMTiles URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  // 4 new HITL / fetch tools extending gis.taoliapp.com
  {
    name: 'pick_map_bbox',
    category: 'hitl',
    description: 'Prompt the user to draw a BBox or polygon interactively on the map.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['bbox', 'polygon'] },
        initialBbox: { type: 'array', items: { type: 'number' } },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fetch_boundary',
    category: 'fetch',
    description: 'Fetch administrative boundary GeoJSON into the browser workbench session.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        level: { type: 'string' },
        toWgs84: { type: 'boolean' },
      },
      required: ['query'],
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'fetch_osm',
    category: 'fetch',
    description: 'Fetch OSM/Overture features for a BBox or place into the workbench.',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string' },
        bbox: { type: 'array', items: { type: 'number' } },
        layers: { type: 'array', items: { type: 'string' } },
      },
    },
    annotations: HINT_UNTRUSTED_READ,
  },
  {
    name: 'export_current_session',
    category: 'format',
    description: 'Export the active workbench layer into a requested GIS format.',
    inputSchema: {
      type: 'object',
      properties: { format: { type: 'string' } },
      required: ['format'],
    },
    annotations: { readOnlyHint: true },
  },
]
