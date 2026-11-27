#!/usr/bin/env node
/**
 * 2026-12-01 billing attribution probe.
 *
 * Answers one question with measurement, not assumption:
 *   after 2026-12-01, does a direct api.mistral.ai call made with a Vibe key
 *   charge `vibe_budget` or `api_budget`?
 *
 * Arms:
 *   direct        POST /v1/chat/completions with an explicit User-Agent
 *   direct-noua   same request, no Vibe User-Agent
 *   acp           spawn `vibe-acp`, drive one ACP session, read its usage
 *
 * Every arm is bracketed by:
 *   GET /v1/billing/subscription
 *   GET /v1/billing/budget
 * and the delta of both pools is printed and written to JSON.
 *
 * No dependencies. Node >= 18.3 (parseArgs, global fetch, AbortSignal.timeout).
 *
 * Usage:
 *   node scripts/billing-probe.mjs snapshot
 *   node scripts/billing-probe.mjs run --arms direct,acp --model deepseek-v4-1-flash-1017
 *   node scripts/billing-probe.mjs run --arms direct,direct-noua,acp --repeats 3
 *
 * Environment:
 *   MISTRAL_API_KEY   Vibe key (never printed)
 *   MISTRAL_API_BASE  default https://api.mistral.ai/v1
 *   VIBE_ACP_CMD      default vibe-acp
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const DEFAULT_BASE = 'https://api.mistral.ai/v1'
const DEFAULT_MODEL = 'deepseek-v4-1-flash-1017'
const DEFAULT_UA = 'mistral-client-python/Mistral-Vibe/3.1.5'
const DEFAULT_PROMPT = [
  'You are a deterministic billing probe. Do not use tools.',
  'Read the following sentence and reply with exactly the word OK, then stop:',
  '"The quick brown fox jumps over the lazy dog."',
].join('\n')

const POOL_NAMES = ['vibe_budget', 'api_budget']
const POOL_LABELS = { vibe_budget: 'Vibe ($300)', api_budget: 'API ($30)' }

const HELP = `
2026-12-01 Mistral billing attribution probe

Commands
  snapshot                     Read and print the current billing pools
  run                          Run the selected arms and print pool deltas

Options
  --key <key>                  Vibe key (default: MISTRAL_API_KEY)
  --base <url>                 API base (default: MISTRAL_API_BASE or ${DEFAULT_BASE})
  --model <id>                 Model id, used by every arm (default: ${DEFAULT_MODEL})
  --prompt <text>              Prompt text (default: a short deterministic probe)
  --prompt-file <path>         Read the prompt from a file (overrides --prompt)
  --max-tokens <n>             Direct arm max_tokens (default: 64)
  --arms <list>                Comma list: direct,direct-noua,acp (default: direct,acp)
  --repeats <n>                Requests per arm (default: 3)
  --ua <value>                 User-Agent for the direct arm; "none" omits it
                               (default: ${DEFAULT_UA})
  --acp-cmd <cmd>              vibe-acp executable (default: VIBE_ACP_CMD or vibe-acp)
  --acp-arg <arg>              Extra argv for vibe-acp; repeatable
  --acp-timeout-ms <n>         One ACP turn timeout (default: 300000)
  --request-timeout-ms <n>     One direct HTTP request timeout (default: 180000)
  --settle-ms <n>              Wait after each arm before the closing snapshot
                               (default: 15000)
  --out <path>                 JSON output (default: billing-probe-<timestamp>.json)
  --no-billing                 Skip billing reads (smoke tests only)
  --dry-run                    Print the plan and ACP config, make no requests
  --verbose                    Print raw ACP notifications and HTTP bodies
  -h, --help                   This text

Examples
  node scripts/billing-probe.mjs snapshot
  node scripts/billing-probe.mjs run --arms direct,acp --repeats 3
  node scripts/billing-probe.mjs run --arms direct,direct-noua,acp \\
    --prompt-file ./big-prompt.txt --settle-ms 60000
`

function fail(message, code = 2) {
  console.error(`error: ${message}`)
  process.exit(code)
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fmtUsd(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)}`
}

function fmtPct(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)}%`
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function describeError(error, fallback = 'request failed') {
  if (!error) return fallback
  if (error.name === 'TimeoutError') return 'request timed out'
  const cause = error.cause
  const detail = cause?.code ?? cause?.message
  return detail ? `${error.message ?? fallback} (${detail})` : (error.message ?? fallback)
}

function parsePositiveInt(raw, fallback, name) {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`)
  return Math.trunc(value)
}

function parseNonNegativeInt(raw, fallback, name) {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) fail(`${name} must be zero or a positive number`)
  return Math.trunc(value)
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

async function getJson(url, headers, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // keep the raw text for diagnostics
  }
  return { ok: response.ok, status: response.status, json, text }
}

async function readBilling({ base, key }) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${key}`,
  }
  const [subscription, budget] = await Promise.all([
    getJson(`${base}/billing/subscription`, headers),
    getJson(`${base}/billing/budget`, headers),
  ])
  if (!budget.ok) {
    throw new Error(
      `GET /billing/budget -> ${budget.status}: ${budget.text.slice(0, 300)}. ` +
        'The key needs see_org_inference_usage; without it this probe cannot measure attribution.',
    )
  }
  return {
    at: new Date().toISOString(),
    subscription: subscription.json,
    budget: budget.json,
  }
}

function poolState(budget, name) {
  const pool = budget?.[name]
  if (!pool || typeof pool !== 'object') return null
  const percentage = pool.usage_percentage == null ? NaN : Number(pool.usage_percentage)
  const initial = pool.initial_budget == null ? NaN : Number(pool.initial_budget)
  const hasPercentage = Number.isFinite(percentage)
  const hasInitial = Number.isFinite(initial)
  return {
    usage_percentage: hasPercentage ? percentage : null,
    initial_budget: hasInitial ? initial : null,
    used_usd: hasPercentage && hasInitial ? round((initial * percentage) / 100, 8) : null,
    reset_at: pool.reset_at ?? null,
    payg_enabled: pool.payg_enabled ?? null,
  }
}

function poolDelta(before, after) {
  const out = {}
  for (const name of POOL_NAMES) {
    const b = poolState(before?.budget, name)
    const a = poolState(after?.budget, name)
    out[name] = {
      before: b,
      after: a,
      usage_percentage_delta:
        b?.usage_percentage != null && a?.usage_percentage != null
          ? round(a.usage_percentage - b.usage_percentage, 8)
          : null,
      used_usd_delta:
        b?.used_usd != null && a?.used_usd != null
          ? round(a.used_usd - b.used_usd, 8)
          : null,
    }
  }
  return out
}

function printBilling(label, snapshot) {
  console.log(`\n=== ${label} @ ${snapshot.at} ===`)
  const plan = snapshot.subscription?.plan_name
  if (plan) console.log(`plan: ${plan}`)
  for (const name of POOL_NAMES) {
    const pool = poolState(snapshot.budget, name)
    if (!pool) {
      console.log(`${POOL_LABELS[name].padEnd(12)}: absent`)
      continue
    }
    const used = pool.used_usd == null ? 'n/a' : `$${pool.used_usd.toFixed(6)}`
    const limit = pool.initial_budget == null ? 'n/a' : `$${pool.initial_budget.toFixed(2)}`
    const pct = pool.usage_percentage == null ? 'n/a' : `${pool.usage_percentage}%`
    const reset = pool.reset_at ? ` reset=${pool.reset_at}` : ''
    console.log(`${POOL_LABELS[name].padEnd(12)}: used ${used} / ${limit} (${pct})${reset}`)
  }
}

function printDelta(delta) {
  for (const name of POOL_NAMES) {
    const item = delta?.[name]
    if (!item) continue
    console.log(
      `  ${POOL_LABELS[name].padEnd(12)} Δ ${fmtUsd(item.used_usd_delta)} USD ` +
        `(${fmtPct(item.usage_percentage_delta)})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Direct arm
// ---------------------------------------------------------------------------

async function runDirect(cfg) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${cfg.key}`,
  }
  if (cfg.ua && cfg.ua !== 'none') headers['user-agent'] = cfg.ua

  const body = {
    model: cfg.model,
    messages: [{ role: 'user', content: cfg.prompt }],
    max_tokens: cfg.maxTokens,
    temperature: 0,
    stream: false,
  }

  const started = Date.now()
  const response = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // keep raw
  }
  return {
    ok: response.ok,
    status: response.status,
    ms: Date.now() - started,
    usage: json?.usage ?? null,
    text: (json?.choices?.[0]?.message?.content ?? text).slice(0, 500),
    error: response.ok ? null : text.slice(0, 500),
  }
}

// ---------------------------------------------------------------------------
// ACP arm
// ---------------------------------------------------------------------------

function writeVibeHome(model, base) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-billing-probe-'))
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  const apiBase = base.replace(/\/+$/, '')
  const toml = [
    `active_model = ${JSON.stringify(model)}`,
    'bypass_tool_permissions = true',
    'enabled_tools = ["__billing_probe_no_tools__"]',
    'include_project_context = false',
    'include_prompt_detail = false',
    'include_commit_signature = false',
    'enable_subagents = false',
    'enable_background_processes = false',
    'enable_telemetry = false',
    'enable_update_checks = false',
    '',
    '[experiments]',
    'enable = false',
    '',
    '[session_logging]',
    'enabled = false',
    'generate_titles = false',
    '',
    '[[providers]]',
    'name = "mistral"',
    `api_base = ${JSON.stringify(apiBase)}`,
    'api_key_env_var = "MISTRAL_API_KEY"',
    'backend = "mistral"',
    'preserve_api_base = true',
    '',
    '[[models]]',
    `name = ${JSON.stringify(model)}`,
    'provider = "mistral"',
    `alias = ${JSON.stringify(model)}`,
    `display_name = ${JSON.stringify(model)}`,
    '',
  ].join('\n')
  writeFileSync(join(dir, 'config.toml'), toml, { mode: 0o600 })
  return { dir, toml }
}

class AcpClient {
  constructor(child, { timeoutMs, onUpdate, verbose }) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.onUpdate = onUpdate
    this.verbose = verbose
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.closed = false
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.#onLine(line))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8192)
    })
    child.once('exit', (code, signal) => {
      this.#failAll(
        new Error(
          `vibe-acp exited code=${code} signal=${signal}` +
            (this.stderr ? `: ${this.stderr.slice(-500).trim()}` : ''),
        ),
      )
    })
    child.once('error', (error) => this.#failAll(error))
  }

  #send(message) {
    if (this.closed || !this.child.stdin?.writable) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  #onLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      if (this.verbose) console.log(`[acp stdout] ${trimmed.slice(0, 300)}`)
      return
    }
    if (this.verbose) console.log(`[acp] ${trimmed.slice(0, 500)}`)

    if (typeof message.method === 'string' && message.id != null) {
      this.#onRequest(message)
      return
    }
    if (typeof message.method === 'string') {
      if (message.method === 'session/update') this.onUpdate?.(message.params?.update)
      return
    }
    if (message.id != null && ('result' in message || 'error' in message)) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) {
        const error = new Error(
          `${waiter.method}: ${message.error.message ?? 'JSON-RPC error'} ` +
            `(code=${message.error.code ?? '?'})`,
        )
        error.rpc = message.error
        waiter.reject(error)
      } else {
        waiter.resolve(message.result)
      }
    }
  }

  #onRequest(message) {
    if (message.method === 'session/request_permission') {
      const options = Array.isArray(message.params?.options) ? message.params.options : []
      const reject =
        options.find((option) => String(option?.kind ?? '').startsWith('reject')) ??
        options.find((option) => option?.optionId === 'reject_once')
      if (reject) {
        this.#send({
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: reject.optionId } },
        })
      } else {
        this.#send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } })
      }
      return
    }
    this.#send({
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    })
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.#send({ id, method, params })
    })
  }

  #failAll(error) {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  close() {
    this.#failAll(new Error('ACP client closed'))
    try {
      this.lines.close()
    } catch {
      // already closed
    }
  }
}

function normalizeAcpUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  return {
    input_tokens: usage.inputTokens ?? usage.input_tokens ?? null,
    output_tokens: usage.outputTokens ?? usage.output_tokens ?? null,
    cached_tokens: usage.cachedReadTokens ?? usage.cached_read_tokens ?? null,
    total_tokens: usage.totalTokens ?? usage.total_tokens ?? null,
  }
}

function usageFromUpdates(updates) {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const update = updates[i]
    if (update?.sessionUpdate !== 'usage_update') continue
    const meta = update._meta ?? {}
    return {
      input_tokens: meta.promptTokens ?? null,
      output_tokens: meta.completionTokens ?? null,
      cached_tokens: meta.cachedTokens ?? null,
      total_tokens: meta.totalTokens ?? null,
    }
  }
  return null
}

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.pid == null) return resolve()
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('exit', done)
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        // best effort
      }
      setTimeout(done, 1000)
      return
    }
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        // gone
      }
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // gone
      }
      done()
    }, 2000)
  })
}

async function runAcp(cfg) {
  const { dir, toml } = writeVibeHome(cfg.model, cfg.base)
  if (cfg.verbose) console.log(`[acp] VIBE_HOME=${dir}\n${toml}`)

  const isCmdShim = /\.(cmd|bat)$/i.test(cfg.acpCmd)
  const child = spawn(cfg.acpCmd, cfg.acpArgs, {
    cwd: dir,
    env: { ...process.env, VIBE_HOME: dir, MISTRAL_API_KEY: cfg.key },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: isCmdShim,
    detached: process.platform !== 'win32',
  })

  const updates = []
  const client = new AcpClient(child, {
    timeoutMs: cfg.acpTimeoutMs,
    onUpdate: (update) => {
      if (update) updates.push(update)
    },
    verbose: cfg.verbose,
  })

  const started = Date.now()
  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'magpie-billing-probe', version: '0.1.0' },
    })

    const created = await client.request('session/new', {
      cwd: dir,
      mcpServers: [],
    })
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('session/new returned no sessionId')
    }

    const result = await client.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: cfg.prompt }] },
      cfg.acpTimeoutMs,
    )

    const text = updates
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('')
    const thought = updates
      .filter((update) => update.sessionUpdate === 'agent_thought_chunk')
      .map((update) => update.content?.text ?? '')
      .join('')

    return {
      ok: true,
      status: null,
      ms: Date.now() - started,
      usage: normalizeAcpUsage(result?.usage) ?? usageFromUpdates(updates),
      stop_reason: result?.stopReason ?? null,
      text: text.slice(0, 500),
      thought: thought.slice(0, 500),
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      usage: usageFromUpdates(updates),
      stop_reason: null,
      text: '',
      thought: '',
      error: describeError(error),
    }
  } finally {
    client.close()
    try {
      child.stdin?.end()
    } catch {
      // gone
    }
    await killTree(child)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows can hold a file briefly after the child exits; the temp dir is disposable.
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function printArm(record) {
  console.log(`\n--- arm: ${record.arm} ---`)
  if (record.delta) printDelta(record.delta)
  for (const [index, result] of record.results.entries()) {
    const usage = result.usage ?? {}
    const tokens =
      `prompt=${usage.prompt_tokens ?? usage.input_tokens ?? '?'} ` +
      `completion=${usage.completion_tokens ?? usage.output_tokens ?? '?'} ` +
      `cached=${usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? '?'}`
    if (result.ok) {
      console.log(
        `  #${index + 1} ok ${result.status ?? 'acp'} ${result.ms}ms ${tokens}` +
          (result.text ? ` text=${JSON.stringify(result.text.slice(0, 80))}` : ''),
      )
    } else {
      console.log(`  #${index + 1} FAILED ${result.ms}ms ${result.error}`)
    }
  }
}

function printSummary(records) {
  console.log('\n=== summary ===')
  console.log(
    'arm'.padEnd(14) +
      'ok'.padEnd(8) +
      'vibe Δ USD'.padEnd(16) +
      'api Δ USD'.padEnd(16) +
      'vibe Δ %'.padEnd(14) +
      'api Δ %',
  )
  for (const record of records) {
    const ok = `${record.results.filter((result) => result.ok).length}/${record.results.length}`
    const vibe = record.delta?.vibe_budget
    const api = record.delta?.api_budget
    console.log(
      record.arm.padEnd(14) +
        ok.padEnd(8) +
        fmtUsd(vibe?.used_usd_delta).padEnd(16) +
        fmtUsd(api?.used_usd_delta).padEnd(16) +
        fmtPct(vibe?.usage_percentage_delta).padEnd(14) +
        fmtPct(api?.usage_percentage_delta),
    )
  }
}

async function runOne(arm, cfg) {
  if (arm === 'direct' || arm === 'direct-noua') {
    return runDirect({ ...cfg, ua: arm === 'direct-noua' ? 'none' : cfg.ua })
  }
  if (arm === 'acp') return runAcp(cfg)
  throw new Error(`unknown arm: ${arm}`)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      key: { type: 'string' },
      base: { type: 'string' },
      model: { type: 'string' },
      prompt: { type: 'string' },
      'prompt-file': { type: 'string' },
      'max-tokens': { type: 'string' },
      arms: { type: 'string' },
      repeats: { type: 'string' },
      ua: { type: 'string' },
      'acp-cmd': { type: 'string' },
      'acp-arg': { type: 'string', multiple: true },
      'acp-timeout-ms': { type: 'string' },
      'request-timeout-ms': { type: 'string' },
      'settle-ms': { type: 'string' },
      out: { type: 'string' },
      'no-billing': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) {
    console.log(HELP.trim())
    return
  }

  const command = positionals[0] ?? 'run'
  if (!['run', 'snapshot'].includes(command)) fail(`unknown command: ${command}`)

  const base = (values.base ?? process.env.MISTRAL_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, '')
  const model = values.model ?? process.env.PROBE_MODEL ?? DEFAULT_MODEL
  const key = values.key ?? process.env.MISTRAL_API_KEY ?? process.env.VIBE_API_KEY
  const prompt = values['prompt-file']
    ? readFileSync(values['prompt-file'], 'utf8')
    : (values.prompt ?? DEFAULT_PROMPT)

  const arms = (values.arms ?? 'direct,acp')
    .split(',')
    .map((arm) => arm.trim())
    .filter(Boolean)
  for (const arm of arms) {
    if (!['direct', 'direct-noua', 'acp'].includes(arm)) fail(`unknown arm: ${arm}`)
  }

  const cfg = {
    base,
    model,
    key,
    prompt,
    arms,
    repeats: parsePositiveInt(values.repeats, 3, '--repeats'),
    maxTokens: parsePositiveInt(values['max-tokens'], 64, '--max-tokens'),
    ua: values.ua ?? DEFAULT_UA,
    acpCmd: values['acp-cmd'] ?? process.env.VIBE_ACP_CMD ?? 'vibe-acp',
    acpArgs: values['acp-arg'] ?? [],
    acpTimeoutMs: parsePositiveInt(values['acp-timeout-ms'], 300_000, '--acp-timeout-ms'),
    requestTimeoutMs: parsePositiveInt(
      values['request-timeout-ms'],
      180_000,
      '--request-timeout-ms',
    ),
    settleMs: parseNonNegativeInt(values['settle-ms'], 15_000, '--settle-ms'),
    noBilling: Boolean(values['no-billing']),
    dryRun: Boolean(values['dry-run']),
    verbose: Boolean(values.verbose),
  }

  if (cfg.dryRun) {
    console.log('=== dry run ===')
    console.log(`base:    ${cfg.base}`)
    console.log(`model:   ${cfg.model}`)
    console.log(`arms:    ${cfg.arms.join(',')}`)
    console.log(`repeats: ${cfg.repeats}`)
    console.log(`ua:      ${cfg.ua}`)
    console.log(`acp:     ${cfg.acpCmd} ${cfg.acpArgs.join(' ')}`)
    console.log(`billing: ${cfg.noBilling ? 'skipped' : 'read'}`)
    const { dir, toml } = writeVibeHome(cfg.model, cfg.base)
    console.log('\n=== generated VIBE_HOME/config.toml ===')
    console.log(toml)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // disposable temp dir
    }
    return
  }

  if (!key) fail('no key: pass --key or set MISTRAL_API_KEY')
  if (command === 'snapshot') {
    if (cfg.noBilling) {
      console.log('billing skipped (--no-billing)')
      return
    }
    const snapshot = await readBilling(cfg)
    printBilling('snapshot', snapshot)
    return
  }

  const output = {
    started_at: new Date().toISOString(),
    command,
    base: cfg.base,
    model: cfg.model,
    repeats: cfg.repeats,
    ua: cfg.ua,
    acp_cmd: cfg.acpCmd,
    acp_args: cfg.acpArgs,
    arms: [],
  }

  for (const arm of cfg.arms) {
    const before = cfg.noBilling ? null : await readBilling(cfg)
    if (before) printBilling(`before ${arm}`, before)

    const results = []
    for (let index = 0; index < cfg.repeats; index += 1) {
      try {
        results.push(await runOne(arm, cfg))
      } catch (error) {
        results.push({
          ok: false,
          status: null,
          ms: 0,
          usage: null,
          text: '',
        error: describeError(error),
        })
        break
      }
    }

    if (cfg.settleMs > 0) await sleep(cfg.settleMs)
    const after = cfg.noBilling ? null : await readBilling(cfg)
    if (after) printBilling(`after ${arm}`, after)

    const record = {
      arm,
      before,
      after,
      delta: before && after ? poolDelta(before, after) : null,
      results,
    }
    output.arms.push(record)
    printArm(record)
  }

  output.finished_at = new Date().toISOString()
  printSummary(output.arms)

  const outPath = values.out ?? `billing-probe-${timestamp()}.json`
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  console.log(`\njson: ${outPath}`)

  const failed = output.arms.some((record) => record.results.some((result) => !result.ok))
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error(`error: ${error?.message ?? error}`)
  process.exit(2)
})

