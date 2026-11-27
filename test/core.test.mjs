import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STATIC_VIBE_MODELS,
  identifyKey,
  isStreamBody,
  loadModels,
  originOf,
  sanitizeHeaders,
  whoamiUrlOf,
} from '../src/core.mjs'

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

test('sanitizeHeaders keeps protocol headers and affinity, drops fingerprints', () => {
  const headers = sanitizeHeaders(
    {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-affinity': 's-1',
      'x-session-id': 's-1',
      'x-session-affinity': 's-1',
      'user-agent': 'some-harness/1.0',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '5.0.0',
      origin: 'https://example.test',
      referer: 'https://example.test',
      cookie: 'a=b',
      'x-api-key': 'stale',
      'anthropic-version': '2023-06-01',
      'x-forwarded-for': '1.2.3.4',
      via: 'proxy',
      host: 'api.mistral.ai',
      'content-length': '999',
      'accept-encoding': 'gzip',
    },
    { key: 'vibe-key' },
  )

  assert.equal(headers.get('authorization'), 'Bearer vibe-key')
  assert.equal(headers.get('x-affinity'), 's-1')
  assert.equal(headers.get('x-session-id'), 's-1')
  assert.equal(headers.get('x-session-affinity'), 's-1')
  assert.equal(headers.get('accept'), 'text/event-stream')
  for (const dropped of [
    'user-agent',
    'x-stainless-lang',
    'x-stainless-package-version',
    'origin',
    'referer',
    'cookie',
    'x-api-key',
    'anthropic-version',
    'x-forwarded-for',
    'via',
    'host',
    'content-length',
    'accept-encoding',
  ]) {
    assert.equal(headers.get(dropped), null, `${dropped} must not be forwarded`)
  }
})

test('sanitizeHeaders writes no User-Agent unless one is configured', () => {
  assert.equal(sanitizeHeaders(null, { key: 'k' }).get('user-agent'), null)
  assert.equal(sanitizeHeaders(null, { key: 'k', userAgent: 'explicit/1.0' }).get('user-agent'), 'explicit/1.0')
})

test('sanitizeHeaders picks accept from the body', () => {
  assert.equal(sanitizeHeaders(null, { stream: true }).get('accept'), 'text/event-stream')
  assert.equal(sanitizeHeaders(null, { stream: false, incoming: undefined }).get('accept'), 'application/json')
  assert.equal(sanitizeHeaders({ accept: '*/*' }, {}).get('accept'), 'application/json')
  assert.equal(sanitizeHeaders({ accept: 'application/x-test' }, {}).get('accept'), 'application/x-test')
  assert.equal(isStreamBody('{"model":"m","stream":true}'), true)
  assert.equal(isStreamBody('{"model":"m","stream":false}'), false)
  assert.equal(isStreamBody(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '{"stream": true}' }], stream: false })), false)
})

test('originOf strips the version segment, whoami never lands on /v1/api', () => {
  assert.equal(originOf('https://api.mistral.ai/v1'), 'https://api.mistral.ai')
  assert.equal(originOf('https://api.mistral.ai/v1/'), 'https://api.mistral.ai')
  assert.equal(originOf('https://api.mistral.ai/api/v1'), 'https://api.mistral.ai')
  assert.equal(originOf('https://console.mistral.ai/api'), 'https://console.mistral.ai/api')
  assert.equal(whoamiUrlOf({ consoleBase: 'https://api.mistral.ai/v1' }), 'https://api.mistral.ai/api/vibe/whoami')
  assert.equal(whoamiUrlOf({ consoleBase: 'https://console.mistral.ai' }), 'https://console.mistral.ai/api/vibe/whoami')
  assert.equal(whoamiUrlOf({ consoleBase: 'https://console.mistral.ai/api' }), 'https://console.mistral.ai/api/vibe/whoami')
})

test('identifyKey maps CHAT to vibe, API to api, and unreachable to unknown', async () => {
  const seen = []
  const fetchFor = (payload, status = 200) => async (url) => {
    seen.push(String(url))
    return json(payload, status)
  }

  assert.equal((await identifyKey('k', { consoleBase: 'https://api.mistral.ai/v1', fetch: fetchFor({ plan_type: 'CHAT', plan_name: 'Vibe Pro' }) })).keyType, 'vibe')
  assert.equal((await identifyKey('k', { fetch: fetchFor({ plan_type: 'API' }) })).keyType, 'api')
  assert.equal((await identifyKey('k', { fetch: fetchFor({}) })).keyType, 'unknown')
  assert.equal((await identifyKey('k', { fetch: fetchFor({}, 401) })).status, 401)
  assert.equal((await identifyKey('k', { fetch: async () => { throw new Error('offline') } })).keyType, 'unknown')
  assert.equal(seen[0], 'https://api.mistral.ai/api/vibe/whoami')
  assert.equal((await identifyKey('k', { baseUrl: 'https://api.mistral.ai/v1', fetch: fetchFor({ plan_type: 'CHAT' }) })).keyType, 'vibe')
  assert.equal(seen.at(-1), 'https://api.mistral.ai/api/vibe/whoami')
})

