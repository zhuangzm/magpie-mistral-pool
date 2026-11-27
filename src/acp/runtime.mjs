// ACP runtime for the `mistral-vibe` provider: one `vibe-acp` child per
// conversation, a loopback MCP server exposing the client's tools, and a
// turn pump that parks on tool calls so Magpie can execute them.

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonRpcPeer } from './jsonrpc.mjs'
import { McpBridge } from './mcp.mjs'
import {
  buildChildEnv,
  killTree,
  prepareVibeHome,
  resolveEffort,
  resolveModelSpec,
  resolveVibeAcp,
  vibeGroupName,
} from './config.mjs'
import {
  buildReplayText,
  chunk,
  completion,
  decodeBody,
  digestMessage,
  historyPrefixIntact,
  parseChatBody,
  sse,
  splitSystem,
  textOf,
  toPromptBlocks,
  trailingSplit,
  usageOf,
} from './openai.mjs'

const DEFAULT_FIRST_OUTPUT_MS = 720_000
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1_000
const DEFAULT_RELAY_MS = 45_000
const DEFAULT_MAX_SESSIONS = 4
const MAX_TOOL_TEXT_BYTES = 256 * 1024
const PARK_SETTLE_MS = 150
const AWAIT_TOOL = 'magpie_await_result'

class AcpError extends Error {
  constructor(message, code = 'PROVIDER_ERROR', status = 500) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    this.status = status
  }
}

class Queue {
  constructor() {
    this.items = []
    this.waiters = []
  }

  push(item) {
    this.items.push(item)
    this.waiters.shift()?.(true)
  }

  shift() {
    return this.items.shift()
  }

  peek() {
    return this.items[0]
  }

  async wait(signal, timeoutMs) {
    if (this.items.length > 0) return true
    if (signal?.aborted) return false
    return new Promise((resolve) => {
      let done = false
      let timer
      const settle = (ok) => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiters.indexOf(onItem)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(ok)
      }
      const onItem = () => settle(true)
      const onAbort = () => settle(false)
      this.waiters.push(onItem)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) {
        timer = setTimeout(() => settle(false), timeoutMs)
        timer.unref?.()
      }
    })
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function waitFor(promise, timeoutMs, signal) {
  let timer
  let onAbort
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AcpError('Timed out waiting for the conversation lock', 'TIMEOUT', 503)), timeoutMs)
        timer.unref?.()
        onAbort = () => reject(new AcpError('Request aborted', 'ABORTED', 499))
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

class Turn {
  constructor(tag, generation) {
    this.tag = tag
    this.generation = generation
    this.events = new Queue()
    this.calls = new Map()
    this.pendingCalls = new Map()
    this.finished = false
    this.settled = false
    this.produced = false
    this.nextCall = 0
    this.usage = undefined
    this.aborted = false
  }

  park(name, args) {
    const call = {
      id: `call_${randomBytes(12).toString('hex')}`,
      name,
      argumentsJson: JSON.stringify(args ?? {}),
      result: deferred(),
    }
    this.calls.set(call.id, call)
    this.events.push({ kind: 'park', call })
    return call
  }

  onUpdate(update) {
    if (!update || typeof update !== 'object') return
    const kind = update.sessionUpdate
    if (kind === 'usage_update') {
      const meta = update._meta && typeof update._meta === 'object' ? update._meta : {}
      if (typeof meta.promptTokens === 'number' || typeof meta.completionTokens === 'number') {
        this.usage = {
          inputTokens: Math.max(Number(this.usage?.inputTokens ?? 0), Number(meta.promptTokens ?? 0)),
          outputTokens: Math.max(Number(this.usage?.outputTokens ?? 0), Number(meta.completionTokens ?? 0)),
          cachedReadTokens: Math.max(Number(this.usage?.cachedReadTokens ?? 0), Number(meta.cachedTokens ?? 0)),
        }
      }
      return
    }
    const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
    if (!text) return
    if (kind === 'agent_message_chunk') {
      this.produced = true
      this.events.push({ kind: 'text', text })
    } else if (kind === 'agent_thought_chunk') {
      this.produced = true
      this.events.push({ kind: 'thought', text })
    }
  }

  done(result) {
    this.settled = true
    this.events.push({ kind: 'done', result })
  }

  fail(error) {
    this.settled = true
    this.events.push({ kind: 'error', error })
  }

