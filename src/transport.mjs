// The request transport: official timeouts, TCP keepalive, optional proxy,
// and streaming that never buffers a whole completion.
//
// The two deadlines are the ones the Vibe CLI itself uses
// (vibe/core/config/_defaults.py: DEFAULT_API_TIMEOUT = 720s,
// DEFAULT_API_STREAM_IDLE_TIMEOUT = 300s). A short header timeout would kill
// a deep-thinking request before its first byte, so there is deliberately
// none.

import { resolveProxy, shouldBypassProxy } from './proxy.mjs'

export class TransportError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export class TransportTimeoutError extends TransportError {
  constructor(phase, timeoutMs) {
    super(
      phase === 'first-output' ? 'TRANSPORT_TIMEOUT_FIRST_OUTPUT' : 'TRANSPORT_TIMEOUT_IDLE',
      phase === 'first-output'
        ? `No response headers within ${timeoutMs}ms`
        : `Response stream idle for ${timeoutMs}ms`,
    )
    this.name = 'TransportTimeoutError'
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

function classify(error) {
  if (error instanceof TransportError) return error
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return error
  const code = error?.code ?? error?.cause?.code ?? ''
  const message = error?.message ?? String(error)
  if (/ECONNRESET|UND_ERR_SOCKET|UND_ERR_CLOSED|EPIPE|socket hang up/i.test(`${code} ${message}`)) {
    return new TransportError('TRANSPORT_RESET', `Connection reset: ${message}`, { cause: error })
  }
  return new TransportError('TRANSPORT_NETWORK', message, { cause: error })
}

/**
 * @param {object} [options]
 * @param {string} [options.proxyUrl]   URL, "system"/"auto" to follow the environment or the Windows settings, or "none"
 * @param {Function} [options.proxyProbe]   tests: () => string | undefined
 * @param {string} [options.noProxy]        overrides NO_PROXY
 * @param {{proxy?: string, bypass?: string|string[]}} [options.resolvedProxy]
 *        an already resolved lookup; it is never re-read, so an explicit "none"
 *        stays direct even when the environment or the system says otherwise
 * @param {number} [options.firstOutputMs]  720s: request start to response headers
 * @param {number} [options.idleMs]         300s: between two stream chunks
 * @param {number} [options.keepAliveInitialDelayMs]
 * @param {number} [options.maxRetriesBeforeFirstByte]  default 0; never retries after output starts
 * @param {Function} [options.fetchImpl]    tests or a host-provided fetch
 * @param {Function} [options.undiciLoader] tests
 * @param {Function} [options.logger]       (level, message) => void
 */
export function createTransport({
  proxyUrl,
  proxyProbe,
  noProxy,
  resolvedProxy: preset,
  firstOutputMs = 720_000,
  idleMs = 300_000,
  keepAliveInitialDelayMs = 30_000,
  maxRetriesBeforeFirstByte = 0,
  fetchImpl,
  undiciLoader,
  logger,
} = {}) {
  // Magpie's plugin host is Bun. It replaces globalThis.fetch with a wrapper
  // that applies the host's proxy (and a per-request `proxy` option), so the
  // npm undici build must not be used there: it would bypass that wrapper.
  const bun = typeof globalThis.Bun !== 'undefined' && typeof globalThis.Bun.version === 'string'
  // The plugin resolves once so the API sockets, the control plane and the
  // vibe-acp child all leave through the same exit. A preset is used verbatim:
  // resolving again would turn `proxyUrl: "none"` back into whatever the
  // environment or the Windows settings happen to advertise.
  const { proxy, bypass } = preset ?? resolveProxy(proxyUrl, { probe: proxyProbe, noProxy, logger })
  const explicitProxy = !preset && Boolean(String(proxyUrl ?? '').trim())
  const resolved = new Map()

  const agentOptions = {
    connect: { keepAlive: true, keepAliveInitialDelay: keepAliveInitialDelayMs },
    keepAliveTimeout: 60_000,
    headersTimeout: 0,
    bodyTimeout: 0,
  }

  const resolveImpl = (kind) => {
    if (resolved.has(kind)) return resolved.get(kind)
    const pending = (async () => {
      if (fetchImpl) {
        if (explicitProxy) logger?.('warn', 'proxyUrl is set but a custom fetch was provided; the proxy is not applied')
        return { fetch: fetchImpl, dispatcher: undefined }
      }
      if (bun) return { fetch: globalThis.fetch, dispatcher: undefined }
      try {
        const mod = await (undiciLoader ? undiciLoader() : import('undici'))
        // Our watchdog owns both deadlines. undici's own headersTimeout
        // defaults to 300s, which would kill a 400s first byte before the
        // 720s budget is spent, so both internal timeouts are disabled.
        if (kind === 'proxy' && proxy) {
          return { fetch: mod.fetch, dispatcher: new mod.ProxyAgent({ uri: proxy, ...agentOptions }) }
        }
        return { fetch: mod.fetch, dispatcher: new mod.Agent(agentOptions) }
      } catch (error) {
        logger?.(
          'warn',
          `undici unavailable, falling back to global fetch${kind === 'proxy' ? ' (proxy is left to Node)' : ''}: ${error?.message ?? error}`,
        )
        return { fetch: globalThis.fetch, dispatcher: undefined }
      }
    })()
    resolved.set(kind, pending)
    return pending
  }

  const fetch = async (url, init = {}) => {
    // A local target must stay direct even when a proxy is configured: the
    // plugin's own smoke tests and any self-hosted endpoint live on loopback.
    const useProxy = Boolean(proxy) && !shouldBypassProxy(url, bypass)
    const { fetch: impl, dispatcher } = await resolveImpl(useProxy ? 'proxy' : 'direct')
    let attempt = 0
    for (;;) {
      try {
        return await fetchOnce(impl, dispatcher, url, init, {
          firstOutputMs,
          idleMs,
          proxy: bun && useProxy ? proxy : undefined,
        })
      } catch (error) {
        const retryable = error?.code === 'TRANSPORT_RESET' || error?.code === 'TRANSPORT_NETWORK'
        const streamBody = init?.body && typeof init.body === 'object' && typeof init.body.getReader === 'function'
        if (!retryable || streamBody || attempt >= maxRetriesBeforeFirstByte || init?.signal?.aborted) throw error
        attempt += 1
        logger?.('warn', `retrying request after ${error.code} (${attempt}/${maxRetriesBeforeFirstByte})`)
        await sleepWithSignal(Math.min(250 * attempt, 1_000), init?.signal)
      }
    }
  }

  return { fetch }
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchOnce(impl, dispatcher, url, init, { firstOutputMs, idleMs, proxy }) {
  const caller = init?.signal
  if (caller?.aborted) throw caller.reason ?? new DOMException('Aborted', 'AbortError')
  const controller = new AbortController()
  let timedOut = null

  const onCallerAbort = () => {
    controller.abort(caller?.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  if (caller) {
    caller.addEventListener('abort', onCallerAbort, { once: true })
  }
  const cleanup = () => {
    if (caller) caller.removeEventListener('abort', onCallerAbort)
  }

  const firstTimer = setTimeout(() => {
    timedOut = new TransportTimeoutError('first-output', firstOutputMs)
    controller.abort(timedOut)
  }, firstOutputMs)

  let response
  try {
    const sendInit = { ...init, signal: controller.signal }
    if (dispatcher) sendInit.dispatcher = dispatcher
    if (proxy && sendInit.proxy === undefined) sendInit.proxy = proxy
    response = await impl(url, sendInit)
  } catch (error) {
    clearTimeout(firstTimer)
    cleanup()
    if (timedOut) throw timedOut
    if (caller?.aborted) throw caller.reason ?? new DOMException('Aborted', 'AbortError')
    throw classify(error)
  }
  clearTimeout(firstTimer)

  if (!response.body || response.bodyUsed) {
    cleanup()
    return response
  }
  return wrapBody(response, {
    controller,
    reader: response.body.getReader(),
    idleMs,
    cleanup,
  })
}

function wrapBody(response, { controller, reader, idleMs, cleanup }) {
  let idleTimer = null
  let finished = false
  let failure = null
  let controllerRef = null

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const finish = () => {
    if (finished) return
    finished = true
    clearIdle()
    controller.signal.removeEventListener('abort', onAbort)
    cleanup()
  }
  const fail = (error) => {
    if (failure || finished) return
    failure = error
    clearIdle()
    try {
      controller.abort(error)
    } catch {}
    try {
      controllerRef?.error(error)
    } catch {}
    reader.cancel(error).catch(() => {})
    finish()
  }
  const onAbort = () => {
    if (failure || finished) return
    fail(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })

  const armIdle = () => {
    clearIdle()
    idleTimer = setTimeout(() => fail(new TransportTimeoutError('stream-idle', idleMs)), idleMs)
  }

  const stream = new ReadableStream({
    async pull(ctrl) {
      controllerRef = ctrl
      if (failure) {
        try {
          ctrl.error(failure)
        } catch {}
        return
      }
      armIdle()
      let result
      try {
        result = await reader.read()
      } catch (error) {
        clearIdle()
        if (failure) {
          try {
            ctrl.error(failure)
          } catch {}
        } else {
          const wrapped = classify(error)
          finish()
          try {
            ctrl.error(wrapped)
          } catch {}
        }
        return
      }
      clearIdle()
      if (failure) return
      if (result.done) {
        finish()
        try {
          ctrl.close()
        } catch {}
        return
      }
      try {
        ctrl.enqueue(result.value)
      } catch {
        finish()
      }
    },
    cancel(reason) {
      finish()
      try {
        controller.abort(reason)
      } catch {}
      return reader.cancel(reason)
    },
  })

  const headers = new Headers(response.headers)
  // the body is now a decoded byte stream, so these no longer describe it
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('transfer-encoding')

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
