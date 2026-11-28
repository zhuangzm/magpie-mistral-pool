// Mistral Vibe, as an honest Magpie provider plugin, with a direct or official
// ACP engine.
//
// What it does:
// - Browser sign-in is the CLI's own PKCE flow (console.mistral.ai
//   /api/vibe/sign-in), or a Vibe key pasted from the console.
// - The default engine sends plain OpenAI Chat Completions on
//   api.mistral.ai/v1 with the account key as a bearer token. Headers a
//   harness adds to identify itself are dropped; no User-Agent is written
//   unless `options.userAgent` asks for one. An earlier turn's thinking is
//   moved into Mistral's typed part.
// - `options.engine: "acp"` runs the official vibe-acp child and bridges
//   Magpie's tools over MCP, billing the $300 Vibe pool. Magpie still talks
//   Chat Completions to this plugin; no client fingerprint is invented.
// - Models come from the Vibe surface catalog; a Vibe key never sees
//   codestral / ministral / pixtral.
// - Usage is the public /billing/subscription + /billing/budget read, with
//   the key's own pool counting and the other shown aside.
//
// It does not spoof a client fingerprint, simulate whoami/managed-config
// handshakes, pool keys, or expose its own /v1 endpoints. Those are Magpie's.

import { createHash, randomBytes } from 'node:crypto'
import {
  PROVIDER,
  DEFAULT_CONSOLE_BASE,
  STATIC_VIBE_MODELS,
  baseUrlOf,
  cloneStaticModels,
  consoleApiOf,
  identifyKey,
  isStreamBody,
  loadModels,
  sanitizeHeaders,
} from './src/core.mjs'
import { mistralBody } from './src/thinking.mjs'
import { fetchBilling, usageFromBilling } from './src/billing.mjs'
import { createTransport } from './src/transport.mjs'
import { createAcpBridge } from './src/acp/runtime.mjs'
import { resolveProxy } from './src/proxy.mjs'

const POLL_EVERY_MS = 3_000
const RATE_LIMIT_MAX_WAIT_MS = 30_000
const POLL_429_MAX_ATTEMPTS = 6
const EXCHANGE_MAX_ATTEMPTS = 6
const SIGN_IN_TTL_MS = 10 * 60 * 1_000
const KEY_TYPE_TTL_MS = 10 * 60 * 1_000
const WORKSPACE_NOT_ELIGIBLE_CODE = 9004

const keyOf = (auth) => auth?.key || auth?.access || ''

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })

// ---- the browser sign-in (vibe's setup/auth/http_browser_sign_in_gateway) ----

const newVerifier = () => randomBytes(48).toString('base64url')
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url')

function rateLimitWaitMs(response, previousMs = 0, baseMs = POLL_EVERY_MS) {
  const raw = response?.headers?.get?.('retry-after')?.trim()
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) {
      if (seconds > 0) return Math.min(Math.ceil(seconds * 1_000), RATE_LIMIT_MAX_WAIT_MS)
    } else {
      const at = Date.parse(raw)
      if (Number.isFinite(at)) {
        const delta = at - Date.now()
        if (delta > 0) return Math.min(delta, RATE_LIMIT_MAX_WAIT_MS)
      }
    }
  }
  return Math.min(Math.max(previousMs * 2, baseMs * 2), RATE_LIMIT_MAX_WAIT_MS)
}

async function readErrorInfo(response) {
  try {
    const text = await response.text()
    if (!text) return { errorCode: undefined, detail: '' }
    try {
      const body = JSON.parse(text)
      let detail = ''
      for (const field of ['detail', 'message', 'error']) {
        if (typeof body?.[field] === 'string' && body[field].trim()) {
          detail = body[field].trim().slice(0, 200)
          break
        }
      }
      return { errorCode: body?.error_code, detail }
    } catch {
      return { errorCode: undefined, detail: text.trim().slice(0, 200) }
    }
  } catch {
    return { errorCode: undefined, detail: '' }
  }
}

function signInHeaders(ctx, extra = {}) {
  const headers = { accept: 'application/json', ...extra }
  if (ctx.userAgent) headers['user-agent'] = ctx.userAgent
  return headers
}

