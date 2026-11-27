#!/usr/bin/env node
// Minimal scriptable ACP agent for the bridge tests. Speaks the same
// newline-delimited JSON-RPC and Streamable-HTTP MCP subset as vibe-acp.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const stdin = process.stdin
const stdout = process.stdout
stdin.setEncoding('utf8')

let buffer = ''
let mcp = null
let promptSeq = 0
let requestSeq = 1
const pending = new Map()

function send(value) {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
}

function notify(method, params) {
  send({ method, params })
}

function request(method, params) {
  const id = `fake_${requestSeq++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
}

async function mcpCall(name, args) {
  if (!mcp) throw new Error('no MCP server')
  const headers = { 'content-type': 'application/json' }
  for (const header of mcp.headers ?? []) headers[header.name] = header.value
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestSeq++,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const text = await response.text()
  let last
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      last = JSON.parse(line.slice(5).trim())
    } catch {
      // ignore keepalive/invalid frames
    }
  }
  return last?.result
}

function promptText(params) {
  return (params?.prompt ?? []).map((block) => (block?.type === 'text' ? block.text : `[${block?.type}]`)).join('\n')
}

async function prompt(rpcId, params) {
  const text = promptText(params)
  const turn = ++promptSeq
  if (text.includes('TRIGGER_402')) {
    send({ id: rpcId, error: { code: -32000, message: 'Provider billing denied (HTTP 402): API budget exhausted' } })
    return
  }

  if (text.includes('TRIGGER_PERMISSION')) {
    const options = [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
    ]
    const bash = await request('session/request_permission', {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'tc_bash', name: 'bash', _meta: { toolName: 'bash' } },
      options,
    })
    const ts = await request('session/request_permission', {
      sessionId: 'fake-session',
      toolCall: { toolCallId: 'tc_ts', name: 'run_typescript', _meta: { toolName: 'run_typescript' } },
      options,
    })
    notify('session/update', {
      sessionId: 'fake-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `perm:${bash?.outcome?.optionId}/${ts?.outcome?.optionId}` } },
    })
    send({ id: rpcId, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } })
    return
  }

  if (text.includes('TRIGGER_TOOL')) {
    notify('session/update', {
      sessionId: 'fake-session',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'calling tool' } },
    })
    let result = await mcpCall('read', { path: 'hello.txt' })
    let value = result?.content?.[0]?.text ?? ''
    let relayed = false
    for (let hop = 0; hop < 4 && value.includes('[MAGPIE_RELAY]'); hop += 1) {
      const match = /call_id:\s*"([^"]+)"/.exec(value)
      if (!match) break
      relayed = true
      result = await mcpCall('magpie_await_result', { call_id: match[1] })
      value = result?.content?.[0]?.text ?? ''
    }
    notify('session/update', {
      sessionId: 'fake-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `${relayed ? 'relayed:' : 'tool:'}${value}` },
      },
    })
    send({ id: rpcId, result: { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 15, cachedReadTokens: 20 } } })
    return
  }

  notify('session/update', {
    sessionId: 'fake-session',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
  })
  notify('session/update', {
    sessionId: 'fake-session',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `ok:turn=${turn}:body=${text.split('\n').pop()}` },
    },
  })
  const vibeHome = process.env.VIBE_HOME || ''
  let model = 'unknown'
  try {
    const config = readFileSync(join(vibeHome, 'config.toml'), 'utf8')
    model = /active_model\s*=\s*"([^"]+)"/.exec(config)?.[1] ?? 'unknown'
  } catch {
    // no config
  }
  notify('session/update', {
    sessionId: 'fake-session',
    update: {
      sessionUpdate: 'usage_update',
      used: 100,
      size: 1_048_576,
      _meta: { promptTokens: 100, completionTokens: 10, cachedTokens: 0 },
    },
  })
  send({
    id: rpcId,
    result: {
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 0, model },
    },
  })
}

async function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      waiter.resolve(message.result)
    }
    return
  }
  if (message.method === 'session/cancel') return
  const id = message.id
  if (id === undefined || id === null) return

  if (message.method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
        agentInfo: { name: 'fake-vibe', version: '0.0.0' },
      },
    })
    return
  }
  if (message.method === 'session/new') {
    mcp = message.params?.mcpServers?.[0] ?? null
    send({ id, result: { sessionId: 'fake-session', configOptions: [] } })
    return
  }
  if (message.method === 'session/prompt') {
    await prompt(id, message.params)
    return
  }
  send({ id, error: { code: -32601, message: `Method not found: ${message.method}` } })
}

stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) {
      try {
        void handle(JSON.parse(line))
      } catch {
        // ignore malformed frame
      }
    }
    newline = buffer.indexOf('\n')
  }
})

process.once('SIGTERM', () => process.exit(0))
