import type { GisknifeWarning } from '../types.js'
import { getCrsEntry, normalizeCrsCode } from './catalog.js'

export interface SniffPoint {
  x: number
  y: number
}

export interface SniffReport {
  warnings: GisknifeWarning[]
  suggestedFromCrs?: string
  suggestedSwapAxes: boolean
}

const CHINA_LON_MIN = 72
const CHINA_LON_MAX = 138
const CHINA_LAT_MIN = 3
const CHINA_LAT_MAX = 56

function isChinaGaussKrugerProjected(canonicalCrs: string): boolean {
  const match = /^EPSG:(\d+)$/.exec(canonicalCrs)
  if (!match) return false
  const num = Number(match[1])
  // CGCS2000 3-deg (4513-4554) and 6-deg (4491-4512) + Xian80/Beijing54 Gauss-Kruger ranges
  return (num >= 4491 && num <= 4554) || (num >= 2327 && num <= 2390) || (num >= 21413 && num <= 21483)
}

function parseCgcs2000ThreeDeg(canonicalCrs: string): { zoned: boolean; zone: number } | null {
  const match = /^EPSG:(\d+)$/.exec(canonicalCrs)
  if (!match) return null
  const num = Number(match[1])
  if (num >= 4513 && num <= 4533) {
    return { zoned: true, zone: num - 4488 }
  }
  if (num >= 4534 && num <= 4554) {
    return { zoned: false, zone: num - 4509 }
  }
  return null
}

function looksLikeChinaNorthing(v: number): boolean {
  return v >= 1_500_000 && v <= 6_500_000
}

function looksLikeChinaUnzonedEasting(v: number): boolean {
  return v >= 100_000 && v <= 900_000
}

function looksLikeChinaZonedEasting(v: number): boolean {
  return v >= 24_000_000 && v <= 46_000_000
}

function looksLikeAnyChinaEasting(v: number): boolean {
  return looksLikeChinaUnzonedEasting(v) || looksLikeChinaZonedEasting(v)
}

/**
 * Inspects sample input coordinates against the declared source CRS to catch
 * the top silent GIS mistakes before writing corrupt files:
 *  1. Surveying X=North / Y=East axis swaps
 *  2. CGCS2000 3-degree zone-prefix mismatches (e.g. EPSG:4547 vs EPSG:4526)
 *  3. Geographic [lat, lon] vs [lon, lat] swaps
 */
