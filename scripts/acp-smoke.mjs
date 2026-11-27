// One small real ACP turn through the same bridge the plugin uses.
// Consumes a few cents of the Vibe allowance; use it to prove the path.

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

try {
  const response = await bridge.fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'x-session-id': `smoke-${Date.now()}` }),
    body: JSON.stringify({
      model: process.env.ACP_MODEL || 'mistral-medium-latest',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      stream: true,
    }),
  })
  console.log(`HTTP ${response.status}`)
  const text = await response.text()
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) console.log(line.slice(6, 320))
  }
} catch (error) {
  console.error(`FAILED ${error?.code ?? ''} status=${error?.status ?? ''}: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  await bridge.dispose().catch(() => undefined)
}
