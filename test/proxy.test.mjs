// The proxy lookup is the single place that decides how the plugin leaves
// this machine: the option, "none", "system", the environment, then the
// Windows WinINET settings. Everything here is pure so the tests never touch
// the real network or the machine's registry.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  envProxyUrl,
  normalizeProxyUrl,
  parseRegistryDump,
  parseWindowsProxy,
  readWindowsSystemProxy,
  resolveProxy,
  shouldBypassProxy,
} from '../src/proxy.mjs'

test('normalizeProxyUrl adds a scheme only when one is missing', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
  assert.equal(normalizeProxyUrl('   '), undefined)
  assert.equal(normalizeProxyUrl(undefined), undefined)
})

test('envProxyUrl prefers the https variant and ignores blank values', () => {
  assert.equal(
    envProxyUrl({ HTTP_PROXY: 'http://127.0.0.1:1111', HTTPS_PROXY: 'http://127.0.0.1:2222' }),
    'http://127.0.0.1:2222',
  )
  assert.equal(envProxyUrl({ https_proxy: '127.0.0.1:3333' }), 'http://127.0.0.1:3333')
  assert.equal(envProxyUrl({ HTTPS_PROXY: '   ', ALL_PROXY: '127.0.0.1:4444' }), 'http://127.0.0.1:4444')
  assert.equal(envProxyUrl({}), undefined)
})

test('an unset option follows the system settings before going direct', () => {
  const found = resolveProxy(undefined, { env: {}, probe: () => '127.0.0.1:7890' })
  assert.equal(found.source, 'system')
  assert.equal(found.proxy, 'http://127.0.0.1:7890')
  assert.equal(resolveProxy('', { env: {}, probe: () => undefined }).proxy, undefined)
})

test('an explicit option wins over the environment', () => {
  const found = resolveProxy('http://10.0.0.2:8080', {
    env: { HTTPS_PROXY: 'http://127.0.0.1:1111' },
    probe: () => '127.0.0.1:7890',
  })
  assert.equal(found.source, 'option')
  assert.equal(found.proxy, 'http://10.0.0.2:8080')
})

test('the environment wins over the system settings', () => {
  const found = resolveProxy(undefined, {
    env: { HTTPS_PROXY: 'http://127.0.0.1:2222' },
    probe: () => '127.0.0.1:7890',
  })
  assert.equal(found.source, 'environment')
  assert.equal(found.proxy, 'http://127.0.0.1:2222')
})

test('"system" probes again and beats the environment', () => {
  const found = resolveProxy('system', {
    env: { HTTPS_PROXY: 'http://127.0.0.1:2222' },
    probe: () => '127.0.0.1:7890',
  })
  assert.equal(found.source, 'system')
  assert.equal(found.proxy, 'http://127.0.0.1:7890')
})

test('"none" disables every proxy and never probes', () => {
  let probed = 0
  const found = resolveProxy('none', {
    env: { HTTPS_PROXY: 'http://127.0.0.1:2222' },
    probe: () => {
      probed += 1
      return '127.0.0.1:7890'
    },
  })
  assert.equal(found.source, 'none')
  assert.equal(found.proxy, undefined)
  assert.equal(probed, 0)
})

test('an explicit noProxy list replaces the environment one', () => {
  const found = resolveProxy('http://127.0.0.1:2222', {
    env: { NO_PROXY: 'from-env.example' },
    noProxy: 'from-option.example',
  })
  assert.deepEqual(found.bypass, ['from-option.example'])
})

test('the system bypass list is merged with NO_PROXY', () => {
  const found = resolveProxy(undefined, {
    env: { NO_PROXY: 'corp.example' },
    probe: () => ({ proxy: '127.0.0.1:7890', bypass: 'LAN.example, corp.example' }),
  })
  assert.deepEqual(found.bypass, ['corp.example', 'lan.example'])
})

