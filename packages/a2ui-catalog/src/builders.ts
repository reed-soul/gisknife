import {
  A2UI_CATALOG_ID,
  A2UI_PROTOCOL_VERSION,
  validateCatalogComponentProps,
  type GisA2UIComponentName,
} from './catalog.js'

export interface A2UIComponentNode {
  id: string
  component: GisA2UIComponentName
  props: Record<string, unknown>
}

export interface A2UISurfaceEnvelope {
  version: typeof A2UI_PROTOCOL_VERSION
  createSurface: {
    surfaceId: string
    catalogId: string
    components: Array<{ id: string; component: GisA2UIComponentName } & Record<string, unknown>>
    dataModel?: Record<string, unknown>
  }
}

export interface A2UIRpcCall {
  version: typeof A2UI_PROTOCOL_VERSION
  callAgentFunction?: {
    surfaceId: string
    functionCallId: string
    callFunction: Record<string, unknown>
  }
  callRendererFunction?: {
    surfaceId: string
    functionCallId: string
    callFunction: Record<string, unknown>
  }
}

export function createGisSurface<K extends GisA2UIComponentName>(params: {
  surfaceId: string
  component: K
  props: unknown
  dataModel?: Record<string, unknown>
}): A2UISurfaceEnvelope {
  const validated = validateCatalogComponentProps(params.component, params.props)
  return {
    version: A2UI_PROTOCOL_VERSION,
    createSurface: {
      surfaceId: params.surfaceId,
      catalogId: A2UI_CATALOG_ID,
      components: [{ ...validated, id: 'root', component: params.component }],
      ...(params.dataModel ? { dataModel: params.dataModel } : {}),
    },
  }
}

export function buildAgentRpcCall(
  surfaceId: string,
  functionName: string,
  args: Record<string, unknown>,
): A2UIRpcCall {
  return {
    version: A2UI_PROTOCOL_VERSION,
    callAgentFunction: {
      surfaceId,
      functionCallId: crypto.randomUUID(),
      callFunction: { ...args, '@call': functionName },
    },
  }
}

export function buildRendererRpcCall(
  surfaceId: string,
  functionName: string,
  args: Record<string, unknown>,
): A2UIRpcCall {
  return {
    version: A2UI_PROTOCOL_VERSION,
    callRendererFunction: {
      surfaceId,
      functionCallId: crypto.randomUUID(),
      callFunction: { ...args, '@call': functionName, catalogId: A2UI_CATALOG_ID },
    },
  }
}
