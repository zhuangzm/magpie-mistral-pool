// Loopback Streamable-HTTP MCP server exposing the client's Chat Completions
// tools to `vibe-acp`. Each ACP session mounts its own tenant path and Bearer
// secret; `tools/call` stays open with keepalives while Magpie executes the
// tool, then answers the agent.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024

class BodyTooLargeError extends Error {}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function tokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_MCP_BODY_BYTES) throw new BodyTooLargeError('MCP body too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function writeEvent(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

export class McpBridge {
  constructor(router, options = {}) {
    this.router = router
    this.keepAliveMs = Number(options.keepAliveMs ?? 15_000) || 15_000
    this.log = options.log
    this.server = undefined
    this.starting = undefined
    this.closed = false
    this.port = 0
    this.secrets = new Map()
    this.openResponses = new Set()
  }

  get listening() {
    return this.server !== undefined
  }

  get url() {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  async start() {
    if (this.closed) throw new Error('MCP bridge was closed')
    if (this.server !== undefined) return
    this.starting ??= this.#listenOnce().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async #listenOnce() {
    const server = createServer((req, res) => {
      void this.#handle(req, res)
    })
    server.keepAliveTimeout = 0
    server.requestTimeout = 0
    server.headersTimeout = 0
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (this.closed) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      throw new Error('MCP bridge closed during startup')
    }
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
  }

  mountSession(tenantKey) {
    const secret = randomBytes(24).toString('hex')
    this.secrets.set(tenantKey, secret)
    return secret
  }

  revokeSession(tenantKey) {
    this.secrets.delete(tenantKey)
  }

  async close() {
    this.closed = true
    if (this.starting !== undefined) await this.starting.catch(() => undefined)
    const server = this.server
    this.server = undefined
    this.secrets.clear()
    for (const res of this.openResponses) res.destroy()
    this.openResponses.clear()
    if (server !== undefined) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter(Boolean)
    const tenantKey = segments[1]
    if (segments[0] !== 'mcp' || segments.length !== 2 || !tenantKey) {
      res.writeHead(404).end()
      return
    }
    const secret = this.secrets.get(tenantKey)
    if (secret === undefined || !tokenEqual(req.headers.authorization, `Bearer ${secret}`)) {
      res.writeHead(401).end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE' }).end()
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 400
      writeJson(res, status, {
        jsonrpc: '2.0',
        id: null,
        error: { code: status === 413 ? -32000 : -32700, message: status === 413 ? 'Request body too large' : 'Parse error' },
      })
      return
    }
    const messages = Array.isArray(body) ? body : [body]
    const requests = messages.filter((m) => isRecord(m) && typeof m.method === 'string' && m.id !== undefined && m.id !== null)
    if (requests.length === 0) {
      res.writeHead(202).end()
      return
    }
    const call = requests.find((r) => r.method === 'tools/call')
    if (call !== undefined && requests.length === 1) {
      await this.#handleCall(res, call, tenantKey)
      return
    }
    const replies = await Promise.all(requests.map((r) => this.#answer(r, tenantKey)))
    writeJson(res, 200, Array.isArray(body) ? replies : replies[0])
  }

  #answer(request, tenantKey) {
    const reply = (result) => ({ jsonrpc: '2.0', id: request.id, result })
    switch (request.method) {
      case 'initialize': {
        const params = isRecord(request.params) ? request.params : {}
        return reply({
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'magpie', version: '0.1.0' },
          instructions: 'Tools of the Magpie session. Every call is executed by Magpie under its own permission policy.',
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: this.router.listTools(tenantKey) })
      case 'resources/list':
        return reply({ resources: [] })
      case 'resources/templates/list':
        return reply({ resourceTemplates: [] })
      case 'prompts/list':
        return reply({ prompts: [] })
      case 'tools/call':
        return { jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'tools/call must be sent alone' } }
      default:
        return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } }
    }
  }

  async #handleCall(res, request, tenantKey) {
    const params = isRecord(request.params) ? request.params : {}
    const meta = isRecord(params._meta) ? params._meta : {}
    const name = typeof params.name === 'string' ? params.name : ''
    const args = isRecord(params.arguments) ? params.arguments : {}
    const progressToken = meta.progressToken

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    res.flushHeaders?.()
    this.openResponses.add(res)

    const controller = new AbortController()
    let settled = false
    const onClose = () => {
      this.openResponses.delete(res)
      if (!settled) controller.abort(new Error('MCP client closed the tool call'))
    }
    res.on('close', onClose)

    let ticks = 0
    const keepAlive = setInterval(() => {
      if (res.writableEnded) return
      ticks += 1
      res.write(': keepalive\n\n')
      if (typeof progressToken === 'string' || typeof progressToken === 'number') {
        writeEvent(res, {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, progress: ticks, message: 'Magpie is executing the tool' },
        })
      }
    }, this.keepAliveMs)
    keepAlive.unref?.()

    let result
    try {
      result = await this.router.callTool({ tenantKey, name, arguments: args, signal: controller.signal })
    } catch (error) {
      result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    } finally {
      settled = true
      clearInterval(keepAlive)
    }

    if (!res.writableEnded && !res.destroyed) {
      writeEvent(res, { jsonrpc: '2.0', id: request.id, result })
      res.end()
    }
    this.openResponses.delete(res)
    res.off('close', onClose)
  }
}
