import test from 'node:test'
import assert from 'node:assert/strict'

import plugin, { server, _internal } from '../index.mjs'

const KEY = 'vibe-key-1'
const RESET = new Date(Date.now() + 5 * 86_400_000).toISOString()

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function mockServer(state = {}) {
  const requests = []
  const fetchImpl = async (input, init = {}) => {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null
    const url = new URL(request ? request.url : String(input))
    const headers = new Headers(init.headers ?? request?.headers)
    requests.push({
      url: url.href,
      path: url.pathname,
      method: init.method ?? request?.method ?? 'GET',
      headers,
      body: init.body,
    })

    if (url.pathname === '/api/vibe/whoami') {
      return json({
        plan_name: state.planName ?? 'Vibe Pro',
        plan_type: state.planType ?? 'CHAT',
        has_paid_vibe_entitlement: true,
        customer_id: 'cust-1',
      })
    }
    if (url.pathname === '/api/vibe/sign-in') {
      return json({
        process_id: 'p1',
        sign_in_url: 'https://console.test/login?p=1',
        poll_url: 'http://mock.local/api/vibe/sign-in/p1/poll',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
    }
    if (url.pathname === '/api/vibe/sign-in/p1/poll') {
      state.polls = (state.polls ?? 0) + 1
      return state.polls < 2
        ? json({ status: 'pending' })
        : json({ status: 'completed', exchange_token: 'et-1' })
    }
    if (url.pathname === '/api/vibe/sign-in/p1/exchange') {
      return json({ api_key: KEY })
    }
    if (url.pathname === '/v1/model-catalog') {
      return json({
        models: state.catalog ?? [
          { id: 'deepseek-v4-1-flash-1017', label: 'DeepSeek V4.1 Flash', max_context_length: 1_048_576 },
          { id: 'codestral-latest', label: 'Codestral' },
        ],
      })
    }
    if (url.pathname === '/v1/models') return json({ data: [] })
    if (url.pathname === '/v1/billing/subscription') {
      return json({ plan_name: 'Vibe Pro', vibe_payg_enabled: true })
    }
    if (url.pathname === '/v1/billing/budget') {
      return json({
        vibe_budget: { usage_percentage: 42.5, initial_budget: 300, reset_at: RESET, payg_enabled: true },
        api_budget: { usage_percentage: 1.27, initial_budget: 30, reset_at: RESET },
      })
    }
    if (url.pathname === '/v1/chat/completions') {
      return json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    return json({ error: `unexpected ${url.pathname}` }, 404)
  }
  return Object.assign(state, { fetchImpl, requests })
}

const optionsFor = (state, extra = {}) => ({
  baseUrl: 'http://mock.local/v1',
  consoleBase: 'http://mock.local',
  fetch: state.fetchImpl,
  pollEveryMs: 5,
  ...extra,
})

test('the default export and config declare mistral-vibe, not mistral', async () => {
  assert.equal(plugin.id, 'mistral-vibe')
  assert.equal(typeof plugin.server, 'function')

  const state = mockServer()
  const hooks = await server({}, optionsFor(state))
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const provider = cfg.provider['mistral-vibe']
  assert.equal(provider.name, 'Mistral Vibe')
  assert.equal(provider.npm, '@ai-sdk/openai-compatible')
  assert.equal(provider.api, 'http://mock.local/v1')
  assert.ok(provider.models['mistral-medium-latest'])
  assert.equal(cfg.provider.mistral, undefined)
})

test('chat.headers writes affinity only for this provider and only with a session', async () => {
  const hooks = await server({}, {})
  const output = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral-vibe' }, sessionID: 's-1' }, output)
  assert.deepEqual(output.headers, { 'x-affinity': 's-1', 'x-session-id': 's-1' })

  const pluginOutput = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral-vibe-plugin' }, sessionID: 's-1' }, pluginOutput)
  assert.deepEqual(pluginOutput.headers, { 'x-affinity': 's-1', 'x-session-id': 's-1' })

  const other = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral' }, sessionID: 's-1' }, other)
  assert.deepEqual(other.headers, {})

  const noSession = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral-vibe' } }, noSession)
  assert.deepEqual(noSession.headers, {})
})

test('options.providerId derives a second provider id for a side-by-side entry', async () => {
  const state = mockServer()
  const hooks = await server({}, optionsFor(state, { engine: 'direct', providerId: 'mistral-vibe-api' }))
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const provider = cfg.provider['mistral-vibe-api']
  assert.equal(provider.name, 'Mistral Vibe (API)')
  assert.equal(provider.npm, '@ai-sdk/openai-compatible')
  assert.equal(provider.api, 'http://mock.local/v1')
  assert.ok(provider.models['mistral-medium-latest'])
  assert.equal(cfg.provider['mistral-vibe'], undefined)
  assert.equal(cfg.provider.mistral, undefined)

  assert.equal(hooks.provider.id, 'mistral-vibe-api')
  assert.equal(hooks.auth.provider, 'mistral-vibe-api')

  const own = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral-vibe-api' }, sessionID: 's-1' }, own)
  assert.deepEqual(own.headers, { 'x-affinity': 's-1', 'x-session-id': 's-1' })

  const ownPlugin = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral-vibe-api-plugin' }, sessionID: 's-1' }, ownPlugin)
  assert.deepEqual(ownPlugin.headers, { 'x-affinity': 's-1', 'x-session-id': 's-1' })

  const legacy = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral-vibe' }, sessionID: 's-1' }, legacy)
  assert.deepEqual(legacy.headers, {})

  const builtin = { headers: {} }
  await hooks['chat.headers']({ model: { providerID: 'mistral' }, sessionID: 's-1' }, builtin)
  assert.deepEqual(builtin.headers, {})
})

test('a blank options.providerId still declares mistral-vibe', async () => {
  const hooks = await server({}, { providerId: '   ' })
  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider['mistral-vibe'].name, 'Mistral Vibe')
  assert.equal(cfg.provider['mistral-vibe-api'], undefined)
  assert.equal(hooks.provider.id, 'mistral-vibe')
  assert.equal(hooks.auth.provider, 'mistral-vibe')
})

test('provider.models keeps a Vibe key on the Vibe surface', async () => {
  const state = mockServer()
  const hooks = await server({}, optionsFor(state))
  const models = await hooks.provider.models({ models: {} }, { auth: { type: 'api', key: KEY } })
  assert.ok(models['deepseek-v4-1-flash-1017'])
  assert.equal(models['codestral-latest'], undefined)
  assert.ok(models['mistral-vibe-cli-latest'])
  assert.equal(state.requests.filter((request) => request.path === '/api/vibe/whoami').length, 1)
  const whoami = state.requests.find((request) => request.path === '/api/vibe/whoami')
  assert.equal(whoami.headers.get('authorization'), `Bearer ${KEY}`)
})

test('provider.models lets an API key through only when includeApiSurface is on', async () => {
  const state = mockServer({ planType: 'API' })
  const hooks = await server({}, optionsFor(state, { includeApiSurface: true }))
  const models = await hooks.provider.models({ models: {} }, { auth: { key: KEY } })
  assert.deepEqual(Object.keys(models).sort(), ['codestral-latest', 'deepseek-v4-1-flash-1017'])
})

test('provider.models falls back to the provider list without a sign-in', async () => {
  const hooks = await server({}, {})
  const fallback = { models: { 'x-model': { name: 'X' } } }
  assert.deepEqual(await hooks.provider.models(fallback, { auth: null }), fallback.models)
})

test('auth.usage shows both pools with the other one aside', async () => {
  const state = mockServer()
  const hooks = await server({}, optionsFor(state))
  const usage = await hooks.auth.usage(async () => ({ type: 'api', key: KEY }))
  assert.equal(usage.plan, 'Vibe Pro')
  assert.equal(usage.windows.length, 2)
  assert.equal(usage.windows[0].name, 'Monthly Vibe')
  assert.equal(usage.windows[0].used, 42.5)
  assert.equal(usage.windows[0].aside, undefined)
  assert.equal(usage.windows[1].name, 'Platform API credits')
  assert.equal(usage.windows[1].aside, true)
  assert.equal(usage.payg, true)
})

test('auth.usage without a sign-in says so and does not throw', async () => {
  const hooks = await server({}, {})
  const usage = await hooks.auth.usage(async () => null)
  assert.deepEqual(usage.windows, [])
  assert.equal(typeof usage.error, 'string')
})

test('the loader signs, cleans headers and moves thinking', async () => {
  const state = mockServer()
  const hooks = await server({}, optionsFor(state))
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: KEY }))
  assert.equal(loader.baseURL, 'http://mock.local/v1')
  assert.equal(loader.apiKey, KEY)

  const body = JSON.stringify({
    model: 'deepseek-v4-1-flash-1017',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Let me check.', reasoning_content: 'thinking here' },
      { role: 'user', content: 'say ok' },
    ],
  })
  const response = await loader.fetch('http://mock.local/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer stale',
      'user-agent': 'some-harness/1.0',
      'x-stainless-lang': 'js',
      'x-affinity': 's-1',
      'content-type': 'application/json',
      'content-length': '999',
    },
    body,
  })
  assert.equal(response.status, 200)

  const sent = state.requests.at(-1)
  assert.equal(sent.headers.get('authorization'), `Bearer ${KEY}`)
  assert.equal(sent.headers.get('user-agent'), null)
  assert.equal(sent.headers.get('x-stainless-lang'), null)
  assert.equal(sent.headers.get('x-affinity'), 's-1')
  assert.equal(sent.headers.get('content-length'), null)

  const parsed = JSON.parse(sent.body)
  assert.equal(parsed.messages[1].reasoning_content, undefined)
  assert.deepEqual(parsed.messages[1].content[0], {
    type: 'thinking',
    thinking: [{ type: 'text', text: 'thinking here' }],
  })
})

