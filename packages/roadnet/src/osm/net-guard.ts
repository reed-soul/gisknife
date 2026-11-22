/**
 * 出网端点守卫：只放行 https 且不指向本机 / 内网 / 保留地址的端点。
 */

export function assertPublicHttpsEndpoint(rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid endpoint URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Endpoint must use https: ${rawUrl}`)
  }
  if (url.username || url.password) {
    throw new Error(`Endpoint must not carry userinfo credentials: ${rawUrl}`)
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (isLocalHostName(host) || isPrivateOrReservedAddress(host)) {
    throw new Error(`Endpoint cannot target localhost, private, or reserved address: ${rawUrl}`)
  }
}

function isLocalHostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
}

function isPrivateOrReservedAddress(host: string): boolean {
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true
    const first = host.split(':')[0]?.toLowerCase() ?? ''
    if (/^f[cd]/.test(first) || /^fe[89ab]/.test(first) || /^ff/.test(first)) return true
    const mapped = host.match(/^::ffff:(\d+(?:\.\d+){3})$/)
    if (mapped && isPrivateIPv4(mapped[1] ?? '')) return true
    return false
  }
  return isPrivateIPv4(host)
}

function isPrivateIPv4(host: string): boolean {
  const matched = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!matched) return false
  const octets = matched.slice(1).map((part) => Number.parseInt(part ?? '', 10))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0) return true
  return false
}
