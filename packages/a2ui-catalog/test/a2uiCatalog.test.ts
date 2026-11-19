import { EventType } from '@ag-ui/core'
import { describe, expect, it } from 'vitest'
import {
  A2UI_CATALOG_ID,
  A2UI_PROTOCOL_VERSION,
  buildAgentRpcCall,
  createGisSurface,
  getUiSdkBehaviorSpec,
  GisAgUiEmitter,
} from '../src/index.js'

describe('@gisknife/a2ui-catalog', () => {
  it('validates A2UI 1.0 GIS catalog surfaces and builds RPC calls', () => {
    const surface = createGisSurface({
      surfaceId: 'crs-check-1',
      rootComponentId: 'crs-dialog',
      component: 'CrsDisambiguator',
      props: {
        declaredCrs: 'EPSG:4547',
        suggestedCrs: 'EPSG:4526',
        suspectedAxisSwap: false,
        reason: '8-digit Easting 38500000 carries zone prefix 38.',
        samplePoint: [38500000, 2500000],
      },
    })

    expect(surface.a2uiVersion).toBe(A2UI_PROTOCOL_VERSION)
    expect(surface.createSurface?.catalogId).toBe(A2UI_CATALOG_ID)
    expect(surface.updateComponents?.[0].component).toBe('CrsDisambiguator')

    const rpc = buildAgentRpcCall('crs-check-1', 'gisknife.confirmCrsChoice', {
      useCrs: 'EPSG:4526',
    })
    expect(rpc.callAgentFunction?.name).toBe('gisknife.confirmCrsChoice')
  })

  it('streams A2UI frames inside AG-UI @ag-ui/core lifecycle events and maps @ui-sdk/core specs', () => {
    const emitter = new GisAgUiEmitter('thread-1', 'run-1')
    const start = emitter.runStarted()
    const stepStart = emitter.stepStarted('crs_check')
    const custom = emitter.a2uiSurface(
      createGisSurface({
        surfaceId: 'summary-1',
        rootComponentId: 'card',
        component: 'GeoSummaryCard',
        props: {
          title: 'Nanshan Streets',
          outputPath: './nanshan.geojson',
          crs: 'EPSG:4326',
          featureCount: 8,
          geometryTypes: ['MultiPolygon'],
        },
      }),
    )
    const end = emitter.runFinished({ ok: true })

    expect(start.type).toBe(EventType.RUN_STARTED)
    expect(stepStart.type).toBe(EventType.STEP_STARTED)
    expect(custom.type).toBe(EventType.CUSTOM)
    expect(custom.name).toBe('a2ui.frame')
    expect(end.type).toBe(EventType.RUN_FINISHED)

    const uiSpec = getUiSdkBehaviorSpec('CrsDisambiguator')
    expect(uiSpec.focusTrap).toBe(true)
    expect(uiSpec.primitives).toContain('AlertDialog')
  })
})
