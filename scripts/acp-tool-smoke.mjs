// Prove the MCP tool bridge with the real agent: the model calls a harmless
// client tool, the bridge parks the turn, then a second request delivers the
// tool result and the ACP turn continues.

import { AcpBridge } from '../src/acp/runtime.mjs'

const key = String(process.env.MISTRAL_API_KEY || '').trim()
if (!key) {
  console.error('MISTRAL_API_KEY is not set')
  process.exit(2)
}

const bridge = new AcpBridge({
  apiKey: key,
  options: {
    proxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY,
    baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
    vibeAcpPath: process.env.VIBE_ACP_PATH || undefined,
    firstOutputMs: 120_000,
    idleMs: 120_000,
    relayAfterMs: 45_000,
    debug: process.env.ACP_DEBUG === '1',
  },
  log: (level, message) => console.error(`[${level}] ${message}`),
})

const tool = {
  type: 'function',
  function: {
    name: 'magpie_ping',
    description: 'Return the fixed string pong. Call this when asked to ping.',
    parameters: { type: 'object', properties: {} },
  },
}

async function stream(body) {
  const response = await bridge.fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'x-session-id': 'tool-smoke-1' }),
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const chunks = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice(6).trim()
    if (raw === '[DONE]') continue
    try {
      chunks.push(JSON.parse(raw))
    } catch {
      // ignore
    }
  }
  return { status: response.status, chunks }
}

try {
  const user = 'Call the magpie_ping tool exactly once, then reply with just the tool result.'
  const first = await stream({
    model: process.env.ACP_MODEL || 'mistral-medium-latest',
    messages: [{ role: 'user', content: user }],
    tools: [tool],
    stream: true,
  })
  console.log(`HTTP ${first.status}`)
  const calls = []
  for (const chunk of first.chunks) {
    for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) calls.push(call)
  }
  if (calls.length === 0) {
    console.error('FAILED: the model did not call the tool')
    process.exitCode = 1
  } else {
    const call = calls[0]
    console.log(`tool call: ${call.function?.name} ${call.function?.arguments}`)
    const second = await stream({
      model: process.env.ACP_MODEL || 'mistral-medium-latest',
      messages: [
        { role: 'user', content: user },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          }],
        },
        { role: 'tool', tool_call_id: call.id, content: 'pong' },
      ],
      tools: [tool],
      stream: true,
    })
    const text = second.chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('')
    console.log(`HTTP ${second.status}; reply: ${text || '(empty)'}`)
    if (!/pong/i.test(text)) process.exitCode = 1
  }
} catch (error) {
  console.error(`FAILED ${error?.code ?? ''} status=${error?.status ?? ''}: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  await bridge.dispose().catch(() => undefined)
}
