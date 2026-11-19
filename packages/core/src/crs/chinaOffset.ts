/**
 * Mathematical transforms between WGS84, GCJ-02 (Mars), and BD-09 (Baidu).
 * Pure trigonometry, zero external dependencies.
 */

const PI = Math.PI
const X_PI = (PI * 3000.0) / 180.0
const A = 6378245.0
// First eccentricity squared of Krasovsky 1941 ellipsoid used by GCJ-02.
const EE = 0.00669342162296594

export interface LonLat {
  lon: number
  lat: number
}

export function isOutOfChina(lon: number, lat: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLatDelta(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLonDelta(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

function gcjDelta(lon: number, lat: number): LonLat {
  let dLat = transformLatDelta(lon - 105.0, lat - 35.0)
  let dLon = transformLonDelta(lon - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lon: dLon, lat: dLat }
}

export function wgs84ToGcj02(lon: number, lat: number): LonLat {
  if (isOutOfChina(lon, lat)) {
    return { lon, lat }
  }
  const delta = gcjDelta(lon, lat)
  return { lon: lon + delta.lon, lat: lat + delta.lat }
}

/**
 * Iterative inverse of wgs84ToGcj02, converging to < 1e-8 deg (~1 mm).
 */
export function gcj02ToWgs84(lon: number, lat: number): LonLat {
  if (isOutOfChina(lon, lat)) {
    return { lon, lat }
  }
  let wLon = lon
  let wLat = lat
  const threshold = 1e-8
  for (let i = 0; i < 15; i += 1) {
    const gcj = wgs84ToGcj02(wLon, wLat)
    const dLon = gcj.lon - lon
    const dLat = gcj.lat - lat
    wLon -= dLon
    wLat -= dLat
    if (Math.abs(dLon) < threshold && Math.abs(dLat) < threshold) {
      break
    }
  }
  return { lon: wLon, lat: wLat }
}

export function gcj02ToBd09(lon: number, lat: number): LonLat {
  const z = Math.sqrt(lon * lon + lat * lat) + 0.00002 * Math.sin(lat * X_PI)
  const theta = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * X_PI)
  return {
    lon: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006,
  }
}

export function bd09ToGcj02(lon: number, lat: number): LonLat {
  const x = lon - 0.0065
  const y = lat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI)
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI)
  return {
    lon: z * Math.cos(theta),
    lat: z * Math.sin(theta),
  }
}

export function wgs84ToBd09(lon: number, lat: number): LonLat {
  const gcj = wgs84ToGcj02(lon, lat)
  return gcj02ToBd09(gcj.lon, gcj.lat)
}

export function bd09ToWgs84(lon: number, lat: number): LonLat {
  const gcj = bd09ToGcj02(lon, lat)
  return gcj02ToWgs84(gcj.lon, gcj.lat)
}
