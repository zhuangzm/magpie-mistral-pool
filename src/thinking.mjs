// An earlier assistant turn's thinking, in the shape Mistral accepts.
//
// api.mistral.ai validates chat messages strictly: an unknown field turns
// the whole request away as 422 extra_forbidden. Most clients hand a prior
// thinking turn back as `reasoning_content`, `reasoning` or
// `reasoning_details`; Mistral takes it as a typed content part. This module
// moves it there and leaves every other body byte-for-byte untouched.

export const THINKING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details']

/** The thinking a message carries in one of THINKING_FIELDS. */
export function thinkingText(message) {
  for (const field of THINKING_FIELDS.slice(0, 2)) {
    const value = message[field]
    if (typeof value === 'string' && value !== '') return value
  }
  const details = message.reasoning_details
  if (!Array.isArray(details)) return ''
  let out = ''
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue
    if (typeof detail.text === 'string' && detail.text !== '') out += detail.text
    else if (typeof detail.summary === 'string') out += detail.summary
  }
  return out
}

/**
 * Put one message's thinking where Mistral takes it; returns whether the
 * message changed. A message with no thinking keeps its bytes. A prefill
 * (`prefix: true`) keeps its content: only the unknown field is dropped.
 */
export function asMistralMessage(message) {
  if (!THINKING_FIELDS.some((field) => field in message)) return false
  const think = thinkingText(message)
  for (const field of THINKING_FIELDS) delete message[field]
  if (think === '' || message.role !== 'assistant' || message.prefix === true) return true
  const part = { type: 'thinking', thinking: [{ type: 'text', text: think }] }
  const content = message.content
  if (typeof content === 'string') {
    message.content = content === '' ? [part] : [part, { type: 'text', text: content }]
  } else if (Array.isArray(content)) {
    message.content = [part, ...content]
  } else {
    message.content = [part]
  }
  return true
}

function transformString(body) {
  if (!body.includes('reasoning')) return body
  let request
  try {
    request = JSON.parse(body)
  } catch {
    return body
  }
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages)) return body
  let changed = false
  for (const message of request.messages) {
    if (message && typeof message === 'object' && asMistralMessage(message)) changed = true
  }
  return changed ? JSON.stringify(request) : body
}

/**
 * A chat request body with every message's thinking in the shape Mistral
 * takes. Accepts a string, Uint8Array/Buffer or ArrayBuffer; anything else
 * passes through. A body with nothing to move comes back as the same value
 * (same bytes, same identity).
 */
export function mistralBody(body) {
  if (typeof body === 'string') return transformString(body)
  if (body instanceof Uint8Array) {
    const text = new TextDecoder().decode(body)
    const out = transformString(text)
    return out === text ? body : new TextEncoder().encode(out)
  }
  if (body instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(new Uint8Array(body))
    const out = transformString(text)
    return out === text ? body : new TextEncoder().encode(out).buffer
  }
  return body
}
