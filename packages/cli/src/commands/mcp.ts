import { runGisMcpStdio } from '@gisknife/mcp'
import type { Command } from 'commander'
import { runPythonEngine } from '../engineBridge.js'

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Start the gisknife stdio MCP server (with MCP Apps ui:// widgets and Python uvx bridge)')
    .action(async () => {
      await runGisMcpStdio({ heavyRunner: runPythonEngine })
    })
}
