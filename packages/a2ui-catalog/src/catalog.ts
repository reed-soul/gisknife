import { z } from 'zod'

export const A2UI_CATALOG_ID = 'gisknife.gis.v1'
export const A2UI_PROTOCOL_VERSION = '1.0' as const

export const BBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

export const MapBBoxPickerPropsSchema = z.object({
  title: z.string(),
  mode: z.enum(['bbox', 'polygon', 'file']),
  initialCenter: z.tuple([z.number(), z.number()]).optional(),
  initialBbox: BBoxSchema.optional(),
  submitAction: z.string().default('gisknife.submitAreaSelection'),
})

export const CrsDisambiguatorPropsSchema = z.object({
  declaredCrs: z.string(),
  suggestedCrs: z.string().optional(),
  suspectedAxisSwap: z.boolean().default(false),
  reason: z.string(),
  samplePoint: z.tuple([z.number(), z.number()]).optional(),
  confirmAction: z.string().default('gisknife.confirmCrsChoice'),
})

export const PlaceDisambiguatorPropsSchema = z.object({
  query: z.string(),
  candidates: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      queryHint: z.string(),
      bbox: BBoxSchema.optional(),
    }),
  ),
  selectAction: z.string().default('gisknife.selectPlaceCandidate'),
})

export const GeoSummaryCardPropsSchema = z.object({
  title: z.string(),
  outputPath: z.string(),
  crs: z.string(),
  featureCount: z.number().int().nonnegative(),
  geometryTypes: z.array(z.string()),
  bbox: BBoxSchema.optional(),
  source: z.string().optional(),
  complianceNote: z.string().optional(),
})

export const LayerQaReportPropsSchema = z.object({
  featureCount: z.number().int().nonnegative(),
  validFeatureCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  fixed: z.boolean(),
  issues: z.array(
    z.object({
      featureIndex: z.number().int().nonnegative(),
      code: z.string(),
      message: z.string(),
    }),
  ),
})

export const ExportDeliveryCardPropsSchema = z.object({
  outputPath: z.string(),
  format: z.string(),
  workbenchUrl: z.string().url().optional(),
  previewHtmlPath: z.string().optional(),
})

export const GIS_A2UI_CATALOG = {
  MapBBoxPicker: {
    component: 'MapBBoxPicker',
    description: 'Interactive MapLibre GL BBox / Polygon selector and local file dropzone.',
    schema: MapBBoxPickerPropsSchema,
  },
  CrsDisambiguator: {
    component: 'CrsDisambiguator',
    description: 'Interactive CRS confirmation dialog for CGCS2000 zone prefixes (4547/4526) and XY swaps.',
    schema: CrsDisambiguatorPropsSchema,
  },
  PlaceDisambiguator: {
    component: 'PlaceDisambiguator',
    description: 'Candidate selector for ambiguous place queries (e.g., Washington State vs D.C.).',
    schema: PlaceDisambiguatorPropsSchema,
  },
  GeoSummaryCard: {
    component: 'GeoSummaryCard',
    description: 'Compact spatial summary card displaying CRS, feature count, bbox, source, and compliance.',
    schema: GeoSummaryCardPropsSchema,
  },
  LayerQaReport: {
    component: 'LayerQaReport',
    description: 'Topology QA scorecard showing invalid rings, kinks, and auto-fix status.',
    schema: LayerQaReportPropsSchema,
  },
  ExportDeliveryCard: {
    component: 'ExportDeliveryCard',
    description: 'Download / HTML QA / gis.taoliapp.com #wf= handoff delivery card.',
    schema: ExportDeliveryCardPropsSchema,
  },
} as const

export type GisA2UIComponentName = keyof typeof GIS_A2UI_CATALOG

export function validateCatalogComponentProps<K extends GisA2UIComponentName>(
  component: K,
  props: unknown,
): z.infer<(typeof GIS_A2UI_CATALOG)[K]['schema']> {
  return GIS_A2UI_CATALOG[component].schema.parse(props) as z.infer<
    (typeof GIS_A2UI_CATALOG)[K]['schema']
  >
}
