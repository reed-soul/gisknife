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
  a2uiVersion: typeof A2UI_PROTOCOL_VERSION
  surfaceId: string
  createSurface?: {
    catalogId: string
    rootComponentId: string
  }
  updateComponents?: A2UIComponentNode[]
  updateDataModel?: Record<string, unknown>
}

export interface A2UIRpcCall {
  a2uiVersion: typeof A2UI_PROTOCOL_VERSION
  surfaceId: string
  callAgentFunction?: {
    name: string
    arguments: Record<string, unknown>
  }
  callRendererFunction?: {
    name: string
    arguments: Record<string, unknown>
  }
}

export function createGisSurface<K extends GisA2UIComponentName>(params: {
  surfaceId: string
  rootComponentId: string
  component: K
  props: unknown
  dataModel?: Record<string, unknown>
}): A2UISurfaceEnvelope {
  const validated = validateCatalogComponentProps(params.component, params.props)
  return {
    a2uiVersion: A2UI_PROTOCOL_VERSION,
    surfaceId: params.surfaceId,
    createSurface: {
      catalogId: A2UI_CATALOG_ID,
      rootComponentId: params.rootComponentId,
    },
    updateComponents: [
      {
        id: params.rootComponentId,
        component: params.component,
        props: validated as Record<string, unknown>,
      },
    ],
    ...(params.dataModel ? { updateDataModel: params.dataModel } : {}),
  }
}

export function buildAgentRpcCall(
  surfaceId: string,
  functionName: string,
  args: Record<string, unknown>,
): A2UIRpcCall {
  return {
    a2uiVersion: A2UI_PROTOCOL_VERSION,
    surfaceId,
    callAgentFunction: {
      name: functionName,
      arguments: args,
    },
  }
}

export function buildRendererRpcCall(
  surfaceId: string,
  functionName: string,
  args: Record<string, unknown>,
): A2UIRpcCall {
  return {
    a2uiVersion: A2UI_PROTOCOL_VERSION,
    surfaceId,
    callRendererFunction: {
      name: functionName,
      arguments: args,
    },
  }
}