  abandon(reason) {
    this.aborted = true
    for (const call of this.calls.values()) {
      call.result.resolve({ content: [{ type: 'text', text: reason }], isError: true })
    }
    this.pendingCalls.clear()
  }
}

class Conversation {
  constructor(key, tag) {
    this.key = key
    this.tag = tag
    this.child = undefined
    this.peer = undefined
    this.sessionId = undefined
    this.serverName = undefined
    this.tenantKey = undefined
    this.runnerDir = undefined
    this.model = undefined
    this.effort = undefined
    this.fingerprint = undefined
    this.knownDigests = undefined
    this.issuedIds = new Set()
    this.tools = []
    this.turn = undefined
    this.generation = 0
    this.lastUsed = Date.now()
    this.alive = false
  }
}

const live = new Set()
let exitHook = false

function installExitHook() {
  if (exitHook) return
  exitHook = true
  process.once('exit', () => {
    for (const bridge of live) {
      for (const conv of bridge.conversations.values()) killTree(conv.child, { force: true })
    }
  })
}

function mapError(error) {
  if (error instanceof AcpError) return error
  const rpc = error?.rpc
  const code = Number(rpc?.code)
  const message = String(rpc?.message ?? error?.message ?? error ?? 'Mistral Vibe ACP failed')
  if (code === -32000) return new AcpError(message, 'AUTH_OR_QUOTA', 402)
  if (code === -31001) return new AcpError(message, 'RATE_LIMIT', 429)
  if (code === -31004) return new AcpError(message, 'CONTEXT_WINDOW', 400)
  if (code === -31005) return new AcpError(message, 'REFUSAL', 400)
  if (/\b402\b|billing|budget exhausted|insufficient|quota|credit/i.test(message)) return new AcpError(message, 'QUOTA', 402)
  if (/\b401\b|\b403\b|unauthor|invalid.*key/i.test(message)) return new AcpError(message, 'AUTH', 401)
  if (/\b429\b|rate.?limit/i.test(message)) return new AcpError(message, 'RATE_LIMIT', 429)
  return new AcpError(message, 'PROVIDER_ERROR', 500)
}

export class AcpBridge {
  constructor({ apiKey, options = {}, log } = {}) {
    this.apiKey = apiKey
    this.options = options
    this.log = log
    this.conversations = new Map()
    this.mutexes = new Map()
    this.activeRequests = 0
    this.waiting = []
    this.bridge = new McpBridge({
      listTools: (tenantKey) => this.#listTools(tenantKey),
      callTool: (request) => this.#callTool(request),
    }, { log })
    this.sweeper = setInterval(() => this.#sweep(), 60_000)
    this.sweeper.unref?.()
    live.add(this)
    installExitHook()
  }

  get stats() {
    return {
      conversations: this.conversations.size,
      live: [...this.conversations.values()].filter((conv) => conv.alive).length,
      activeRequests: this.activeRequests,
    }
  }

  async dispose() {
    clearInterval(this.sweeper)
    live.delete(this)
    for (const conv of [...this.conversations.values()]) this.#reset(conv)
    this.conversations.clear()
    await this.bridge.close().catch(() => undefined)
  }

  /**
   * The provider's fetch. `/chat/completions` is answered locally from ACP;
   * anything else is refused, because the direct control plane has its own
   * transport in the plugin.
   */
  async fetch(url, init = {}) {
    const target = typeof url === 'string' ? url : url?.url
    if (!/\/chat\/completions(?:\?|$)/i.test(String(target))) {
      throw new AcpError(`ACP provider only serves /chat/completions, not ${target}`, 'BAD_REQUEST', 404)
    }
    const signal = init.signal
    const headers = new Headers(init.headers ?? {})
    let body = init.body
    if (body && typeof body === 'object' && typeof body.getReader === 'function') {
      body = await new Response(body).text()
    }
    const request = parseChatBody(decodeBody(body))
    return this.#chat(request, headers, signal)
  }

  async #chat(request, headers, signal) {
    if (!this.apiKey) throw new AcpError('Not signed in', 'AUTH', 401)
    const model = request.model || this.options.defaultModel || 'mistral-medium-latest'
    const spec = resolveModelSpec(model)
    const effort = resolveEffort(request.effort, spec.thinkingLevels)
    const split = splitSystem(request.messages)
    const key = this.#conversationKey(headers, split.system, split.messages)
    const release = await this.#acquire(key, signal)
    let conv
    try {
      conv = this.conversations.get(key)
      if (!conv) {
        conv = new Conversation(key, randomBytes(6).toString('hex'))
        this.conversations.set(key, conv)
      }
      conv.lastUsed = Date.now()

      const fingerprint = createHash('sha256').update(JSON.stringify({
        system: split.system,
        tools: request.tools,
        model,
        effort,
      })).digest('hex')

      if (conv.turn?.pendingCalls.size > 0) {
        const same = conv.fingerprint === fingerprint && conv.alive && conv.sessionId
        if (same && historyPrefixIntact(conv.knownDigests, split.messages) && this.#deliverToolResults(conv, split.messages)) {
          conv.knownDigests = split.messages.map(digestMessage)
          return this.#response(conv, conv.turn, request, { signal, release })
        }
        this.#reset(conv)
      } else if (conv.turn) {
        conv.turn.abandon('Superseded by a newer request')
        this.#reset(conv)
      }

      let plan = this.#planPrompt(conv, fingerprint, split.messages)
      if (plan.rebuild || !conv.alive) {
        this.#reset(conv)
        await this.#open(conv, { model, effort, tools: request.tools, signal })
        plan = { rebuild: true, ...trailingSplit(split.messages) }
        conv.fingerprint = fingerprint
      }

      const blocks = plan.rebuild
        ? [{ type: 'text', text: buildReplayText({ system: split.system, tools: request.tools, serverName: conv.serverName, history: plan.history, input: plan.input }) }]
        : toPromptBlocks(plan.input, { supportsImages: spec.supportsImages })

      conv.knownDigests = split.messages.map(digestMessage)
      conv.issuedIds.clear()
      conv.turn = undefined
      const turn = new Turn(conv.tag, ++conv.generation)
      conv.turn = turn
      this.#prompt(conv, turn, blocks)
      return await this.#response(conv, turn, request, { signal, release, awaitFirst: true })
    } catch (error) {
      release()
      if (conv) this.#reset(conv)
      throw mapError(error)
    }
  }