test('STATIC_VIBE_MODELS is the Vibe surface only', () => {
  const ids = Object.keys(STATIC_VIBE_MODELS)
  assert.deepEqual(ids.sort(), [
    'deepseek-v4-1-flash-1017',
    'mistral-large-4-0',
    'mistral-medium-latest',
    'mistral-vibe-cli-fast',
    'mistral-vibe-cli-latest',
    'mistral-vibe-cli-with-tools',
    'zai-glm-5-3',
    'zai-glm-5-3-flash',
    'zai-glm-5-3-flash-vibe-free',
  ])
  for (const id of ids) assert.equal(/^(codestral|ministral|pixtral)/.test(id), false)
  assert.deepEqual(STATIC_VIBE_MODELS['deepseek-v4-1-flash-1017'].cost, {
    input: 0.3,
    output: 1.2,
    cache: { read: 0.007, write: 0 },
  })
  assert.equal(STATIC_VIBE_MODELS['mistral-medium-latest'].cost, undefined)
})

test('loadModels prefers the Vibe catalog and filters API-surface models', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return json({
      models: [
        { id: 'deepseek-v4-1-flash-1017', label: 'DeepSeek V4.1 Flash', max_context_length: 1_048_576 },
        { id: 'codestral-latest', label: 'Codestral' },
      ],
    })
  }
  const models = await loadModels({ key: 'k', keyType: 'vibe', options: { fetch: fetchImpl } })
  assert.ok(models['deepseek-v4-1-flash-1017'])
  assert.equal(models['codestral-latest'], undefined)
  assert.ok(models['mistral-vibe-cli-latest'])
  assert.ok(models['mistral-vibe-cli-with-tools'])
  assert.ok(models['mistral-vibe-cli-fast'])
  assert.equal(models['deepseek-v4-1-flash-1017'].limit.context, 1_048_576)
  assert.match(urls[0], /\/model-catalog\?surface=vibe-code$/)
})

test('loadModels falls back to /models and keeps only Vibe ids', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/model-catalog')) return json({ error: 'nope' }, 404)
    return json({
      data: [
        { id: 'mistral-large-4-0', max_context_length: 1_048_576, capabilities: { reasoning: true, vision: true } },
        { id: 'codestral-latest', billing_model_name: 'codestral-2508' },
        { id: 'mistral-large-latest', billing_model_name: 'mistral-large-2512' },
      ],
    })
  }
  const models = await loadModels({ key: 'k', keyType: 'vibe', options: { fetch: fetchImpl } })
  assert.ok(models['mistral-large-4-0'])
  assert.equal(models['codestral-latest'], undefined)
  assert.equal(models['mistral-large-latest'], undefined)
  assert.ok(models['mistral-vibe-cli-latest'])
  assert.equal(models['mistral-large-4-0'].capabilities.input.image, true)
})

test('loadModels returns the static surface when both reads fail', async () => {
  const models = await loadModels({
    key: 'k',
    keyType: 'vibe',
    options: { fetch: async () => json({}, 500) },
  })
  assert.deepEqual(Object.keys(models).sort(), Object.keys(STATIC_VIBE_MODELS).sort())
})

test('an API key sees API-surface models only when asked', async () => {
  const fetchImpl = async () =>
    json({ models: [{ id: 'codestral-latest' }, { id: 'mistral-medium-latest' }] })
  const vibe = await loadModels({ key: 'k', keyType: 'api', options: { fetch: fetchImpl } })
  assert.ok(vibe['mistral-medium-latest'])
  assert.equal(vibe['codestral-latest'], undefined)
  assert.ok(vibe['mistral-vibe-cli-latest'])
  const all = await loadModels({
    key: 'k',
    keyType: 'api',
    options: { fetch: fetchImpl, includeApiSurface: true },
  })
  assert.deepEqual(Object.keys(all).sort(), ['codestral-latest', 'mistral-medium-latest'])
})
