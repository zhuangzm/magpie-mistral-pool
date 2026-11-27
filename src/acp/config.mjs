// Isolated VIBE_HOME, model table and child environment for `vibe-acp`.
// The child is the official CLI, so its own billing path (the $300 Vibe
// allowance) applies; nothing here imitates a client fingerprint.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { STATIC_VIBE_MODELS } from '../core.mjs'

const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const THINKING = {
  'zai-glm-5-3': ['low', 'high', 'max'],
  'zai-glm-5-3-flash': ['low', 'high', 'max'],
  'zai-glm-5-3-flash-vibe-free': ['low', 'high', 'max'],
  'deepseek-v4-1-flash-1017': ['off', 'low', 'high', 'max'],
  'mistral-large-4-0': ['low', 'medium', 'high'],
  'mistral-medium-latest': ['off', 'high'],
  'mistral-vibe-cli-latest': ['off', 'high'],
  'mistral-vibe-cli-with-tools': ['off', 'high'],
  'mistral-vibe-cli-fast': ['off'],
}

const DEFAULT_THINKING = ['low', 'medium', 'high']

export function resolveModelSpec(id) {
  const raw = String(id || 'mistral-medium-latest').trim()
  const known = STATIC_VIBE_MODELS[raw]
  const context = Number(known?.limit?.context) > 0 ? Number(known.limit.context) : 262_144
  return {
    id: raw,
    name: known?.name || raw,
    thinkingLevels: THINKING[raw] ? [...THINKING[raw]] : [...DEFAULT_THINKING],
    supportsImages: known?.attachment !== false,
    maxContextLength: context,
    autoCompactThreshold: Math.max(4_000, Math.round(context * 0.9)),
  }
}

export function resolveEffort(requested, levels) {
  const list = Array.isArray(levels) && levels.length > 0 ? levels : ['high']
  let wanted = typeof requested === 'string' ? requested.trim().toLowerCase() : ''
  if (wanted === 'xhigh' || wanted === 'ultra') wanted = 'max'
  if (wanted === 'minimal') wanted = 'low'
  if (!wanted) return list.includes('high') ? 'high' : list[list.length - 1]
  if (list.includes(wanted)) return wanted
  const target = EFFORT_ORDER.indexOf(wanted)
  if (target < 0) return list[list.length - 1]
  let best = list[0]
  let distance = Infinity
  for (const candidate of list) {
    const next = Math.abs(EFFORT_ORDER.indexOf(candidate) - target)
    if (next < distance) {
      best = candidate
      distance = next
    }
  }
  return best
}

export function apiBaseOf(value) {
  const clean = String(value || 'https://api.mistral.ai/v1').trim().replace(/\/+$/, '')
  return /\/v1$/i.test(clean) ? clean : `${clean}/v1`
}

export function sourceVibeHome() {
  const configured = String(process.env.VIBE_HOME || '').trim()
  return configured || join(homedir(), '.vibe')
}

const tomlString = (value) => JSON.stringify(String(value ?? ''))
const tomlArray = (items) => `[${items.map(tomlString).join(', ')}]`

/**
 * Write a runner-local VIBE_HOME. The provider block points at api.mistral.ai
 * with the account key from the environment; the agent profile keeps only the
 * MCP bridge tools enabled.
 */
