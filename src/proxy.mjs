// One place decides which proxy a request should use.
//
// The plugin runs inside Magpie's process and also spawns `vibe-acp`, so a
// proxy typed into the panel is not enough: the control plane, the API sockets
// and the child process all need the same exit. The lookup order is explicit
// option, "none", "system", the environment, a probe (tests), then the Windows
// WinINET settings. A PAC script is never evaluated; when the port cannot be
// read the request goes direct, which is what a TUN-mode client wants anyway.

import { spawnSync } from 'node:child_process'

export const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'

export const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
]

const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const OFF_VALUES = new Set(['none', 'off', 'direct', 'disabled', 'no', 'false', '0'])
const SYSTEM_VALUES = new Set(['system', 'auto', 'windows', 'os', 'default'])
const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

export function normalizeProxyUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  return `http://${raw}`
}

export function envProxyUrl(env = process.env) {
  for (const key of ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.trim()) return normalizeProxyUrl(value)
  }
  return undefined
}

export function parseNoProxy(value) {
  if (Array.isArray(value)) return value.flatMap((item) => parseNoProxy(item))
  return String(value ?? '')
    .split(/[,;]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

// "127.0.0.1:7890" and "http=..;https=.." both appear in the registry.
export function parseWindowsProxy(server, enabled = true) {
  if (!enabled) return undefined
  const entries = String(server ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  let candidate
  for (const entry of entries) {
    const split = entry.indexOf('=')
    if (split === -1) {
      candidate ??= entry
      continue
    }
    const scheme = entry.slice(0, split).trim().toLowerCase()
    if (scheme === 'https') {
      candidate = entry.slice(split + 1).trim()
      break
    }
    if (scheme === 'http') candidate ??= entry.slice(split + 1).trim()
  }
  return normalizeProxyUrl(candidate)
}

export function parseWindowsOverride(value) {
  return parseNoProxy(value)
}

export function parseRegistryDump(text) {
  const values = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s+([A-Za-z][A-Za-z0-9]*)\s+REG_[A-Z_]+\s+(.*)$/.exec(line)
    if (match) values[match[1]] = match[2].trim()
  }
  const flag = String(values.ProxyEnable ?? '').trim().toLowerCase()
  const proxy = parseWindowsProxy(values.ProxyServer, flag === '1' || flag === '0x1')
  if (!proxy) return undefined
  return { proxy, bypass: parseWindowsOverride(values.ProxyOverride) }
}

export function readWindowsSystemProxy({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform !== 'win32') return undefined
  try {
    const result = spawnSyncImpl('reg.exe', ['query', REGISTRY_KEY], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    })
    if (!result || result.error || result.status !== 0) return undefined
    return parseRegistryDump(result.stdout)
  } catch {
    return undefined
  }
}

export function shouldBypassProxy(target, noProxy) {
  let url
  try {
    url = target instanceof URL ? target : new URL(String(target))
  } catch {
    return false
  }
  const host = bareHost(url.hostname)
  if (!host) return true
  if (isLoopbackHost(host)) return true
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return parseNoProxy(noProxy).some((rule) => ruleMatches(rule, host, port))
}

// An explicit proxy beats everything, then "none", then "system", then the
// environment, then the Windows settings.
export function resolveProxy(proxyUrl, { env = process.env, probe, noProxy, logger } = {}) {
  const explicit = String(proxyUrl ?? '').trim()
  const lowered = explicit.toLowerCase()
  const rules =
    noProxy === undefined || noProxy === null || noProxy === ''
      ? parseNoProxy(env.NO_PROXY ?? env.no_proxy)
      : parseNoProxy(noProxy)
  const merge = (...lists) => [...new Set(lists.flatMap((list) => parseNoProxy(list)))]

  if (OFF_VALUES.has(lowered)) return { proxy: undefined, bypass: rules, source: 'none' }

  const system = () => (typeof probe === 'function' ? probeSafely(probe, logger) : readWindowsSystemProxy())

  if (SYSTEM_VALUES.has(lowered)) {
    const found = system()
    if (!found?.proxy) return { proxy: undefined, bypass: rules, source: 'none' }
    return { proxy: found.proxy, bypass: merge(rules, found.bypass), source: 'system' }
  }

  if (explicit) return { proxy: normalizeProxyUrl(explicit), bypass: rules, source: 'option' }

  const fromEnv = envProxyUrl(env)
  if (fromEnv) return { proxy: fromEnv, bypass: rules, source: 'environment' }

  const found = system()
  if (found?.proxy) {
    const source = typeof probe === 'function' ? 'system' : 'windows'
    return { proxy: found.proxy, bypass: merge(rules, found.bypass), source }
  }
  return { proxy: undefined, bypass: rules, source: 'none' }
}

function probeSafely(probe, logger) {
  try {
    const found = probe()
    if (!found) return undefined
    if (typeof found === 'string') return { proxy: normalizeProxyUrl(found), bypass: [] }
    const proxy = normalizeProxyUrl(found.proxy)
    if (!proxy) return undefined
    return { proxy, bypass: parseNoProxy(found.bypass) }
  } catch (error) {
    logger?.('warn', `proxy probe failed: ${error?.message ?? error}`)
    return undefined
  }
}

function bareHost(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '')
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function isLoopbackHost(host) {
  return (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || host === '0.0.0.0'
    || host.startsWith('127.')
  )
}

function isPrivateHost(host) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  const [first, second] = parts
  return (
    first === 10
    || first === 127
    || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 169 && second === 254)
  )
}