export function sniffCoordinates(points: SniffPoint[], declaredFromCrs: string): SniffReport {
  const warnings: GisknifeWarning[] = []
  if (points.length === 0) {
    return { warnings, suggestedSwapAxes: false }
  }

  const canonical = normalizeCrsCode(declaredFromCrs)
  const entry = getCrsEntry(canonical)
  const sample = points.slice(0, 50)

  let suggestedSwapAxes = false
  let suggestedFromCrs: string | undefined

  // 1. Geographic lat/lon swap detection
  if (canonical === 'EPSG:4326' || canonical === 'EPSG:4490' || canonical === 'GCJ02' || canonical === 'BD09' || entry?.kind === 'geographic') {
    const obviousLatLonSwaps = sample.filter(
      (p) => Math.abs(p.x) <= 90 && Math.abs(p.y) > 90 && Math.abs(p.y) <= 180,
    ).length
    const chinaLatLonSwaps = sample.filter(
      (p) => p.x >= CHINA_LAT_MIN && p.x <= CHINA_LAT_MAX && p.y >= CHINA_LON_MIN && p.y <= CHINA_LON_MAX,
    ).length

    if (obviousLatLonSwaps > sample.length / 2 || (chinaLatLonSwaps > sample.length / 2 && (canonical === 'EPSG:4490' || canonical === 'GCJ02' || canonical === 'BD09'))) {
      suggestedSwapAxes = true
      warnings.push({
        code: 'SUSPECTED_LAT_LON_SWAP',
        message: `Input coordinates look like [lat, lon] instead of [lon, lat] for ${canonical}.`,
        suggestion: 'Re-run with --swap-axes (or --auto-fix) after verifying input column order.',
        details: { samplePoint: sample[0] },
      })
    }
    return { warnings, suggestedSwapAxes }
  }

  // 2. China Gauss-Kruger projected checks (surveying axis swap + zone prefix mismatch)
  if (isChinaGaussKrugerProjected(canonical)) {
    const swapVotes = sample.filter(
      (p) => looksLikeChinaNorthing(p.x) && looksLikeAnyChinaEasting(p.y),
    ).length
    if (swapVotes > sample.length / 2) {
      suggestedSwapAxes = true
      warnings.push({
        code: 'SUSPECTED_AXIS_SWAP',
        message: `Input coordinates match China surveying convention (X=North ~${Math.round(sample[0].x)}, Y=East ~${Math.round(sample[0].y)}), whereas GIS/proj4 expects X=East, Y=North.`,
        suggestion: 'Pass --swap-axes (or --auto-fix) to swap X/Y before transforming.',
        details: { samplePoint: sample[0] },
      })
    }

    const effectiveSample = suggestedSwapAxes
      ? sample.map((p) => ({ x: p.y, y: p.x }))
      : sample

    const cgcs = parseCgcs2000ThreeDeg(canonical)
    if (cgcs) {
      if (!cgcs.zoned) {
        // Declared unzoned (e.g. EPSG:4547 CM 114E, expected Easting 100k..900k)
        const zonedSample = effectiveSample.find((p) => looksLikeChinaZonedEasting(p.x))
        if (zonedSample) {
          const detectedZone = Math.floor(zonedSample.x / 1_000_000)
          if (detectedZone >= 25 && detectedZone <= 45) {
            const candidateCode = `EPSG:${4488 + detectedZone}`
            suggestedFromCrs = candidateCode
            warnings.push({
              code: 'ZONE_PREFIX_MISMATCH',
              message: `Declared ${canonical} (unzoned, 6-digit Easting ~500,000), but Easting ${zonedSample.x} carries 2-digit zone prefix ${detectedZone}.`,
              suggestion: `Use ${candidateCode} (CGCS2000 3-degree zone ${detectedZone}) instead of ${canonical}, or pass --auto-fix.`,
              details: { declaredCrs: canonical, suggestedCrs: candidateCode, detectedZone, sampleEasting: zonedSample.x },
            })
          }
        }
      } else {
        // Declared zoned (e.g. EPSG:4526 zone 38, expected Easting 38,xxx,xxx)
        const unzonedVotes = effectiveSample.filter((p) => looksLikeChinaUnzonedEasting(p.x)).length
        if (unzonedVotes > effectiveSample.length / 2) {
          const candidateCode = `EPSG:${4509 + cgcs.zone}`
          suggestedFromCrs = candidateCode
          warnings.push({
            code: 'ZONE_PREFIX_MISMATCH',
            message: `Declared ${canonical} (zone ${cgcs.zone}, 8-digit Easting ~${cgcs.zone}500000), but Easting ${effectiveSample[0].x} has no zone prefix.`,
            suggestion: `Use ${candidateCode} (unzoned CM ${cgcs.zone * 3}E) instead of ${canonical}, or pass --auto-fix.`,
            details: { declaredCrs: canonical, suggestedCrs: candidateCode, sampleEasting: effectiveSample[0].x },
          })
        } else {
          const wrongZoneSample = effectiveSample.find(
            (p) => looksLikeChinaZonedEasting(p.x) && Math.floor(p.x / 1_000_000) !== cgcs.zone,
          )
          if (wrongZoneSample) {
            const detectedZone = Math.floor(wrongZoneSample.x / 1_000_000)
            if (detectedZone >= 25 && detectedZone <= 45) {
              const candidateCode = `EPSG:${4488 + detectedZone}`
              suggestedFromCrs = candidateCode
              warnings.push({
                code: 'ZONE_PREFIX_MISMATCH',
                message: `Declared ${canonical} (zone ${cgcs.zone}), but Easting ${wrongZoneSample.x} carries zone prefix ${detectedZone}.`,
                suggestion: `Use ${candidateCode} instead of ${canonical}, or pass --auto-fix.`,
                details: { declaredCrs: canonical, suggestedCrs: candidateCode, detectedZone },
              })
            }
          }
        }
      }
    }
  }

  return { warnings, suggestedFromCrs, suggestedSwapAxes }
}

/**
 * Validates transformed WGS84 output against sensible global/China bounds.
 */
export function checkPostTransformBounds(
  wgs84Points: SniffPoint[],
  declaredFromCrs: string,
): GisknifeWarning[] {
  if (wgs84Points.length === 0) return []
  const canonical = normalizeCrsCode(declaredFromCrs)
  const warnings: GisknifeWarning[] = []

  const invalid = wgs84Points.find(
    (p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 180 || Math.abs(p.y) > 90,
  )
  if (invalid) {
    warnings.push({
      code: 'OUT_OF_EXPECTED_BOUNDS',
      message: `Converted WGS84 coordinate [${invalid.x}, ${invalid.y}] is outside [-180..180, -90..90]. Check source CRS (${canonical}) and X/Y order.`,
    })
    return warnings
  }

  if (isChinaGaussKrugerProjected(canonical) || canonical === 'EPSG:4490' || canonical === 'GCJ02' || canonical === 'BD09') {
    const outsideChina = wgs84Points.find(
      (p) => p.x < CHINA_LON_MIN || p.x > CHINA_LON_MAX || p.y < CHINA_LAT_MIN || p.y > CHINA_LAT_MAX,
    )
    if (outsideChina) {
      warnings.push({
        code: 'OUT_OF_EXPECTED_BOUNDS',
        message: `Transformed coordinate [${outsideChina.x.toFixed(6)}, ${outsideChina.y.toFixed(6)}] falls outside China extent despite China CRS ${canonical}.`,
        suggestion: 'Verify whether zone prefix (e.g. EPSG:4547 vs EPSG:4526) or X/Y axes were swapped.',
      })
    }
  }

  return warnings
}
