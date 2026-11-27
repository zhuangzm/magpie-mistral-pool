import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpBridge } from '../src/acp/runtime.mjs'

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
