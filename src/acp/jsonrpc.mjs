// ACP speaks newline-delimited JSON-RPC 2.0 over the child's stdio.
// This peer multiplexes outgoing requests, answers the agent's own requests
// (permissions), and dispatches session/update notifications.

export const MAX_LINE_BYTES = 16 * 1024 * 1024

export class AcpRemoteError extends Error {
  constructor(method, rpc) {
    super(`${method}: ${rpc?.message ?? 'ACP request failed'}`)
    this.name = 'AcpRemoteError'
    this.method = method
    this.rpc = rpc
  }
}

export class AcpClosedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AcpClosedError'
  }
}

function parseFrame(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.jsonrpc !== '2.0') return undefined
  const id = value.id
  if (id !== undefined && id !== null && typeof id !== 'number' && typeof id !== 'string') return undefined
  if (typeof value.method === 'string') return value
  if (value.method !== undefined) return undefined
  if (typeof id !== 'number' && typeof id !== 'string') return undefined
  if (('result' in value) === ('error' in value)) return undefined
  return value
}

export class JsonRpcPeer {
  constructor(input, output, handlers = {}) {
    this.output = output
    this.handlers = handlers
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.closed = undefined

    input.setEncoding('utf8')
    input.on('data', (chunk) => this.#onData(String(chunk)))
    input.on('end', () => this.close(new AcpClosedError('ACP stream ended')))
    input.on('error', (error) => this.close(error instanceof Error ? error : new Error(String(error))))
    output.on('error', (error) => this.close(error instanceof Error ? error : new Error(String(error))))
  }

  get isClosed() {
    return this.closed !== undefined
  }

  request(method, params, { signal, timeoutMs } = {}) {
    if (this.closed !== undefined) {
      return Promise.reject(new AcpClosedError(`${method}: transport closed (${this.closed.message})`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        reject(signal?.reason instanceof Error ? signal.reason : new Error(`${method}: aborted`))
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          cleanup()
          reject(new Error(`${method}: no response within ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    if (this.closed === undefined) this.#write({ jsonrpc: '2.0', method, params })
  }

  close(error = new AcpClosedError('ACP peer closed')) {
    if (this.closed !== undefined) return
    this.closed = error
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new AcpClosedError(`${pending.method}: ${error.message}`))
    }
    this.handlers.onClose?.(error)
  }

  #write(message) {
    try {
      this.output.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  #onData(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) {
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          this.close(new AcpClosedError(`ACP emitted a frame above ${MAX_LINE_BYTES} bytes`))
          return
        }
        this.#onLine(line)
        if (this.closed !== undefined) return
      }
      newline = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
      this.close(new AcpClosedError(`ACP emitted a frame above ${MAX_LINE_BYTES} bytes`))
    }
  }

  #onLine(line) {
    const message = parseFrame(line)
    if (message === undefined) {
      this.close(new AcpClosedError(`ACP emitted invalid JSON-RPC: ${line.slice(0, 200)}`))
      return
    }
    if (message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new AcpRemoteError(pending.method, message.error))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined) {
      Promise.resolve()
        .then(() => this.handlers.onRequest?.(message.method, message.params))
        .then((result) => {
          if (this.closed === undefined) this.#write({ jsonrpc: '2.0', id: message.id, result })
        })
        .catch((error) => {
          if (this.closed === undefined) {
            this.#write({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: error?.code ?? -32603, message: error?.message ?? String(error) },
            })
          }
        })
      return
    }
    this.handlers.onNotification?.(message.method, message.params)
  }
}