async function startSignIn(ctx, signal) {
  const codeVerifier = newVerifier()
  const response = await ctx.fetch(`${ctx.consoleApi}/vibe/sign-in`, {
    method: 'POST',
    headers: signInHeaders(ctx, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      code_challenge: challengeOf(codeVerifier),
      code_challenge_method: 'S256',
    }),
    signal,
  })
  if (!response.ok) {
    const { detail } = await readErrorInfo(response)
    const suffix = response.status === 429 ? ' (rate-limited; switch proxy node or wait before trying again)' : ''
    throw new Error(`Mistral sign-in could not start (${response.status}${detail ? `: ${detail}` : ''})${suffix}`)
  }
  const data = await response.json()
  if (!data?.process_id || !data?.sign_in_url || !data?.poll_url) {
    throw new Error('Mistral sign-in answered an unexpected payload')
  }
  return {
    process_id: data.process_id,
    sign_in_url: data.sign_in_url,
    poll_url: data.poll_url,
    expires_at: data.expires_at,
    code_verifier: codeVerifier,
  }
}

async function pollSignIn(ctx, pollUrl, signal) {
  const response = await ctx.fetch(pollUrl, { headers: signInHeaders(ctx), signal })
  if (response.status === 410) {
    await response.body?.cancel?.().catch(() => {})
    return { status: 'expired' }
  }
  if (response.status === 429) {
    const { detail } = await readErrorInfo(response)
    const cfRay = response.headers?.get?.('cf-ray') || ''
    return { status: 'rate_limited', response, detail, cfRay }
  }
  if (!response.ok) {
    const { detail } = await readErrorInfo(response)
    const error = new Error(`Mistral sign-in poll answered ${response.status}${detail ? `: ${detail}` : ''}`)
    error.status = response.status
    throw error
  }
  return await response.json()
}

