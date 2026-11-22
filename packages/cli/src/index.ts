#!/usr/bin/env node
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { buildWorkbenchHandoffUrl } from '@gisknife/webmcp-bridge'
import { registerAnalyzeCommands } from './commands/analyze.js'
import { registerConvertCommand } from './commands/convert.js'
import { registerCrsCommand } from './commands/crs.js'
import { registerDoctorCommand } from './commands/doctor.js'
import { registerFetchCommand } from './commands/fetch.js'
import { registerInspectCommands } from './commands/inspect.js'
import { registerMcpCommand } from './commands/mcp.js'
import { registerPickCommand } from './commands/pick.js'
import { registerPreviewCommand } from './commands/preview.js'
import { registerRoadnetCommand } from './commands/roadnet.js'

export function buildProgram(): Command {
  const program = new Command()
  program
    .name('gisknife')
    .description(
      'The AI-native GIS Swiss Army Knife — CRS, Format Convert, Spatial SQL, QA, Picker, MCP & Online Fetch (Beta)',
    )
    .version('0.2.0')

  registerDoctorCommand(program)
  registerCrsCommand(program)
  registerFetchCommand(program)
  registerConvertCommand(program)
  registerInspectCommands(program)
  registerAnalyzeCommands(program)
  registerPreviewCommand(program)
  registerPickCommand(program)
  registerRoadnetCommand(program)
  registerMcpCommand(program)
  program.command('handoff <operation>')
    .description('Create a local-file workbench recipe link (buffer, centroid or bbox); no data are embedded')
    .option('--distance <metres>', 'Buffer distance in metres', '500')
    .action((operation: string, opts: { distance: string }) => {
      if (!['buffer', 'centroid', 'bbox'].includes(operation)) throw new Error('Choose buffer, centroid or bbox')
      const metres = Number(opts.distance)
      if (!Number.isFinite(metres) || metres <= 0) throw new Error('Expected a positive distance in metres')
      const url = buildWorkbenchHandoffUrl({ version: 1, name: `gisknife: ${operation}`, steps: [{
        id: 'step-1', operator: `spatial.${operation}`, ...(operation === 'buffer' ? { params: { distanceKm: metres / 1000 } } : {}),
      }] })
      console.log(JSON.stringify({ ok: true, url }))
    })

  return program
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
  const program = buildProgram()
  program.parseAsync(process.argv).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ ok: false, status: 'error', error: msg }, null, 2))
    process.exit(1)
  })
}
