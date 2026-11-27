// Constants, the Vibe-surface model catalog, key-type detection and header
// hygiene.
//
// This is the honest half of the two upstream implementations this package
// borrows from: MistralVibe2API's header allowlist and Vibe catalog, without
// its User-Agent rewrite, and magpie-mistral-code's whoami/usage reads.

export const PROVIDER = 'mistral-vibe'
export const DEFAULT_BASE = 'https://api.mistral.ai/v1'
export const DEFAULT_CONSOLE_BASE = 'https://console.mistral.ai'
export const DEFAULT_LIMIT = { context: 262_144, output: 32_768 }

const trimBase = (value, fallback = '') => {
  const out = String(value ?? fallback).trim().replace(/\/+$/, '')
  return out || fallback
}

/** The Chat Completions base, without a trailing slash. */
export function baseUrlOf(options = {}) {
  return trimBase(options.baseUrl, DEFAULT_BASE)
}

/**
 * An API base without its version segment: `https://api.mistral.ai/v1` and
 * `https://api.mistral.ai/api/v1` both become `https://api.mistral.ai`.
 *
 * Console and API bases are stored in the same option, so every path that
 * is rooted at the origin (whoami, sign-in) goes through this first; that is
 * what keeps `/v1/api/vibe/whoami` from being requested.
 */
export function originOf(base) {
  let out = trimBase(base, '')
  for (;;) {
    const next = out.replace(/\/api\/v1$/i, '').replace(/\/v1$/i, '')
    if (next === out) return out
    out = next
  }
}

/** `https://console.mistral.ai/api`, whether or not the base had `/api`. */
export function consoleApiOf(options = {}) {
  const origin = originOf(options.consoleBase ?? DEFAULT_CONSOLE_BASE).replace(/\/api$/i, '')
  return `${origin}/api`
}

/** `https://console.mistral.ai/api/vibe/whoami`, never `/v1/api/vibe/whoami`. */
export function whoamiUrlOf(options = {}) {
  const origin = originOf(options.consoleBase ?? DEFAULT_CONSOLE_BASE).replace(/\/api$/i, '')
  return `${origin}/api/vibe/whoami`
}

const ALLOWED_CLIENT_HEADERS = new Set([
  'content-type',
  'accept',
  'x-affinity',
  'x-session-id',
  'x-session-affinity',
])

/**
 * Build the headers an upstream request carries.
 *
 * Only the headers that carry protocol meaning or Magpie's session affinity
 * survive. Everything a harness adds to identify itself (user-agent,
 * x-stainless-*, origin, cookie, a client-supplied api key, anthropic-*) is
 * dropped, and the account's key is the only credential sent. A User-Agent is written only
 * when the caller explicitly configured one.
 */
