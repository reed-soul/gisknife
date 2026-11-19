export interface WorkbenchStep {
  id: string
  operator: string
  params?: Record<string, unknown>
  inputBFileId?: string
}

export interface WorkbenchRecipeFile {
  id: string
  name: string
}

export interface WorkbenchRecipe {
  version: 1 | 2
  name: string
  description?: string
  steps: WorkbenchStep[]
  files?: WorkbenchRecipeFile[]
  createdAt: string
  updatedAt: string
}

export function encodeWorkbenchRecipeHash(recipe: WorkbenchRecipe): string {
  const json = JSON.stringify(recipe)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `#wf=${b64}`
}

export function decodeWorkbenchRecipeHash(hash: string): WorkbenchRecipe | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const match = /(?:^|&)wf=([^&]+)/.exec(raw)
  if (!match) return null
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    const json = new TextDecoder().decode(bytes)
    return JSON.parse(json) as WorkbenchRecipe
  } catch {
    return null
  }
}

/**
 * Generates a gis.taoliapp.com/#wf=... URL so CLI/agent users can seamlessly
 * continue a workflow in the browser workbench (cartographic layout, 3D Cesium,
 * visual DAG) while keeping all local GIS files on their own machine.
 */
export function buildWorkbenchHandoffUrl(
  recipe: Omit<WorkbenchRecipe, 'createdAt' | 'updatedAt'> & {
    createdAt?: string
    updatedAt?: string
  },
  baseUrl = 'https://gis.taoliapp.com',
): string {
  const now = new Date().toISOString()
  const full: WorkbenchRecipe = {
    ...recipe,
    createdAt: recipe.createdAt ?? now,
    updatedAt: recipe.updatedAt ?? now,
  }
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  return `${trimmedBase}/tools/workflow${encodeWorkbenchRecipeHash(full)}`
}
