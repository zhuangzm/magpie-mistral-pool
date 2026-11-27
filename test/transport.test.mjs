import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createTransport } from '../src/transport.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

test('first-output timeout fires before any header arrives', async () => {
  const transport = createTransport({
    firstOutputMs: 25,
    idleMs: 5_000,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
  })
  await assert.rejects(transport.fetch('http://mock/v1/chat/completions', {}), (error) => {
    assert.equal(error.code, 'TRANSPORT_TIMEOUT_FIRST_OUTPUT')
    assert.equal(error.phase, 'first-output')
    return true
  })
})

test('stream idle timeout errors the consumer instead of hanging', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: one\n\n'))
    },
  })
  const transport = createTransport({
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    firstOutputMs: 1_000,
    idleMs: 30,
  })
  const response = await transport.fetch('http://mock/v1/chat/completions', {})
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(decoder.decode(first.value), 'data: one\n\n')
  await assert.rejects(reader.read(), (error) => {
    assert.equal(error.code, 'TRANSPORT_TIMEOUT_IDLE')
    assert.equal(error.phase, 'stream-idle')
    return true
  })
})

test('a slow but live stream is not killed', async () => {
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of ['a', 'b', 'c']) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  const transport = createTransport({
    fetchImpl: async () => new Response(body),
    firstOutputMs: 1_000,
    idleMs: 200,
  })
  const response = await transport.fetch('http://mock/v1/chat/completions', {})
  assert.equal(await response.text(), 'abc')
})

test('the caller signal aborts a request still waiting for headers', async () => {
  const transport = createTransport({
    firstOutputMs: 5_000,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
  })
  const controller = new AbortController()
  const pending = transport.fetch('http://mock', { signal: controller.signal })
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 10)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
})

test('a caller abort after headers errors the body', async () => {
  const controller = new AbortController()
  const body = new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode('x'))
    },
  })
  const transport = createTransport({
    fetchImpl: async () => new Response(body),
    firstOutputMs: 1_000,
    idleMs: 5_000,
  })
  const response = await transport.fetch('http://mock', { signal: controller.signal })
  const reader = response.body.getReader()
  await reader.read()
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 10)
  await assert.rejects(reader.read(), (error) => error.name === 'AbortError')
})

test('a connection reset is classified and not retried by default', async () => {
  const transport = createTransport({
    fetchImpl: async () => {
      const error = new Error('socket hang up')
      error.code = 'ECONNRESET'
      throw error
    },
  })
  await assert.rejects(transport.fetch('http://mock', {}), (error) => error.code === 'TRANSPORT_RESET')
})

test('a pre-first-byte reset can be retried when asked', async () => {
  let calls = 0
  const transport = createTransport({
    maxRetriesBeforeFirstByte: 1,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('socket hang up')
        error.code = 'ECONNRESET'
        throw error
      }
      return new Response('ok')
    },
  })
  const response = await transport.fetch('http://mock', {})
  assert.equal(await response.text(), 'ok')
  assert.equal(calls, 2)
})

test('a real HTTP SSE response is passed through chunk by chunk', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: one\n\n')
    setTimeout(() => {
      response.write('data: two\n\n')
      response.end()
    }, 40)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const transport = createTransport({ firstOutputMs: 2_000, idleMs: 1_000 })
    const response = await transport.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const first = await reader.read()
    const firstText = decoder.decode(first.value)
    assert.match(firstText, /data: one/)
    assert.doesNotMatch(firstText, /data: two/)
    let rest = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value)
    }
    assert.match(rest, /data: two/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('undici agents disable their own 300s timeouts so 720s can be spent', async () => {
  delete process.env.NODE_USE_ENV_PROXY
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  delete process.env.HTTP_PROXY
  delete process.env.http_proxy
  const seen = []
  class Agent {
    constructor(options) {
      seen.push({ kind: 'agent', options })
    }
  }
  class ProxyAgent {
    constructor(options) {
      seen.push({ kind: 'proxy', options })
    }
  }
  const undiciLoader = async () => ({ Agent, ProxyAgent, fetch: async () => new Response('ok') })

  const transport = createTransport({ undiciLoader })
  assert.equal(await (await transport.fetch('http://mock', {})).text(), 'ok')
  assert.equal(seen[0].kind, 'agent')
  assert.equal(seen[0].options.headersTimeout, 0)
  assert.equal(seen[0].options.bodyTimeout, 0)
  assert.equal(seen[0].options.connect.keepAlive, true)
})

test('NODE_USE_ENV_PROXY selects a ProxyAgent from the environment', async () => {
  const seen = []
  class Agent {
    constructor(options) {
      seen.push({ kind: 'agent', options })
    }
  }
  class ProxyAgent {
    constructor(options) {
      seen.push({ kind: 'proxy', options })
    }
  }
  const undiciLoader = async () => ({ Agent, ProxyAgent, fetch: async () => new Response('ok') })

  process.env.NODE_USE_ENV_PROXY = '1'
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
  try {
    const transport = createTransport({ undiciLoader })
    await transport.fetch('http://mock', {})
  } finally {
    delete process.env.NODE_USE_ENV_PROXY
    delete process.env.HTTPS_PROXY
  }
  assert.equal(seen[0].kind, 'proxy')
  assert.equal(seen[0].options.uri, 'http://127.0.0.1:7890')
  assert.equal(seen[0].options.headersTimeout, 0)
})

test('a pre-aborted caller signal rejects before calling fetchImpl', async () => {
  let called = false
  const transport = createTransport({
    fetchImpl: async () => {
      called = true
      return new Response('ok')
    },
  })
  const controller = new AbortController()
  controller.abort(new DOMException('already stopped', 'AbortError'))
  await assert.rejects(
    transport.fetch('http://mock', { signal: controller.signal }),
    (error) => error.name === 'AbortError' && error.message === 'already stopped',
  )
  assert.equal(called, false)
})
