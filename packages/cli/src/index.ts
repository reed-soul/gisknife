#!/usr/bin/env node
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerAnalyzeCommands } from './commands/analyze.js'
import { registerConvertCommand } from './commands/convert.js'
import { registerCrsCommand } from './commands/crs.js'
import { registerDoctorCommand } from './commands/doctor.js'
import { registerFetchCommand } from './commands/fetch.js'
import { registerInspectCommands } from './commands/inspect.js'
import { registerMcpCommand } from './commands/mcp.js'
import { registerPickCommand } from './commands/pick.js'
import { registerPreviewCommand } from './commands/preview.js'

export function buildProgram(): Command {
  const program = new Command()
  program
    .name('gisknife')
    .description(
      'The AI-native GIS Swiss Army Knife — CRS, Boundary/OSM Fetch, Format Convert, Spatial SQL, QA, Picker & MCP',
    )
    .version('0.1.0')

  registerDoctorCommand(program)
  registerCrsCommand(program)
  registerFetchCommand(program)
  registerConvertCommand(program)
  registerInspectCommands(program)
  registerAnalyzeCommands(program)
  registerPreviewCommand(program)
  registerPickCommand(program)
  registerMcpCommand(program)

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