test('a failing probe logs a warning and goes direct', () => {
  const logs = []
  const found = resolveProxy('system', {
    env: {},
    probe: () => {
      throw new Error('boom')
    },
    logger: (level, message) => logs.push(`${level}: ${message}`),
  })
  assert.equal(found.source, 'none')
  assert.equal(found.proxy, undefined)
  assert.match(logs[0], /^warn: proxy probe failed: boom/)
})

test('parseRegistryDump reads the three Windows shapes', () => {
  const bare = parseRegistryDump(
    [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:7890',
      '    ProxyOverride    REG_SZ    localhost;127.*;172.16.*-172.31.*;<local>',
    ].join('\n'),
  )
  assert.equal(bare.proxy, 'http://127.0.0.1:7890')
  assert.deepEqual(bare.bypass, ['localhost', '127.*', '172.16.*-172.31.*', '<local>'])

  const perScheme = parseRegistryDump('    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=127.0.0.1:7891;https=127.0.0.1:7892')
  assert.equal(perScheme.proxy, 'http://127.0.0.1:7892')

  const off = parseRegistryDump(
    '    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890',
  )
  assert.equal(off, undefined)
  assert.equal(parseRegistryDump(''), undefined)
})

test('parseWindowsProxy honours the enabled flag and prefers https', () => {
  assert.equal(parseWindowsProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(parseWindowsProxy('127.0.0.1:7890', false), undefined)
  assert.equal(parseWindowsProxy('http=127.0.0.1:1;https=127.0.0.1:2'), 'http://127.0.0.1:2')
  assert.equal(parseWindowsProxy(''), undefined)
})

test('non-Windows platforms never shell out to reg.exe', () => {
  let spawned = 0
  const result = readWindowsSystemProxy({
    platform: 'linux',
    spawnSyncImpl: () => {
      spawned += 1
      return { status: 0, stdout: '' }
    },
  })
  assert.equal(result, undefined)
  assert.equal(spawned, 0)
})

test('a failing reg.exe read is silent', () => {
  const failed = readWindowsSystemProxy({
    platform: 'win32',
    spawnSyncImpl: () => ({ error: new Error('missing'), status: 1, stdout: '' }),
  })
  assert.equal(failed, undefined)
})

test('loopback always goes direct, whatever the bypass list says', () => {
  assert.equal(shouldBypassProxy('http://localhost:3000/v1', ''), true)
  assert.equal(shouldBypassProxy('http://127.0.0.5:8080/v1', ''), true)
  assert.equal(shouldBypassProxy('http://[::1]:8080/v1', ''), true)
  assert.equal(shouldBypassProxy('https://api.mistral.ai/v1', ''), false)
})

test('the bypass list understands the Windows and NO_PROXY forms', () => {
  const host = 'https://api.mistral.ai/v1'
  assert.equal(shouldBypassProxy(host, '*'), true)
  assert.equal(shouldBypassProxy(host, 'mistral.ai'), true)
  assert.equal(shouldBypassProxy(host, '.mistral.ai'), true)
  assert.equal(shouldBypassProxy(host, '*.mistral.ai'), true)
  assert.equal(shouldBypassProxy(host, 'example.com'), false)
  assert.equal(shouldBypassProxy('http://example.com:8080/', 'example.com:8080'), true)
  assert.equal(shouldBypassProxy('http://example.com:8080/', 'example.com:9090'), false)
  assert.equal(shouldBypassProxy('http://192.168.1.5/', '192.168.0.0/16'), true)
  assert.equal(shouldBypassProxy('http://10.1.2.3/', '192.168.0.0/16'), false)
  assert.equal(shouldBypassProxy('http://172.20.5.4/', '172.16.*-172.31.*'), true)
  assert.equal(shouldBypassProxy('http://172.32.0.1/', '172.16.*-172.31.*'), false)
  assert.equal(shouldBypassProxy('http://intranet/', '<local>'), true)
  assert.equal(shouldBypassProxy('http://10.0.0.9/', '<local>'), true)
  assert.equal(shouldBypassProxy('http://www.example.com/', '<local>'), false)
})
