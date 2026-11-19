import type { WebMcpExecutableTool } from './tools.js'

export interface ModelContextLike {
  registerTool: (
    tool: {
      name: string
      description: string
      inputSchema: Record<string, unknown>
      annotations?: Record<string, unknown>
      execute: (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>
    },
    options?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>
}

export interface WebMcpRegistrationHandle {
  registeredCount: number
  unregister: () => void
}

export function resolveModelContext(root?: {
  modelContext?: ModelContextLike
}): ModelContextLike | undefined {
  if (root?.modelContext) return root.modelContext
  if (typeof document !== 'undefined') {
    const doc = document as unknown as { modelContext?: ModelContextLike }
    if (doc.modelContext) return doc.modelContext
  }
  if (typeof navigator !== 'undefined') {
    const nav = navigator as unknown as { modelContext?: ModelContextLike }
    if (nav.modelContext) return nav.modelContext
  }
  return undefined
}

/**
 * Registers WebMCP tools using the canonical Chrome 150+ AbortController lifecycle.
 */
export async function registerGisWebMcpTools(
  tools: WebMcpExecutableTool[],
  mcOverride?: ModelContextLike,
): Promise<WebMcpRegistrationHandle> {
  const mc = mcOverride ?? resolveModelContext()
  if (!mc || typeof mc.registerTool !== 'function') {
    return { registeredCount: 0, unregister: () => {} }
  }

  const controller = new AbortController()
  let registeredCount = 0

  try {
    for (const tool of tools) {
      if (controller.signal.aborted) break
      await Promise.resolve(
        mc.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations as Record<string, unknown> | undefined,
            execute: async (input, options) => tool.execute(input, options),
          },
          { signal: controller.signal },
        ),
      )
      registeredCount += 1
    }
  } catch (err) {
    controller.abort()
    throw err
  }

  return {
    registeredCount,
    unregister: () => controller.abort(),
  }
}