async function exchangeSignIn(ctx, processId, exchangeToken, codeVerifier, signal, deadline, log) {
  const url = `${ctx.consoleApi}/vibe/sign-in/${encodeURIComponent(processId)}/exchange`
  const payload = JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier })
  let wait = 0
  let lastStatus = 0
  let lastDetail = ''

  for (let attempt = 1; attempt <= EXCHANGE_MAX_ATTEMPTS; attempt += 1) {
    let response
    try {
      response = await ctx.fetch(url, {
        method: 'POST',
        headers: signInHeaders(ctx, { 'content-type': 'application/json' }),
        body: payload,
        signal,
      })
    } catch (error) {
      if (signal?.aborted || attempt >= EXCHANGE_MAX_ATTEMPTS) throw error
      wait = Math.min(Math.max(wait * 2, ctx.pollEveryMs), RATE_LIMIT_MAX_WAIT_MS)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw error
      const waitMs = Math.min(wait, remaining)
      log?.('warn', `sign-in exchange network error (${attempt}/${EXCHANGE_MAX_ATTEMPTS}) wait=${waitMs}ms: ${error?.message ?? error}`)
      await sleep(waitMs, signal)
      continue
    }

    if (response.ok) {
      const data = await response.json()
      if (!data?.api_key) throw new Error('Mistral sign-in exchange returned no API key')
      return data.api_key
    }

    const { errorCode, detail } = await readErrorInfo(response)
    lastStatus = response.status
    lastDetail = detail
    if (response.status === 403 && errorCode === WORKSPACE_NOT_ELIGIBLE_CODE) {
      throw new Error('Current Mistral workspace is not eligible for Mistral Vibe; sign in again and select another workspace')
    }

    const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504
    if (!retryable || attempt >= EXCHANGE_MAX_ATTEMPTS) {
      throw new Error(`Mistral sign-in exchange failed (${response.status}${detail ? `: ${detail}` : ''})`)
    }

    wait = response.status === 429
      ? rateLimitWaitMs(response, wait, ctx.pollEveryMs)
      : Math.min(Math.max(wait * 2, ctx.pollEveryMs), RATE_LIMIT_MAX_WAIT_MS)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Mistral sign-in exchange failed (${lastStatus}${lastDetail ? `: ${lastDetail}` : ''})`)
    }
    const waitMs = Math.min(wait, remaining)
    const cfRay = response.headers?.get?.('cf-ray') || ''
    log?.('warn', `sign-in exchange ${response.status} (${attempt}/${EXCHANGE_MAX_ATTEMPTS}) wait=${waitMs}ms${cfRay ? ` cf-ray=${cfRay}` : ''}${detail ? ` detail=${detail}` : ''}`)
    await sleep(waitMs, signal)
  }

  throw new Error(`Mistral sign-in exchange failed (${lastStatus || 'unknown'}${lastDetail ? `: ${lastDetail}` : ''})`)
}

async function whoamiOf(ctx, key) {
  const response = await ctx.fetch(`${ctx.consoleApi}/vibe/whoami`, {
    headers: signInHeaders(ctx, { authorization: `Bearer ${key}` }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) {
    await response.body?.cancel?.().catch?.(() => {})
    return null
  }
  return await response.json().catch(() => null)
}

// ---- one request, signed and normalized ----

function createPluginFetch({ key, options, transport }) {
  return async function pluginFetch(input, init = {}) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null
    const url = request ? request.url : String(input)
    const method = init.method ?? request?.method ?? 'GET'

    let body = init.body
    if (body === undefined && request && method !== 'GET' && method !== 'HEAD') {
      body = await request.clone().arrayBuffer()
    }
    const normalized = mistralBody(body)
    const headers = sanitizeHeaders(init.headers ?? request?.headers, {
      key,
      stream: isStreamBody(normalized),
      userAgent: options.userAgent,
    })

    const sendInit = { ...init, method, headers }
    if (normalized === undefined) delete sendInit.body
    else sendInit.body = normalized
    if (request) {
      sendInit.signal ??= request.signal
      sendInit.redirect ??= request.redirect
    }
    if (
      sendInit.body &&
      typeof sendInit.body === 'object' &&
      typeof sendInit.body.getReader === 'function' &&
      sendInit.duplex === undefined
    ) {
      sendInit.duplex = 'half'
    }
    return transport.fetch(url, sendInit)
  }
}

function createAcpFetch({ bridge, fallback }) {
  return async function acpFetch(input, init = {}) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null
    const url = request ? request.url : String(input)
    const method = init.method ?? request?.method ?? 'POST'
    let body = init.body
    if (body === undefined && request && method !== 'GET' && method !== 'HEAD') {
      body = await request.clone().arrayBuffer()
    }
    if (!/\/chat\/completions(?:\?|$)/i.test(url)) {
      return fallback(url, {
        ...init,
        method,
        body,
        headers: init.headers ?? request?.headers,
        signal: init.signal ?? request?.signal,
      })
    }
    try {
      return await bridge.fetch(url, {
        ...init,
        method,
        body,
        headers: init.headers ?? request?.headers,
        signal: init.signal ?? request?.signal,
      })
    } catch (error) {
      const status = Number(error?.status) >= 400 ? Number(error.status) : 500
      return new Response(JSON.stringify({
        error: {
          message: error?.message ?? String(error),
          type: error?.code ?? 'provider_error',
          code: error?.code ?? 'provider_error',
        },
      }), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
  }
}

// ---- the plugin ----

export async function server(input = {}, options = {}) {
  const baseUrl = baseUrlOf(options)
  const consoleBase = options.consoleBase ?? DEFAULT_CONSOLE_BASE
  const engine = options.engine === 'acp' ? 'acp' : 'direct'
  // Two entries of this plugin can be loaded side by side (one ACP, one
  // direct) as long as each names its own provider id. The id is what the
  // host keys authentication, config and the provider registry by.
  const providerId = String(options.providerId ?? '').trim() || PROVIDER
  const log = (level, message) => {
    try {
      Promise.resolve(input?.client?.app?.log?.({ body: { service: providerId, level, message } })).catch(() => {})
    } catch {}
    try {
      options.log?.(level, message)
    } catch {}
  }

  // One resolution for the whole plugin: the control plane, the API sockets and
  // the vibe-acp child all leave through the same proxy. Unset means the
  // environment first, then the Windows system settings, then direct.
  const resolvedProxy = resolveProxy(options.proxyUrl, {
    probe: options.proxyProbe,
    // A user-typed exception list has to reach both the sockets and the child.
    noProxy: options.noProxy,
    logger: log,
  })
  log(
    'info',
    `proxy: ${resolvedProxy.source}${resolvedProxy.proxy ? ` ${resolvedProxy.proxy}` : ''}`,
  )

  const transport = createTransport({
    // Hand over the answer, not the question: re-resolving here would let an
    // explicit "none" be overridden by the environment or the system settings.
    resolvedProxy,
    firstOutputMs: options.firstOutputMs,
    idleMs: options.idleMs,
    keepAliveInitialDelayMs: options.keepAliveInitialDelayMs,
    maxRetriesBeforeFirstByte: options.maxRetriesBeforeFirstByte,
    fetchImpl: typeof options.fetch === 'function' ? options.fetch : undefined,
    undiciLoader: options.undiciLoader,
    logger: log,
  })

  // Everything, control plane included, goes through the same transport, so
  // a configured proxy and the keepalive agent cover whoami, billing and the
  // sign-in flow too. A test-supplied fetch is the transport's impl.
  const httpFetch = (url, init) => transport.fetch(url, init)

  const signInCtx = {
    fetch: httpFetch,
    consoleApi: consoleApiOf({ consoleBase }),
    userAgent: options.userAgent,
    pollEveryMs:
      Number.isFinite(Number(options.pollEveryMs)) && Number(options.pollEveryMs) > 0
        ? Number(options.pollEveryMs)
        : POLL_EVERY_MS,
  }

  const keyTypes = new Map()
  const keyInfoOf = async (key) => {
    const now = Date.now()
    const hit = keyTypes.get(key)
    if (hit && hit.until > now) return hit.value
    const value = await identifyKey(key, {
      consoleBase,
      fetch: httpFetch,
      userAgent: options.userAgent,
      timeoutMs: options.whoamiTimeoutMs,
    })
    const retryTtl = Number.isFinite(Number(options.whoamiRetryMs)) && Number(options.whoamiRetryMs) >= 0
      ? Number(options.whoamiRetryMs)
      : 15_000
    const ttl = value.status ? KEY_TYPE_TTL_MS : retryTtl
    keyTypes.set(key, { value, until: now + ttl })
    if (keyTypes.size > 32) keyTypes.delete(keyTypes.keys().next().value)
    return value
  }

  const modelOptions = () => ({
    baseUrl,
    fetch: httpFetch,
    userAgent: options.userAgent,
    includeApiSurface: options.includeApiSurface,
    modelsTimeoutMs: options.modelsTimeoutMs,
  })

  const acpBridges = new Map()
  const maxBridges = Number(options.maxBridges) > 0 ? Number(options.maxBridges) : 4
  const isBridgeBusy = (bridge) =>
    bridge.stats.activeRequests > 0
    || [...bridge.conversations.values()].some((conv) =>
      conv.turn?.pendingCalls.size > 0
      || (conv.turn && !conv.turn.settled && !conv.turn.finished))
  const acpFor = (key) => {
    const existing = acpBridges.get(key)
    if (existing) {
      acpBridges.delete(key)
      acpBridges.set(key, existing)
      return existing
    }
    if (acpBridges.size >= maxBridges) {
      for (const [candidateKey, candidate] of acpBridges) {
        if (isBridgeBusy(candidate)) continue
        candidate.dispose?.().catch?.(() => {})
        acpBridges.delete(candidateKey)
        if (acpBridges.size < maxBridges) break
      }
    }
    const bridge = createAcpBridge({
      apiKey: key,
      options: {
        ...options,
        proxyUrl: resolvedProxy.proxy ?? 'none',
        noProxy: resolvedProxy.bypass.join(','),
      },
      log,
    })
    acpBridges.set(key, bridge)
    return bridge
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[providerId] ?? {}
      cfg.provider[providerId] = {
        ...was,
        name:
          options.providerName
          || (engine === 'acp'
            ? (providerId === PROVIDER ? 'Mistral Vibe (ACP · $300)' : `Mistral Vibe (ACP · ${providerId})`)
            : providerId === PROVIDER
              ? 'Mistral Vibe'
              : 'Mistral Vibe (API)'),
        npm: '@ai-sdk/openai-compatible',
        api: baseUrl,
        models: was.models ?? cloneStaticModels(),
      }
    },

    auth: {
      provider: providerId,

      methods: [
        {
          type: 'oauth',
          label: 'Sign in with Mistral (browser)',
          authorize: async (_inputs, { signal } = {}) => {
            let started
            try {
              started = await startSignIn(signInCtx, signal)
            } catch (error) {
              log('error', error?.message ?? String(error))
              throw error
            }
            log('info', `sign-in started process=${started.process_id}`)
            return {
              url: started.sign_in_url,
              instructions: 'Sign in to your Mistral account on the page that opens. The sign-in finishes here by itself.',
              method: 'auto',
              callback: async (_code, { signal: callbackSignal } = {}) => {
                const active = callbackSignal ?? (signal?.aborted ? undefined : signal)
                const deadline = Date.parse(started.expires_at) || Date.now() + SIGN_IN_TTL_MS
                let rateWait = 0
                let rate429 = 0
                let pollFailures = 0
                let loggedPending = false

                for (;;) {
                  if (Date.now() > deadline) {
                    log('warn', `sign-in timed out process=${started.process_id}`)
                    return { type: 'failed', error: 'The sign-in timed out; start it again' }
                  }

                  let result
                  try {
                    result = await pollSignIn(signInCtx, started.poll_url, active)
                  } catch (error) {
                    if (active?.aborted) throw error
                    pollFailures += 1
                    log('warn', `sign-in poll error (${pollFailures}) status=${error?.status ?? 'net'}: ${error?.message ?? error}`)
                    if (Date.now() > deadline) return { type: 'failed', error: `Sign-in poll failed: ${error?.message ?? error}` }
                    if (error?.status >= 400 && error?.status < 500 && error?.status !== 408 && pollFailures >= 3) {
                      return { type: 'failed', error: `Sign-in poll failed: ${error?.message ?? error}` }
                    }
                    const wait = Math.min(signInCtx.pollEveryMs * Math.min(pollFailures, 4), RATE_LIMIT_MAX_WAIT_MS)
                    const remaining = deadline - Date.now()
                    if (remaining <= 0) return { type: 'failed', error: `Sign-in poll failed: ${error?.message ?? error}` }
                    await sleep(Math.min(wait, remaining), active)
                    continue
                  }

                  if (result?.status === 'rate_limited') {
                    rate429 += 1
                    rateWait = rateLimitWaitMs(result.response, rateWait, signInCtx.pollEveryMs)
                    const remaining = deadline - Date.now()
                    const waitMs = Math.min(rateWait, Math.max(0, remaining))
                    log('warn', `sign-in poll 429 (${rate429}/${POLL_429_MAX_ATTEMPTS}) wait=${waitMs}ms${result.cfRay ? ` cf-ray=${result.cfRay}` : ''}${result.detail ? ` detail=${result.detail}` : ''}`)
                    if (rate429 >= POLL_429_MAX_ATTEMPTS) {
                      return {
                        type: 'failed',
                        error: `Sign-in poll rate-limited (429${result.detail ? `: ${result.detail}` : ''}): switch proxy node or wait before retrying`,
                      }
                    }
                    if (remaining <= 0) return { type: 'failed', error: 'The sign-in timed out; start it again' }
                    await sleep(waitMs, active)
                    continue
                  }

                  rateWait = 0
                  rate429 = 0
                  pollFailures = 0

                  if (result?.status === 'completed') {
                    if (!result.exchange_token) {
                      return { type: 'failed', error: 'Mistral sign-in completed without exchange token' }
                    }
                    log('info', `sign-in poll completed process=${started.process_id}; exchanging token`)
                    try {
                      const key = await exchangeSignIn(
                        signInCtx,
                        started.process_id,
                        result.exchange_token,
                        started.code_verifier,
                        active,
                        deadline,
                        log,
                      )
                      const who = await whoamiOf(signInCtx, key).catch(() => null)
                      log('info', `sign-in succeeded process=${started.process_id} plan=${who?.plan_name ?? 'unknown'}`)
                      const out = {
                        type: 'success',
                        key,
                        metadata: { plan: who?.plan_name, vibeEntitlement: who?.has_paid_vibe_entitlement },
                      }
                      if (who?.customer_id != null) out.accountId = String(who.customer_id)
                      return out
                    } catch (error) {
                      if (active?.aborted) throw error
                      log('error', `sign-in exchange failed process=${started.process_id}: ${error?.message ?? error}`)
                      return { type: 'failed', error: `Sign-in exchange failed: ${error?.message ?? error}` }
                    }
                  }

                  if (result?.status === 'expired') {
                    log('warn', `sign-in expired process=${started.process_id}`)
                    return { type: 'failed', error: 'The sign-in expired; start it again' }
                  }
                  if (result?.status === 'denied') {
                    log('warn', `sign-in denied process=${started.process_id}`)
                    return { type: 'failed', error: result.message || 'The sign-in was denied' }
                  }
                  if (result?.status === 'error') {
                    log('warn', `sign-in error process=${started.process_id}: ${result.message ?? 'unknown'}`)
                    return { type: 'failed', error: result.message || 'The sign-in failed' }
                  }
                  if (!loggedPending) {
                    loggedPending = true
                    log('info', `sign-in waiting for browser authorization process=${started.process_id}`)
                  }

                  const remaining = deadline - Date.now()
                  if (remaining <= 0) return { type: 'failed', error: 'The sign-in timed out; start it again' }
                  await sleep(Math.min(signInCtx.pollEveryMs, remaining), active)
                }
              },
            }
          },
        },
        {
          type: 'api',
          label: 'Vibe API key',
          placeholder: 'key made in console.mistral.ai under Code > Vibe Code CLI',
        },
      ],

      async usage(getAuth) {
        const key = keyOf(await getAuth())
        if (!key) return { error: 'Not signed in', windows: [] }
        try {
          const info = await keyInfoOf(key)
          const billing = await fetchBilling(key, {
            baseUrl,
            fetch: httpFetch,
            userAgent: options.userAgent,
            timeoutMs: options.billingTimeoutMs,
          })
          return usageFromBilling(billing, info)
        } catch (error) {
          return { error: `Mistral billing read failed: ${error?.message ?? error}`, windows: [] }
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        const key = keyOf(auth)
        if (!key) return {}
        if (engine === 'acp') {
          const directFetch = createPluginFetch({ key, options, transport })
          return {
            baseURL: baseUrl,
            apiKey: key,
            fetch: createAcpFetch({ bridge: acpFor(key), fallback: directFetch }),
          }
        }
        return {
          baseURL: baseUrl,
          apiKey: key,
          // the fetch below re-signs each request, so a rotated key or a
          // header the SDK added can never win over the account's own
          fetch: createPluginFetch({ key, options, transport }),
        }
      },
    },

    provider: {
      id: providerId,
      async models(provider, { auth } = {}) {
        const key = keyOf(auth)
        if (!key) return provider?.models ?? cloneStaticModels()
        const info = await keyInfoOf(key)
        return loadModels({ key, keyType: info.keyType, options: modelOptions() })
      },
    },

    async 'chat.headers'(chatInput, output) {
      const providerID = chatInput?.model?.providerID
      if (![providerId, `${providerId}-plugin`].includes(providerID)) return
      if (!chatInput?.sessionID) return
      output.headers['x-affinity'] = chatInput.sessionID
      output.headers['x-session-id'] = chatInput.sessionID
    },
  }
}

export default { id: PROVIDER, server }

// for tests
export const _internal = {
  startSignIn,
  pollSignIn,
  exchangeSignIn,
  rateLimitWaitMs,
  keyOf,
  createAcpFetch,
  STATIC_VIBE_MODELS,
}