  #conversationKey(headers, system, messages) {
    const session = headers.get('x-session-id') || headers.get('x-affinity')
    if (session) return `s:${session}`
    const firstUser = messages.find((message) => message?.role === 'user')
    return `h:${createHash('sha256').update(`${system}\n${textOf(firstUser?.content)}`).digest('hex').slice(0, 24)}`
  }

  async #acquire(key, signal) {
    const previous = this.mutexes.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => {
      release = resolve
    })
    this.mutexes.set(key, previous.then(() => current, () => current))
    await waitFor(previous, 60_000, signal)
    return release
  }

  #planPrompt(conv, fingerprint, messages) {
    const reusable = Boolean(
      conv.alive
      && conv.sessionId
      && conv.fingerprint === fingerprint
      && historyPrefixIntact(conv.knownDigests, messages),
    )
    if (reusable) {
      let rest = messages.slice(conv.knownDigests.length)
      while (rest.length > 0 && rest[0]?.role === 'assistant') rest = rest.slice(1)
      if (rest.length > 0 && rest.some((message) => message?.role === 'user' || message?.role === 'developer')) {
        return { rebuild: false, input: rest.filter((message) => message?.role === 'user' || message?.role === 'developer') }
      }
    }
    return { rebuild: true, ...trailingSplit(messages) }
  }

  async #open(conv, { model, effort, tools, signal }) {
    const maxSessions = Number(this.options.maxSessions) > 0 ? Number(this.options.maxSessions) : DEFAULT_MAX_SESSIONS
    if (this.#liveCount() >= maxSessions && !this.#evictIdle()) {
      throw new AcpError('Too many live Vibe ACP sessions; close one before opening another.', 'MAX_SESSIONS', 503)
    }
    await this.bridge.start()
    const binary = resolveVibeAcp(this.options.vibeAcpPath)
    const root = mkdtempSync(join(tmpdir(), 'magpie-vibe-acp-'))
    conv.runnerDir = root
    const vibeHome = join(root, 'vibe_home')
    const workDir = join(root, 'work')
    mkdirSync(workDir, { recursive: true })

    const serverName = `magpie_${randomBytes(4).toString('hex')}`
    const tenantKey = randomBytes(12).toString('hex')
    const secret = this.bridge.mountSession(tenantKey)
    conv.serverName = serverName
    conv.tenantKey = tenantKey
    conv.tools = tools

    prepareVibeHome({
      vibeHome,
      model,
      effort,
      serverName,
      baseUrl: this.options.baseUrl,
      sourceHome: this.options.sourceVibeHome,
    })

    const env = buildChildEnv({
      vibeHome,
      apiKey: this.apiKey,
      proxyUrl: this.options.proxyUrl,
    })

    const args = Array.isArray(this.options.vibeAcpArgs) ? this.options.vibeAcpArgs.map(String) : []
    const child = spawn(binary, args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    conv.child = child

    let stderr = ''
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', (value) => {
      stderr = (stderr + String(value)).slice(-8_192)
      if (this.options.debug) this.log?.('debug', `vibe-acp stderr: ${String(value).slice(0, 400)}`)
    })

    const peer = new JsonRpcPeer(child.stdout, child.stdin, {
      onNotification: (method, params) => {
        if (method === 'session/update' && conv.turn) conv.turn.onUpdate(params?.update)
      },
      onRequest: (method, params) => this.#permission(conv, method, params),
      onClose: (error) => {
        conv.alive = false
        if (conv.turn && !conv.turn.settled) {
          conv.turn.fail(new AcpError(`${error.message}${stderr ? `: ${stderr.slice(-300).trim()}` : ''}`, 'ACP_CLOSED', 502))
        }
      },
    })
    conv.peer = peer
    child.once('error', (error) => peer.close(error))

    try {
      await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'magpie', title: 'Magpie', version: '0.1.0' },
      }, { signal, timeoutMs: 20_000 })
      const created = await peer.request('session/new', {
        cwd: workDir,
        mcpServers: tools.length > 0 ? [{
          type: 'http',
          name: serverName,
          url: `${this.bridge.url}/${tenantKey}`,
          headers: [{ name: 'Authorization', value: `Bearer ${secret}` }],
        }] : [],
      }, { signal, timeoutMs: 25_000 })
      if (typeof created?.sessionId !== 'string' || !created.sessionId) {
        throw new AcpError('vibe-acp session/new returned no sessionId', 'PROVIDER_ERROR', 502)
      }
      conv.sessionId = created.sessionId
      conv.model = model
      conv.effort = effort
      conv.alive = true
    } catch (error) {
      this.#reset(conv)
      throw error
    }
  }

  #prompt(conv, turn, blocks) {
    const peer = conv.peer
    const sessionId = conv.sessionId
    peer.request('session/prompt', { sessionId, prompt: blocks }).then(
      (result) => turn.done(result),
      (error) => {
        turn.fail(error)
        conv.alive = false
      },
    )
  }

  #permission(conv, method, params) {
    if (method !== 'session/request_permission') {
      const error = new Error(`Unsupported ACP client request: ${method}`)
      error.code = -32601
      throw error
    }
    const options = Array.isArray(params?.options) ? params.options : []
    const toolCall = params?.toolCall ?? {}
    const name = String(toolCall._meta?.toolName ?? toolCall.name ?? toolCall.title ?? '')
    const group = conv.serverName ? vibeGroupName(conv.serverName) : ''
    const allowed = name === 'run_typescript'
      || name === 'search_tool_functions'
      || (conv.serverName && name.startsWith(`${conv.serverName}_`))
      || (group && (name.includes(group) || String(toolCall.title ?? '').includes(group)))
    const allow = options.find((option) => option?.kind === 'allow_once' || option?.optionId === 'allow_once')
      ?? options.find((option) => option?.kind === 'allow_always')
    if (allowed && allow?.optionId) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    const reject = options.find((option) => option?.kind === 'reject_once' || option?.optionId === 'reject_once')
      ?? options.find((option) => String(option?.kind ?? '').startsWith('reject'))
    return reject?.optionId
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }

  #listTools(tenantKey) {
    const conv = [...this.conversations.values()].find((item) => item.tenantKey === tenantKey)
    if (!conv) return []
    const tools = (conv.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }))
    tools.push({
      name: AWAIT_TOOL,
      description: 'Wait for a Magpie tool call that returned a [MAGPIE_RELAY] notice.',
      inputSchema: {
        type: 'object',
        properties: { call_id: { type: 'string' } },
        required: ['call_id'],
      },
    })
    return tools
  }

  async #callTool({ tenantKey, name, arguments: args, signal }) {
    const conv = [...this.conversations.values()].find((item) => item.tenantKey === tenantKey)
    const turn = conv?.turn
    if (!conv || !turn || turn.finished || turn.settled || turn.aborted) {
      return { content: [{ type: 'text', text: 'The Magpie turn is no longer active.' }], isError: true }
    }

    let call
    if (name === AWAIT_TOOL) {
      const id = typeof args?.call_id === 'string' ? args.call_id : ''
      call = turn.calls.get(id)
      if (!call) return { content: [{ type: 'text', text: `Unknown call_id "${id}".` }], isError: true }
    } else {
      if (!(conv.tools ?? []).some((tool) => tool.name === name)) {
        return { content: [{ type: 'text', text: `Unknown Magpie tool "${name}".` }], isError: true }
      }
      call = turn.park(name, args)
    }

    const relayMs = Number(this.options.relayAfterMs) > 0 ? Number(this.options.relayAfterMs) : DEFAULT_RELAY_MS
    const outcome = await Promise.race([
      call.result.promise.then((result) => ({ kind: 'result', result })),
      delay(relayMs).then(() => ({ kind: 'relay' })),
    ])
    if (outcome.kind === 'result') return outcome.result
    if (signal?.aborted) return { content: [{ type: 'text', text: 'Tool call aborted.' }], isError: true }
    const group = vibeGroupName(conv.serverName)
    return {
      content: [{
        type: 'text',
        text: `[MAGPIE_RELAY] Tool "${call.name}" (call_id: "${call.id}") is still executing. Do NOT call "${call.name}" again. Immediately call \`await tools.${group}.${AWAIT_TOOL}({ call_id: "${call.id}" })\` to wait for its result.`,
      }],
      isError: false,
    }
  }

  #deliverToolResults(conv, messages) {
    const pending = conv.turn.pendingCalls
    if (pending.size === 0) return false
    const trailing = []
    for (let i = messages.length - 1; i >= 0 && messages[i]?.role === 'tool'; i -= 1) trailing.unshift(messages[i])
    if (trailing.length === 0) return false
    const byId = new Map(trailing.map((message) => [message.tool_call_id, message]))
    for (const id of pending.keys()) {
      if (!byId.has(id)) return false
    }
    for (const [id, call] of pending) {
      const message = byId.get(id)
      pending.delete(id)
      const text = clampToolText(textOf(message.content) || 'OK')
      call.result.resolve({
        content: [{ type: 'text', text }],
        isError: message.is_error === true || message.isError === true,
      })
    }
    return true
  }

  async #response(conv, turn, request, { signal, release, awaitFirst = false }) {
    const id = `chatcmpl-${randomBytes(12).toString('hex')}`
    const model = request.model || conv.model || 'mistral-medium-latest'
    if (awaitFirst) {
      const first = await this.#nextEvent(turn, signal, this.#firstOutputMs())
      if (first.kind === 'error') {
        release()
        this.#reset(conv)
        throw mapError(first.error)
      }
      if (first.kind === 'done' && !turn.produced) {
        release()
        this.#reset(conv)
        throw new AcpError('Mistral Vibe ACP ended the turn without output', 'EMPTY_RESPONSE', 502)
      }
      if (!request.stream) {
        const collected = await this.#collect(conv, turn, first, signal)
        release()
        if (collected.error) {
          this.#reset(conv)
          throw mapError(collected.error)
        }
        if (collected.park) {
          conv.turn = turn
          return jsonResponse(completion({
            id,
            model,
            text: collected.text,
            reasoning: collected.reasoning,
            toolCalls: collected.toolCalls,
            finishReason: 'tool_calls',
            usage: usageOf(collected.usage),
          }))
        }
        conv.turn = undefined
        return jsonResponse(completion({
          id,
          model,
          text: collected.text,
          reasoning: collected.reasoning,
          finishReason: 'stop',
          usage: usageOf(collected.usage),
        }))
      }
      return new Response(this.#stream(turn, first, { id, model, signal, release, conv, onFinish: () => {
        if (!turn.pendingCalls.size) conv.turn = undefined
        conv.lastUsed = Date.now()
      } }), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    }
    if (!request.stream) {
      const collected = await this.#collect(conv, turn, undefined, signal)
      release()
      if (collected.error) {
        this.#reset(conv)
        throw mapError(collected.error)
      }
      if (collected.park) {
        conv.turn = turn
        return jsonResponse(completion({
          id,
          model,
          text: collected.text,
          reasoning: collected.reasoning,
          toolCalls: collected.toolCalls,
          finishReason: 'tool_calls',
          usage: usageOf(collected.usage),
        }))
      }
      conv.turn = undefined
      return jsonResponse(completion({
        id,
        model,
        text: collected.text,
        reasoning: collected.reasoning,
        finishReason: 'stop',
        usage: usageOf(collected.usage),
      }))
    }
    return new Response(this.#stream(turn, undefined, { id, model, signal, release, conv, onFinish: () => {
      if (!turn.pendingCalls.size) conv.turn = undefined
      conv.lastUsed = Date.now()
    } }), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  }

  #firstOutputMs() {
    return Number(this.options.firstOutputMs) > 0 ? Number(this.options.firstOutputMs) : DEFAULT_FIRST_OUTPUT_MS
  }

  #idleMs() {
    return Number(this.options.idleMs) > 0 ? Number(this.options.idleMs) : 300_000
  }

  async #nextEvent(turn, signal, timeoutMs = this.#firstOutputMs()) {
    const ready = await turn.events.wait(signal, timeoutMs)
    if (!ready) {
      if (signal?.aborted) throw new AcpError('Request aborted', 'ABORTED', 499)
      throw new AcpError('Vibe ACP did not answer in time', 'TIMEOUT', 504)
    }
    return turn.events.shift()
  }

  #stream(turn, first, { id, model, signal, release, conv, onFinish }) {
    const encoder = new TextEncoder()
    const iterator = this.#chunks(turn, first, { id, model, signal, release, onFinish, conv })
    return new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next()
          if (done) controller.close()
          else controller.enqueue(encoder.encode(value))
        } catch (error) {
          controller.error(mapError(error))
        }
      },
      cancel(reason) {
        iterator.return?.()
        turn.abandon(reason instanceof Error ? reason.message : 'Client closed the stream')
        try {
          if (conv?.sessionId && conv.peer && !conv.peer.isClosed) {
            conv.peer.notify('session/cancel', { sessionId: conv.sessionId })
          }
        } catch {
          // best effort
        }
        release()
        onFinish?.()
        if (conv) this.#reset(conv)
      },
    })
  }

  async *#chunks(turn, first, { id, model, signal, release, onFinish, conv }) {
    let openText = false
    let openReasoning = false
    const closeBlocks = function* () {
      if (openText || openReasoning) {
        openText = false
        openReasoning = false
      }
    }
    const emit = function* (delta) {
      yield sse(chunk({ id, model, delta }))
    }
    yield* emit({ role: 'assistant', content: '' })
    let event = first
    let timeoutMs = first === undefined ? this.#idleMs() : this.#firstOutputMs()
    try {
      for (;;) {
        if (!event) event = await this.#nextEvent(turn, signal, timeoutMs)
        timeoutMs = this.#idleMs()
        if (event.kind === 'text') {
          openText = true
          yield* emit({ content: event.text })
        } else if (event.kind === 'thought') {
          openReasoning = true
          yield* emit({ reasoning_content: event.text })
        } else if (event.kind === 'park') {
          yield* closeBlocks()
          const batch = [event.call]
          while (await turn.events.wait(signal, PARK_SETTLE_MS)) {
            const next = turn.events.peek()
            if (next?.kind !== 'park') break
            turn.events.shift()
            batch.push(next.call)
          }
          for (let index = 0; index < batch.length; index += 1) {
            const call = batch[index]
            turn.pendingCalls.set(call.id, call)
            conv.issuedIds.add(call.id)
            yield sse(chunk({
              id,
              model,
              delta: {
                tool_calls: [{
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.argumentsJson },
                }],
              },
            }))
          }
          yield sse(chunk({
            id,
            model,
            delta: {},
            finishReason: 'tool_calls',
            usage: usageOf(turn.usage),
          }))
          yield 'data: [DONE]\n\n'
          return
        } else if (event.kind === 'done') {
          yield* closeBlocks()
          turn.finished = true
          const reason = event.result?.stopReason ?? 'end_turn'
          if (reason === 'end_turn') {
            yield sse(chunk({ id, model, delta: {}, finishReason: 'stop', usage: usageOf(event.result?.usage) }))
          } else if (reason === 'max_tokens') {
            yield sse(chunk({ id, model, delta: {}, finishReason: 'length', usage: usageOf(event.result?.usage) }))
          } else {
            yield sse(chunk({ id, model, delta: {}, finishReason: 'stop', usage: usageOf(event.result?.usage) }))
          }
          yield 'data: [DONE]\n\n'
          return
        } else if (event.kind === 'error') {
          throw event.error
        }
        event = undefined
      }
    } finally {
      release()
      onFinish?.()
    }
  }

  async #collect(conv, turn, first, signal) {
    let text = ''
    let reasoning = ''
    const toolCalls = []
    let event = first
    let usage
    let timeoutMs = first === undefined ? this.#idleMs() : this.#firstOutputMs()
    for (;;) {
      if (!event) event = await this.#nextEvent(turn, signal, timeoutMs)
      timeoutMs = this.#idleMs()
      if (event.kind === 'text') text += event.text
      else if (event.kind === 'thought') reasoning += event.text
      else if (event.kind === 'park') {
        const batch = [event.call]
        while (await turn.events.wait(signal, PARK_SETTLE_MS)) {
          const next = turn.events.peek()
          if (next?.kind !== 'park') break
          turn.events.shift()
          batch.push(next.call)
        }
        for (const call of batch) {
          turn.pendingCalls.set(call.id, call)
          conv.issuedIds.add(call.id)
          toolCalls.push(call)
        }
        return { text, reasoning, toolCalls, park: true, usage }
      } else if (event.kind === 'done') {
        turn.finished = true
        usage = event.result?.usage
        return { text, reasoning, toolCalls, park: false, usage }
      } else if (event.kind === 'error') {
        return { error: event.error }
      }
      event = undefined
    }
  }

  #reset(conv) {
    conv.turn?.abandon('The ACP session was reset.')
    conv.turn = undefined
    conv.alive = false
    if (conv.tenantKey) {
      this.bridge.revokeSession(conv.tenantKey)
      conv.tenantKey = undefined
    }
    const peer = conv.peer
    conv.peer = undefined
    const child = conv.child
    conv.child = undefined
    try {
      if (conv.sessionId && peer && !peer.isClosed) peer.notify('session/cancel', { sessionId: conv.sessionId })
    } catch {
      // best effort
    }
    peer?.close(new Error('ACP session reset'))
    killTree(child)
    conv.sessionId = undefined
    conv.serverName = undefined
    conv.fingerprint = undefined
    conv.knownDigests = undefined
    conv.issuedIds.clear()
    conv.tools = []
    if (conv.runnerDir) {
      try {
        rmSync(conv.runnerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // Vibe may still hold a file; the OS temp cleaner gets it later
      }
      conv.runnerDir = undefined
    }
  }

  #sweep() {
    const ttl = Number(this.options.sessionTtlMs) > 0 ? Number(this.options.sessionTtlMs) : DEFAULT_SESSION_TTL_MS
    const now = Date.now()
    for (const [key, conv] of this.conversations) {
      if (conv.turn?.pendingCalls.size > 0) continue
      if (conv.turn && !conv.turn.settled && !conv.turn.finished) continue
      if (now - conv.lastUsed > ttl) {
        this.#reset(conv)
        this.conversations.delete(key)
      }
    }
  }

  #liveCount() {
    let count = 0
    for (const conv of this.conversations.values()) if (conv.alive) count += 1
    return count
  }

  #evictIdle() {
    let best
    for (const conv of this.conversations.values()) {
      if (!conv.alive) continue
      if (conv.turn?.pendingCalls.size > 0) continue
      if (conv.turn && !conv.turn.settled && !conv.turn.finished) continue
      if (!best || conv.lastUsed < best.lastUsed) best = conv
    }
    if (!best) return false
    this.#reset(best)
    return true
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function clampToolText(text) {
  const value = String(text ?? '')
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= MAX_TOOL_TEXT_BYTES) return value
  let end = Math.min(value.length, MAX_TOOL_TEXT_BYTES)
  let kept = Buffer.byteLength(value.slice(0, end), 'utf8')
  while (end > 0 && kept > MAX_TOOL_TEXT_BYTES) {
    const over = kept - MAX_TOOL_TEXT_BYTES
    end = Math.max(0, end - Math.max(1, Math.ceil(over / 3)))
    kept = Buffer.byteLength(value.slice(0, end), 'utf8')
  }
  return `${value.slice(0, end)}\n\n[truncated ${bytes - kept} bytes by Magpie ACP bridge]`
}

export function createAcpBridge(options) {
  return new AcpBridge(options)
}

export { AcpError }