function ruleMatches(rule, host, port) {
  if (!rule) return false
  if (rule === '*') return true
  if (rule === '<local>') return !host.includes('.') || isPrivateHost(host)
  if (rule.includes('/')) return cidrMatches(rule, host)
  if (rule.includes('-') && rule.includes('*')) return octetRangeMatches(rule, host)

  let value = rule
  const colon = value.lastIndexOf(':')
  if (colon > 0 && colon === value.indexOf(':') && /^\d+$/.test(value.slice(colon + 1))) {
    if (value.slice(colon + 1) !== String(port)) return false
    value = value.slice(0, colon)
  }

  if (value.startsWith('*')) return wildcardMatches(value, host)
  if (value.startsWith('.')) return host === value.slice(1) || host.endsWith(value)
  return host === value || host.endsWith(`.${value}`)
}

function wildcardMatches(value, host) {
  const pattern = `^${value.split('*').map(escapeRe).join('.*')}$`
  return new RegExp(pattern).test(host)
}

// Windows stores LAN ranges as "172.16.*-172.31.*".
function octetRangeMatches(value, host) {
  const [low, high] = value.split('-')
  if (!low || !high) return false
  const lowParts = low.split('.')
  const highParts = high.split('.')
  const hostParts = host.split('.')
  if (hostParts.length !== 4) return false
  // A "*" or a missing octet spans the whole octet, so "172.16.*" covers
  // 172.16.0.0-172.16.255.255 instead of being a three-octet pattern.
  for (let index = 0; index < 4; index += 1) {
    const actual = Number(hostParts[index])
    if (!Number.isInteger(actual)) return false
    const floorPart = lowParts[index]
    const ceilingPart = highParts[index]
    const floor = floorPart === undefined || floorPart === '*' ? 0 : Number(floorPart)
    const ceiling = ceilingPart === undefined || ceilingPart === '*' ? 255 : Number(ceilingPart)
    if (!Number.isInteger(floor) || !Number.isInteger(ceiling)) return false
    if (actual < floor || actual > ceiling) return false
  }
  return true
}

function cidrMatches(value, host) {
  const [base, bits] = value.split('/')
  const size = Number(bits)
  if (!Number.isInteger(size) || size < 0 || size > 32) return false
  const target = ipv4ToInt(host)
  const network = ipv4ToInt(base)
  if (target === null || network === null) return false
  const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0
  return (target & mask) === (network & mask)
}

function ipv4ToInt(address) {
  const parts = String(address ?? '').split('.').map(Number)
  if (parts.length !== 4) return null
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