export function prepareVibeHome({
  vibeHome,
  model,
  effort,
  serverName,
  baseUrl = 'https://api.mistral.ai/v1',
  sourceHome = sourceVibeHome(),
}) {
  mkdirSync(vibeHome, { recursive: true, mode: 0o700 })
  mkdirSync(join(vibeHome, 'prompts'), { recursive: true })
  mkdirSync(join(vibeHome, 'agents'), { recursive: true })

  for (const name of ['model_catalog_cache.json', 'whoami_cache.json', 'managed_config_cache.json']) {
    const from = join(sourceHome, name)
    const to = join(vibeHome, name)
    if (existsSync(from) && !existsSync(to)) {
      try {
        copyFileSync(from, to)
      } catch {
        // cache copy is optional
      }
    }
  }

  const bridgePrompt = [
    'You are the model backend of a Magpie session. Magpie owns the conversation, tools, and permissions.',
    `Client tools are exposed through \`run_typescript\` as \`tools.${vibeGroupName(serverName)}.<name>(args)\`.`,
    'Built-in local Vibe tools are disabled and must not be called.',
    `If a tool returns a [MAGPIE_RELAY] notice, do not call the original tool again; call \`await tools.${vibeGroupName(serverName)}.magpie_await_result({ call_id })\` to wait for it.`,
    'The first prompt may contain <magpie_context>, <magpie_tools> and <magpie_history>. Continue from the latest user or tool input.',
  ].join('\n')
  writeFileSync(join(vibeHome, 'prompts', 'magpie_bridge.md'), `${bridgePrompt}\n`, 'utf8')

  writeFileSync(
    join(vibeHome, 'agents', 'magpie-bridge.toml'),
    [
      'display_name = "Magpie Bridge"',
      'description = "Magpie provider ACP bridge"',
      'safety = "yolo"',
      'system_prompt_id = "magpie_bridge"',
    ].join('\n') + '\n',
    'utf8',
  )

  const spec = resolveModelSpec(model)
  const thinking = resolveEffort(effort, spec.thinkingLevels)
  const enabledTools = serverName ? [`${serverName}_*`] : ['__magpie_no_tools__']

  const config = [
    `active_model = ${tomlString(spec.id)}`,
    'default_agent = "magpie-bridge"',
    'bypass_tool_permissions = true',
    'enable_auto_approve = true',
    `enabled_tools = ${tomlArray(enabledTools)}`,
    'enable_subagents = false',
    'enable_background_processes = false',
    'include_project_context = false',
    'include_prompt_detail = false',
    'include_commit_signature = false',
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
    `api_base = ${tomlString(apiBaseOf(baseUrl))}`,
    'api_key_env_var = "MISTRAL_API_KEY"',
    'backend = "mistral"',
    'preserve_api_base = true',
    '',
    '[[models]]',
    `name = ${tomlString(spec.id)}`,
    'provider = "mistral"',
    `alias = ${tomlString(spec.id)}`,
    `display_name = ${tomlString(spec.name)}`,
    `thinking = ${tomlString(thinking)}`,
    `thinking_levels = ${tomlArray(spec.thinkingLevels)}`,
    `supports_images = ${spec.supportsImages ? 'true' : 'false'}`,
    `max_context_length = ${spec.maxContextLength}`,
    `auto_compact_threshold = ${spec.autoCompactThreshold}`,
    '',
  ].join('\n')

  const configPath = join(vibeHome, 'config.toml')
  writeFileSync(configPath, config, 'utf8')
  try {
    chmodSync(configPath, 0o600)
  } catch {
    // Windows ignores chmod
  }
  return { spec, thinking }
}

const ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]

export function buildChildEnv({ vibeHome, apiKey, proxyUrl, base = process.env }) {
  const keep = new Set(ENV_KEYS.map((key) => key.toUpperCase()))
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && keep.has(key.toUpperCase())) env[key] = value
  }
  env.HOME = homedir()
  env.USERPROFILE = homedir()
  if (proxyUrl) {
    env.HTTP_PROXY ??= proxyUrl
    env.HTTPS_PROXY ??= proxyUrl
    env.ALL_PROXY ??= proxyUrl
  }
  env.NO_PROXY = [env.NO_PROXY, 'localhost,127.0.0.1,::1'].filter(Boolean).join(',')
  env.VIBE_HOME = vibeHome
  env.MISTRAL_API_KEY = apiKey
  return env
}

export function resolveVibeAcp(explicit) {
  const configured = String(explicit || process.env.VIBE_ACP_CMD || '').trim()
  if (configured) return configured
  if (process.platform === 'win32') {
    try {
      const found = spawnSync('where.exe', ['vibe-acp'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
      const line = String(found.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      if (line) return line
    } catch {
      // fall through to PATH
    }
  }
  return 'vibe-acp'
}

export function killTree(child, { force = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5_000,
      })
    } catch {
      // fall back to child.kill
    }
  }
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // already gone
  }
  if (!force) {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }, 2_000)
    timer.unref?.()
  }
}

export function vibeGroupName(serverName) {
  const normalized = String(serverName || 'magpie').replace(/[^A-Za-z0-9_$]/g, '_') || '_'
  return `mcp_${normalized}`
}

