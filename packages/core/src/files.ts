import fs from 'node:fs'
import path from 'node:path'

export function assertDistinctOutput(input: string, output: string): void {
  const source = fs.statSync(input)
  const target = fs.statSync(output, { throwIfNoEntry: false })
  if (path.resolve(input) === path.resolve(output) || (target && source.dev === target.dev && source.ino === target.ino)) {
    throw new Error('Output would overwrite the input. Choose a separate output file.')
  }
}

export function crsOutputPath(input: string, crs: string, extension: string): string {
  const { dir, name } = path.parse(input)
  return path.join(dir, `${name}_${crs.replace(/[^a-zA-Z0-9_-]/g, '_')}.${extension}`)
}

export function coordinateNumber(value: string | undefined): number {
  return value?.trim() ? Number(value) : NaN
}
