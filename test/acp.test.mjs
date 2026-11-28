import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpBridge } from '../src/acp/runtime.mjs'
import { buildChildEnv } from '../src/acp/config.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const fake = join(here, '..', 'fixtures', 'fake-vibe-acp.mjs')
const emptyHome = join(tmpdir(), 'magpie-acp-test-home')

function bridge(options = {}) {
  return new AcpBridge({
    apiKey: 'test-key',
    options: {
      vibeAcpPath: process.execPath,
      vibeAcpArgs: [fake],
      sourceVibeHome: emptyHome,
      firstOutputMs: 5_000,
      idleMs: 5_000,
      relayAfterMs: 1_000,
      ...options,
    },
  })
}

function request(body) {
  return {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'x-session-id': body.session }),
    body: JSON.stringify(body.payload),
  }
}

function payload(extra = {}) {
  return {
    model: 'mistral-medium-latest',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    ...extra,
  }
}

test('ACP streams reasoning and text with usage', async () => {
  const acp = bridge()
  try {
    const res = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'text-1',
      payload: payload(),
    }))
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /"reasoning_content":"thinking"/)
    assert.match(text, /"content":"ok:turn=1/)
    assert.match(text, /"finish_reason":"stop"/)
    assert.match(text, /"prompt_tokens":100/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    await acp.dispose()
  }
})

test('ACP parks a client tool call and resumes with its result', async () => {
  const acp = bridge({ relayAfterMs: 30_000 })
  try {
    const tool = {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }
    const first = payload({ messages: [{ role: 'user', content: 'TRIGGER_TOOL' }], tools: [tool] })
    const res1 = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({ session: 'tool-1', payload: first }))
    const text1 = await res1.text()
    assert.match(text1, /"finish_reason":"tool_calls"/)
    const match = /"tool_calls":\[\{"index":0,"id":"(call_[^"]+)","type":"function","function":\{"name":"read"/.exec(text1)
    assert.ok(match, text1)
    const id = match[1]

    const second = payload({
      messages: [
        { role: 'user', content: 'TRIGGER_TOOL' },
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{"path":"hello.txt"}' } }] },
        { role: 'tool', tool_call_id: id, content: 'FILE CONTENTS' },
      ],
      tools: [tool],
    })
    const res2 = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({ session: 'tool-1', payload: second }))
    const text2 = await res2.text()
    assert.match(text2, /"content":"tool:FILE CONTENTS"/)
    assert.match(text2, /"finish_reason":"stop"/)
  } finally {
    await acp.dispose()
  }
})

test('ACP answers a non-streaming request as one completion', async () => {
  const acp = bridge()
  try {
    const res = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'plain-1',
      payload: payload({ stream: false }),
    }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.match(body.choices[0].message.content, /ok:turn=1/)
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.usage.prompt_tokens, 100)
  } finally {
    await acp.dispose()
  }
})

test('ACP maps a 402 prompt failure to a quota error', async () => {
  const acp = bridge()
  try {
    await assert.rejects(
      acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
        session: 'quota-1',
        payload: payload({ messages: [{ role: 'user', content: 'TRIGGER_402' }] }),
      })),
      (error) => error?.status === 402 && error?.code === 'AUTH_OR_QUOTA',
    )
  } finally {
    await acp.dispose()
  }
})

test('ACP rejects built-in tools and allows run_typescript', async () => {
  const acp = bridge()
  try {
    const res = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'perm-1',
      payload: payload({ messages: [{ role: 'user', content: 'TRIGGER_PERMISSION' }] }),
    }))
    const text = await res.text()
    assert.match(text, /perm:reject_once\/allow_once/)
  } finally {
    await acp.dispose()
  }
})

test('ACP does not evict a session that is waiting on a client tool', async () => {
  const acp = bridge({ maxSessions: 1, relayAfterMs: 30_000 })
  try {
    const tool = {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }
    const first = payload({ messages: [{ role: 'user', content: 'TRIGGER_TOOL' }], tools: [tool] })
    const res = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'cap-1',
      payload: first,
    }))
    assert.match(await res.text(), /"finish_reason":"tool_calls"/)

    await assert.rejects(
      acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
        session: 'cap-2',
        payload: payload(),
      })),
      (error) => error?.status === 503 && error?.code === 'MAX_SESSIONS',
    )
  } finally {
    await acp.dispose()
  }
})