test('the loader reads a Request body and normalizes it too', async () => {
  const state = mockServer()
  const hooks = await server({}, optionsFor(state))
  const loader = await hooks.auth.loader(async () => ({ key: KEY }))
  const body = JSON.stringify({
    model: 'deepseek-v4-1-flash-1017',
    messages: [{ role: 'assistant', content: 'hi', reasoning_content: 'why' }],
  })
  const request = new Request('http://mock.local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 's-2' },
    body,
  })
  const response = await loader.fetch(request)
  assert.equal(response.status, 200)
  const sent = state.requests.at(-1)
  assert.equal(sent.headers.get('authorization'), `Bearer ${KEY}`)
  assert.equal(sent.headers.get('x-session-id'), 's-2')
  const parsed = JSON.parse(new TextDecoder().decode(sent.body))
  assert.deepEqual(parsed.messages[0].content[0], {
    type: 'thinking',
    thinking: [{ type: 'text', text: 'why' }],
  })
})

test('browser sign-in runs start, poll, exchange and whoami', async () => {
  const state = mockServer()
  const hooks = await server({}, optionsFor(state))
  const oauth = hooks.auth.methods.find((method) => method.type === 'oauth')
  assert.ok(oauth)
  const started = await oauth.authorize()
  assert.equal(started.url, 'https://console.test/login?p=1')
  assert.equal(started.method, 'auto')
  const result = await started.callback()
  assert.equal(result.type, 'success')
  assert.equal(result.key, KEY)
  assert.equal(result.accountId, 'cust-1')
  assert.equal(result.metadata.plan, 'Vibe Pro')
  assert.equal(state.polls, 2)
  const exchange = state.requests.find((request) => request.path.endsWith('/exchange'))
  assert.equal(JSON.parse(exchange.body).exchange_token, 'et-1')
  assert.ok(JSON.parse(exchange.body).code_verifier)
})

