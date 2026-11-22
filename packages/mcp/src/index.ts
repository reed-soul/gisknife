#!/usr/bin/env node
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerGisMcpCapabilities, type HeavyEngineRunner } from './tools.js'

export * from './tools.js'

export interface CreateGisMcpServerOptions {
  heavyRunner?: HeavyEngineRunner
}

export function createGisMcpServer(options: CreateGisMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'gisknife',
    version: '0.2.0',
  })
  registerGisMcpCapabilities(server, { heavyRunner: options.heavyRunner })
  return server
}

export async function runGisMcpStdio(options: CreateGisMcpServerOptions = {}): Promise<void> {
  const server = createGisMcpServer(options)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function isExecutedDirectly(): boolean {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isExecutedDirectly()) {
  runGisMcpStdio().catch((err) => {
    console.error('[gisknife-mcp] fatal:', err)
    process.exit(1)
  })
}