export function sanitizeHeaders(incoming, options = {}) {
  const headers = new Headers()
  if (incoming) {
    const source = incoming instanceof Headers ? incoming : new Headers(incoming)
    for (const [name, value] of source) {
      const lower = name.toLowerCase()
      if (!ALLOWED_CLIENT_HEADERS.has(lower)) continue
      headers.set(lower, value)
    }
  }

  if (options.stream) {
    headers.set('accept', 'text/event-stream')
  } else {
    const accept = headers.get('accept')
    if (!accept || accept.trim() === '*/*') headers.set('accept', 'application/json')
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  if (options.key) headers.set('authorization', `Bearer ${options.key}`)
  if (options.userAgent) headers.set('user-agent', String(options.userAgent))
  if (options.extraHeaders) {
    for (const [name, value] of Object.entries(options.extraHeaders)) {
      if (value !== undefined && value !== null) headers.set(name, String(value))
    }
  }
  return headers
}

/** True when a JSON body asks for a streamed completion. */
export function isStreamBody(body) {
  let text = ''
  if (typeof body === 'string') {
    text = body
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    try {
      text = new TextDecoder().decode(body)
    } catch {
      return false
    }
  }
  if (!text || !/"stream"\s*:\s*true/.test(text)) return false
  try {
    return JSON.parse(text)?.stream === true
  } catch {
    return true
  }
}

// USD per 1M tokens, standard tier. Medium 3.5 and the vibe-cli aliases have
// no published API rate, so they carry no cost rather than a made-up zero.
const MODEL_COSTS = {
  'mistral-large-4-0': { input: 0.7, output: 2.1, cache: { read: 0.07, write: 0 } },
  'zai-glm-5-3': { input: 1.4, output: 4.4, cache: { read: 0.14, write: 0 } },
  'zai-glm-5-3-flash': { input: 0.15, output: 0.5, cache: { read: 0.03, write: 0 } },
  'zai-glm-5-3-flash-vibe-free': { input: 0.15, output: 0.5, cache: { read: 0.03, write: 0 } },
  'deepseek-v4-1-flash-1017': { input: 0.3, output: 1.2, cache: { read: 0.007, write: 0 } },
}

const MODEL_SPECS = [
  {
    id: 'mistral-vibe-cli-latest',
    name: 'Mistral Vibe CLI (Medium 3.5)',
    context: 262_144,
    output: 32_768,
    reasoning: true,
    image: true,
  },
  {
    id: 'mistral-vibe-cli-with-tools',
    name: 'Mistral Vibe CLI with Tools (Medium 3.5)',
    context: 262_144,
    output: 32_768,
    reasoning: true,
  },
  {
    id: 'mistral-vibe-cli-fast',
    name: 'Mistral Vibe CLI Fast',
    context: 262_144,
    output: 32_768,
  },
  {
    id: 'mistral-medium-latest',
    name: 'Mistral Medium 3.5',
    context: 262_144,
    output: 32_768,
    reasoning: true,
    image: true,
  },
  {
    id: 'mistral-large-4-0',
    name: 'Mistral Large 4',
    context: 1_048_576,
    output: 32_768,
    reasoning: true,
    image: true,
  },
  {
    id: 'zai-glm-5-3',
    name: 'GLM 5.3 (Mistral Hosted)',
    context: 1_048_576,
    output: 32_768,
    reasoning: true,
  },
  {
    id: 'zai-glm-5-3-flash',
    name: 'GLM 5.3 Flash (Mistral Hosted)',
    context: 1_048_576,
    output: 32_768,
    reasoning: true,
    image: true,
  },
  {
    id: 'zai-glm-5-3-flash-vibe-free',
    name: 'GLM 5.3 Flash (Vibe Free)',
    context: 262_144,
    output: 32_768,
    reasoning: true,
    image: true,
  },
  {
    id: 'deepseek-v4-1-flash-1017',
    name: 'DeepSeek V4.1 Flash (Mistral Hosted)',
    context: 1_048_576,
    output: 32_768,
    reasoning: true,
    image: true,
  },
]

const modalitiesOf = (image) => ({
  input: image ? ['text', 'image'] : ['text'],
  output: ['text'],
})

const capabilitiesOf = ({ reasoning, toolcall, image }) => ({
  temperature: true,
  reasoning,
  attachment: image,
  toolcall,
  input: { text: true, image, audio: false, video: false, pdf: false },
  output: { text: true, image: false, audio: false, video: false, pdf: false },
  interleaved: false,
})

function staticModelOf(spec) {
  const reasoning = spec.reasoning === true
  const image = spec.image === true
  const model = {
    name: spec.name,
    limit: { context: spec.context ?? DEFAULT_LIMIT.context, output: spec.output ?? DEFAULT_LIMIT.output },
    tool_call: true,
    attachment: image,
    reasoning,
    temperature: true,
    modalities: modalitiesOf(image),
    capabilities: capabilitiesOf({ reasoning, toolcall: true, image }),
  }
  const cost = MODEL_COSTS[spec.id]
  if (cost) model.cost = { ...cost, cache: { ...cost.cache } }
  return model
}

/** The Vibe surface, used until (or instead of) the account's own catalog. */
export const STATIC_VIBE_MODELS = Object.freeze(
  Object.fromEntries(MODEL_SPECS.map((spec) => [spec.id, staticModelOf(spec)])),
)

export function cloneStaticModels() {
  return structuredClone(STATIC_VIBE_MODELS)
}

// The CLI's own wire names. The Vibe catalog lists the models but not these
// aliases; /v1/models does. Keep them selectable so an agent configured with
// `mistral-vibe-cli-latest` (the CLI's default route) keeps working.
const VIBE_CLI_ALIASES = [
  'mistral-vibe-cli-latest',
  'mistral-vibe-cli-with-tools',
  'mistral-vibe-cli-fast',
]

function withCliAliases(models, vibeOnly) {
  if (!vibeOnly) return models
  for (const id of VIBE_CLI_ALIASES) {
    if (!models[id] && STATIC_VIBE_MODELS[id]) models[id] = structuredClone(STATIC_VIBE_MODELS[id])
  }
  return models
}

// codestral / ministral / pixtral are API-surface families. A Vibe key must
// not see them, even if a live list happens to include one.
const API_SURFACE = /^(codestral|ministral|pixtral)(-|$)/i

export function isApiSurfaceModel(id) {
  return typeof id === 'string' && API_SURFACE.test(id)
}

/**
 * A catalog or /models entry as the OpenCode 1.x model shape Magpie reads.
 * Known Vibe models keep their curated limits and price; unknown entries
 * take what the catalog states and sensible defaults.
 */
export function toOpenCodeModel(id, entry = {}, known = STATIC_VIBE_MODELS[id]) {
  const base = known ?? {}
  const context = Number(entry.max_context_length) > 0
    ? Number(entry.max_context_length)
    : base.limit?.context ?? DEFAULT_LIMIT.context
  const output = Number(entry.max_output_length) > 0
    ? Number(entry.max_output_length)
    : base.limit?.output ?? DEFAULT_LIMIT.output
  const caps = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {}
  const reasoning = caps.reasoning ?? base.reasoning ?? false
  const toolcall = caps.function_calling ?? base.tool_call ?? true
  const image = caps.vision ?? base.attachment ?? false
  const name = entry.label ?? entry.name ?? base.name ?? id

  const model = {
    name,
    limit: { context, output },
    tool_call: toolcall,
    attachment: image,
    reasoning,
    temperature: true,
    modalities: modalitiesOf(image),
    capabilities: capabilitiesOf({ reasoning, toolcall, image }),
  }
  const cost = base.cost
  if (cost) model.cost = { ...cost, cache: { ...cost.cache } }
  if (Array.isArray(entry.aliases) && entry.aliases.length) model.aliases = [...entry.aliases]
  return model
}

/** Map `GET /model-catalog?surface=vibe-code` to the model record. */
export function modelsFromCatalog(entries, { vibeOnly = true } = {}) {
  const out = {}
  for (const entry of entries ?? []) {
    const id = entry?.id
    if (typeof id !== 'string' || !id) continue
    if (vibeOnly && isApiSurfaceModel(id)) continue
    if (vibeOnly && typeof entry.surface === 'string' && !/vibe/i.test(entry.surface)) continue
    out[id] = toOpenCodeModel(id, entry, STATIC_VIBE_MODELS[id])
  }
  return out
}

/** Map `GET /models`, keeping only ids that resolve to the Vibe surface. */
export function modelsFromList(entries, { vibeOnly = true } = {}) {
  const out = {}
  for (const entry of entries ?? []) {
    const id = entry?.id
    if (typeof id !== 'string' || !id) continue
    const names = [
      entry.billing_model_name,
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
      id,
    ].filter((name) => typeof name === 'string' && name)
    const knownId = names.find((name) => STATIC_VIBE_MODELS[name])
    if (vibeOnly && !knownId) continue
    const known = knownId ? STATIC_VIBE_MODELS[knownId] : undefined
    out[id] = toOpenCodeModel(id, { ...entry, label: entry.name ?? known?.name }, known)
  }
  return out
}

async function getJson(fetchImpl, url, key, options) {
  try {
    const response = await fetchImpl(url, {
      headers: sanitizeHeaders(null, { key, userAgent: options.userAgent }),
      signal: AbortSignal.timeout(options.modelsTimeoutMs ?? 15_000),
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {})
      return null
    }
    return await response.json().catch(() => null)
  } catch {
    return null
  }
}

/**
 * The account's own model list: the Vibe catalog first, then /v1/models, then
 * the static surface. A Vibe or unknown key never sees API-surface models;
 * an API key sees everything only when `includeApiSurface` is on.
 */
export async function loadModels({ key, keyType = 'unknown', options = {} } = {}) {
  const base = baseUrlOf(options)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const vibeOnly = !(keyType === 'api' && options.includeApiSurface === true)

  if (key) {
    const catalog = await getJson(fetchImpl, `${base}/model-catalog?surface=vibe-code`, key, options)
    if (Array.isArray(catalog?.models) && catalog.models.length) {
      return withCliAliases(modelsFromCatalog(catalog.models, { vibeOnly }), vibeOnly)
    }
    const list = await getJson(fetchImpl, `${base}/models`, key, options)
    if (Array.isArray(list?.data) && list.data.length) {
      return withCliAliases(modelsFromList(list.data, { vibeOnly }), vibeOnly)
    }
  }
  return cloneStaticModels()
}

/**
 * Ask the console which product area a key belongs to. `plan_type` is CHAT
 * for a Vibe key and API for a Studio/API key; an unreachable whoami leaves
 * the type unknown and the key usable.
 */
export async function identifyKey(key, options = {}) {
  if (!key) return { keyType: 'unknown' }
  const fetchImpl = options.fetch ?? globalThis.fetch
  // A caller that only knows the API base still gets a valid whoami URL: the
  // version segment is stripped, so `https://api.mistral.ai/v1` asks
  // `https://api.mistral.ai/api/vibe/whoami`, never `/v1/api/vibe/whoami`.
  const consoleBase = options.consoleBase ?? options.baseUrl
  try {
    const response = await fetchImpl(whoamiUrlOf({ consoleBase }), {
      headers: sanitizeHeaders(null, { key, userAgent: options.userAgent }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {})
      return { keyType: 'unknown', status: response.status }
    }
    const data = await response.json().catch(() => ({}))
    const planType = typeof data?.plan_type === 'string' ? data.plan_type : undefined
    return {
      keyType: planType === 'API' ? 'api' : planType ? 'vibe' : 'unknown',
      planType,
      planName: typeof data?.plan_name === 'string' ? data.plan_name : undefined,
      status: response.status,
    }
  } catch {
    return { keyType: 'unknown' }
  }
}