test('the api method offers a pasted Vibe key', async () => {
  const hooks = await server({}, {})
  const api = hooks.auth.methods.find((method) => method.type === 'api')
  assert.ok(api)
  assert.equal(api.label, 'Vibe API key')
  assert.match(api.placeholder, /Vibe Code CLI/)
})

test('the ACP engine names the provider and keeps the same model surface', async () => {
  const hooks = await server({}, { engine: 'acp' })
  const cfg = {}
  await hooks.config(cfg)
  assert.match(cfg.provider['mistral-vibe'].name, /ACP/)
  assert.equal(cfg.provider['mistral-vibe'].npm, '@ai-sdk/openai-compatible')
  assert.ok(cfg.provider['mistral-vibe'].models['mistral-medium-latest'])
})

test('createAcpFetch routes chat to ACP, other URLs to the direct fetch, and keeps 402', async () => {
  const seen = []
  const bridge = {
    fetch: async (url) => {
      seen.push(url)
      return new Response('data: ok\n\n', { status: 200 })
    },
  }
  const fallback = async (url) => {
    seen.push(`fallback:${url}`)
    return new Response('fallback', { status: 200 })
  }
  const fetch = _internal.createAcpFetch({ bridge, fallback })
  const chat = await fetch('https://api.mistral.ai/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(await chat.text(), 'data: ok\n\n')
  const models = await fetch('https://api.mistral.ai/v1/models', { method: 'GET' })
  assert.equal(await models.text(), 'fallback')

  const quota = _internal.createAcpFetch({
    bridge: {
      fetch: async () => {
        const error = new Error('API budget exhausted')
        error.status = 402
        error.code = 'QUOTA'
        throw error
      },
    },
    fallback,
  })
  const response = await quota('https://api.mistral.ai/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(response.status, 402)
  assert.match(await response.text(), /API budget exhausted/)
  assert.ok(seen.includes('https://api.mistral.ai/v1/chat/completions'))
})