test('ACP truncates an oversized tool result before replaying it', async () => {
  const acp = bridge({ relayAfterMs: 30_000 })
  try {
    const tool = {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }
    const first = payload({ messages: [{ role: 'user', content: 'TRIGGER_TOOL' }], tools: [tool] })
    const res1 = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'big-tool-1',
      payload: first,
    }))
    const text1 = await res1.text()
    const id = /"tool_calls":\[\{"index":0,"id":"(call_[^"]+)"/.exec(text1)?.[1]
    assert.ok(id, text1)

    const second = payload({
      messages: [
        { role: 'user', content: 'TRIGGER_TOOL' },
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{"path":"large.txt"}' } }] },
        { role: 'tool', tool_call_id: id, content: 'x'.repeat(300 * 1024) },
      ],
      tools: [tool],
    })
    const res2 = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'big-tool-1',
      payload: second,
    }))
    const text2 = await res2.text()
    assert.match(text2, /\[truncated 45056 bytes by Magpie ACP bridge\]/)
    assert.ok(text2.length < 300 * 1024)
  } finally {
    await acp.dispose()
  }
})

test('ACP forwards OpenAI image_url parts as image prompt blocks', async () => {
  const acp = bridge()
  try {
    const res = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'image-1',
      payload: payload({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        }],
      }),
    }))
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /\[image\]/)
  } finally {
    await acp.dispose()
  }
})

test('ACP mutex recovers when a queued request aborts while waiting for the lock', async () => {
  const acp = bridge({ relayAfterMs: 30_000 })
  try {
    const tool = {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }
    const res1 = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'mutex-1',
      payload: payload({ messages: [{ role: 'user', content: 'TRIGGER_TOOL' }], tools: [tool] }),
    }))
    const text1 = await res1.text()
    const id = /"tool_calls":\[\{"index":0,"id":"(call_[^"]+)"/.exec(text1)?.[1]
    assert.ok(id, text1)

    const second = payload({
      messages: [
        { role: 'user', content: 'TRIGGER_TOOL' },
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: id, content: 'DONE' },
      ],
      tools: [tool],
    })
    const res2 = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({ session: 'mutex-1', payload: second }))
    const reader2 = res2.body.getReader()

    // Queue a third request while res2 stream is still holding the lock, then abort it.
    const abortCtl = new AbortController()
    const queued = acp.fetch('https://api.mistral.ai/v1/chat/completions', {
      ...request({ session: 'mutex-1', payload: payload() }),
      signal: abortCtl.signal,
    })
    setTimeout(() => abortCtl.abort(new DOMException('cancelled waiter', 'AbortError')), 20)
    await assert.rejects(queued, (error) => error?.code === 'ABORTED')

    // Drain res2 so it releases the lock.
    while (!(await reader2.read()).done) {}

    // A subsequent request on the same session must acquire the lock immediately and succeed.
    const res4 = await acp.fetch('https://api.mistral.ai/v1/chat/completions', request({
      session: 'mutex-1',
      payload: payload({ messages: [{ role: 'user', content: 'after abort' }] }),
    }))
    assert.equal(res4.status, 200)
    assert.match(await res4.text(), /ok:turn=/)
    assert.equal(acp.stats.activeRequests, 0)
  } finally {
    await acp.dispose()
  }
})

test('buildChildEnv puts an explicit proxyUrl ahead of the environment', () => {
  const env = buildChildEnv({
    vibeHome: join(tmpdir(), 'magpie-acp-proxy-option'),
    apiKey: 'test-key',
    proxyUrl: 'http://127.0.0.1:1080',
    base: { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890' },
  })
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1080')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:1080')
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:1080')
  const bypass = env.NO_PROXY.split(",")
  for (const host of ['localhost', '127.0.0.1', '::1']) assert.ok(bypass.includes(host), env.NO_PROXY)
})

test('buildChildEnv follows the system proxy when nothing is configured', () => {
  const env = buildChildEnv({
    vibeHome: join(tmpdir(), 'magpie-acp-proxy-system'),
    apiKey: 'test-key',
    probe: () => ({ proxy: '127.0.0.1:7899', bypass: ['internal.example'] }),
    base: {},
  })
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7899')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7899')
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:7899')
  const bypass = env.NO_PROXY.split(",")
  assert.ok(bypass.includes('internal.example'), env.NO_PROXY)
  assert.ok(bypass.includes('127.0.0.1'), env.NO_PROXY)
})

test('buildChildEnv stays direct when the option says none', () => {
  const env = buildChildEnv({
    vibeHome: join(tmpdir(), 'magpie-acp-proxy-none'),
    apiKey: 'test-key',
    proxyUrl: 'none',
    base: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    probe: () => ({ proxy: '127.0.0.1:7899' }),
  })
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) assert.equal(env[key], undefined, key)
  const bypass = env.NO_PROXY.split(",")
  assert.ok(bypass.includes('127.0.0.1'), env.NO_PROXY)
})
