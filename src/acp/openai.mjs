// Chat Completions <-> ACP prompt/stream translation. No vendor fingerprint
// is written; the request is turned into the same text an ACP client sends.

import { createHash } from 'node:crypto'
import { vibeGroupName } from './config.mjs'

const EMPTY_INPUT = 'Continue the task from the latest tool results above.'
const MAX_REPLAY_BYTES = 1024 * 1024

export function decodeBody(body) {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  return String(body)
}

export function parseChatBody(body) {
  const raw = typeof body === 'string' ? body : decodeBody(body)
  const parsed = JSON.parse(raw)
  return {
    model: String(parsed?.model || ''),
    messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
    tools: normalizeTools(parsed?.tools),
    stream: parsed?.stream === true,
    effort: parsed?.reasoning_effort ?? parsed?.reasoning?.effort,
    temperature: Number.isFinite(Number(parsed?.temperature)) ? Number(parsed.temperature) : undefined,
    maxTokens: Number.isFinite(Number(parsed?.max_tokens)) ? Number(parsed.max_tokens) : undefined,
  }
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const tool of tools) {
    const fn = tool?.type === 'function' ? tool.function : tool
    const name = typeof fn?.name === 'string' ? fn.name.trim() : ''
    if (!name) continue
    out.push({
      name,
      description: String(fn?.description ?? ''),
      parameters: normalizeSchema(fn?.parameters),
    })
  }
  return out
}

function normalizeSchema(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'object', properties: {} }
  }
  return {
    ...value,
    type: 'object',
    properties: value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)
      ? value.properties
      : {},
  }
}

export function textOf(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return String(part.text ?? '')
      if (part?.type === 'image' || part?.type === 'image_url') return '[image]'
      return ''
    }).join('')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

export function imageParts(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part?.type !== 'image' && part?.type !== 'image_url') continue
    const url = typeof part?.image_url === 'string' ? part.image_url : (part?.image_url?.url ?? part?.url ?? '')
    const match = /^data:([^;,]+);base64,(.+)$/is.exec(String(url))
    if (match) out.push({ type: 'image', mimeType: match[1], data: match[2] })
  }
  return out
}

export function promptImages(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (message?.role === 'user') out.push(...imageParts(message.content))
  }
  return out
}

export function splitSystem(messages) {
  const system = []
  const rest = []
  for (const message of messages) {
    if (message?.role === 'system' || message?.role === 'developer') {
      const text = textOf(message.content).trim()
      if (text) system.push(message.role === 'developer' ? `<harness_notice>\n${text}\n</harness_notice>` : text)
    } else {
      rest.push(message)
    }
  }
  return { system: system.join('\n\n'), messages: rest }
}

export function trailingSplit(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { history: [], input: [] }
  let cut = messages.length - 1
  while (cut > 0 && messages[cut]?.role === 'tool' && messages[cut - 1]?.role === 'tool') cut -= 1
  return { history: messages.slice(0, cut), input: messages.slice(cut) }
}

export function digestMessage(message) {
  return createHash('sha256').update(JSON.stringify({
    role: message?.role,
    content: message?.content,
    tool_call_id: message?.tool_call_id,
    tool_calls: message?.tool_calls,
  })).digest('hex')
}

export function historyPrefixIntact(known, messages) {
  if (!Array.isArray(known) || known.length > messages.length) return false
  for (let i = 0; i < known.length; i += 1) {
    if (digestMessage(messages[i]) !== known[i]) return false
  }
  return true
}

export function renderMessage(message) {
  if (!message) return ''
  const text = textOf(message.content)
  if (message.role === 'user') return text ? `<user>\n${text}\n</user>` : ''
  if (message.role === 'assistant') {
    const parts = []
    if (text) parts.push(`<assistant>\n${text}\n</assistant>`)
    for (const call of message.tool_calls ?? []) {
      const name = call?.function?.name ?? ''
      const args = call?.function?.arguments ?? '{}'
      parts.push(`<tool_call id="${call?.id ?? ''}" name="${name}">\n${args}\n</tool_call>`)
    }
    return parts.join('\n\n')
  }
  if (message.role === 'tool') {
    const error = message.is_error === true || message.isError === true ? ' error="true"' : ''
    return `<tool_result id="${message.tool_call_id ?? ''}"${error}>\n${text}\n</tool_result>`
  }
  if (message.role === 'developer') return text ? `<harness_notice>\n${text}\n</harness_notice>` : ''
  if (message.role === 'system') return text ? `<system_update>\n${text}\n</system_update>` : ''
  return ''
}

export function renderTranscript(messages) {
  return messages.map((message) => renderMessage(message)).filter(Boolean).join('\n\n')
}

function programmaticNames(tools) {
  const names = [...new Set(tools.map((tool) => String(tool.name)))].sort()
  const normalize = (value) => {
    let next = String(value || '').replace(/[^A-Za-z0-9_$]/g, '_') || '_'
    if (/^[0-9]/.test(next)) next = `_${next}`
    return next
  }
  const counts = new Map()
  for (const name of names) counts.set(normalize(name), (counts.get(normalize(name)) ?? 0) + 1)
  const used = new Set()
  const out = new Map()
  for (const name of names) {
    const candidate = normalize(name)
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && name === candidate && !used.has(name)) {
      out.set(name, name)
      used.add(name)
      continue
    }
    const base = counts.get(candidate) === 1 && !used.has(candidate) ? candidate : `${candidate}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
    let next = base
    let suffix = 2
    while (used.has(next)) next = `${base}_${suffix++}`
    out.set(name, next)
    used.add(next)
  }
  return out
}

export function formatToolCatalog(tools, serverName) {
  if (tools.length === 0) return ''
  const group = vibeGroupName(serverName)
  const names = programmaticNames(tools)
  const lines = [
    '<magpie_tools>',
    `Call client tools with \`run_typescript\` under \`tools.${group}.<name>(args)\`.`,
  ]
  for (const tool of tools) {
    const properties = tool.parameters?.properties && typeof tool.parameters.properties === 'object'
      ? Object.keys(tool.parameters.properties)
      : []
    const required = new Set(Array.isArray(tool.parameters?.required) ? tool.parameters.required : [])
    const params = properties.slice(0, 12).map((name) => `${name}${required.has(name) ? '*' : ''}`).join(', ')
    const description = String(tool.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    lines.push(`- tools.${group}.${names.get(tool.name) ?? tool.name}(${params})${description ? ` — ${description}` : ''}`)
  }
  lines.push('</magpie_tools>')
  return lines.join('\n')
}

export function buildReplayText({ system, tools, serverName, history, input }) {
  const context = [
    '<magpie_context>',
    'You are the model backend of a Magpie session. Magpie owns the conversation, tools, and permissions.',
    tools.length > 0
      ? `Execute client tools inside \`run_typescript\` via \`tools.${vibeGroupName(serverName)}.<name>(args)\`. Built-in local Vibe tools are denied.`
      : 'No tools are provided for this request. Answer directly without calling tools.',
    '</magpie_context>',
  ].join('\n')
  const catalog = formatToolCatalog(tools, serverName)
  const header = `${context}${catalog ? `\n\n${catalog}` : ''}${system ? `\n\n<magpie_system>\n${system}\n</magpie_system>` : ''}`
  const historyText = renderTranscript(history)
  const inputText = renderTranscript(input) || `<user>\n${EMPTY_INPUT}\n</user>`
  const combined = [
    header,
    historyText ? `<magpie_history>\n${truncateUtf8(historyText, MAX_REPLAY_BYTES)}\n</magpie_history>` : '',
    `<magpie_input>\n${inputText}\n</magpie_input>`,
  ].filter(Boolean).join('\n\n')
  return truncateUtf8(combined, MAX_REPLAY_BYTES + 64 * 1024)
}

export function toPromptBlocks(messages, { supportsImages = true, maxBytes = MAX_REPLAY_BYTES } = {}) {
  const blocks = []
  let used = 0
  for (const message of messages) {
    const rendered = renderMessage(message)
    if (rendered) {
      const text = truncateUtf8(rendered, Math.max(0, maxBytes - used))
      if (text) {
        blocks.push({ type: 'text', text })
        used += Buffer.byteLength(text, 'utf8')
      }
    }
    if (supportsImages && message?.role === 'user') {
      for (const image of imageParts(message.content)) {
        blocks.push(image)
      }
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: `<user>\n${EMPTY_INPUT}\n</user>` })
  return blocks
}

function truncateUtf8(text, maxBytes) {
  const value = String(text ?? '')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.min(value.length, Math.floor(maxBytes / 3)))
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1
  return `${value.slice(0, end)}\n\n[truncated by Magpie ACP bridge]`
}

export function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`
}

export function chunk({ id, model, delta, finishReason = null, usage }) {
  const value = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  if (usage) value.usage = usage
  return value
}

export function usageOf(acpUsage) {
  if (!acpUsage) return undefined
  const prompt = Number(acpUsage.inputTokens ?? acpUsage.promptTokens ?? 0) || 0
  const completion = Number(acpUsage.outputTokens ?? acpUsage.completionTokens ?? 0) || 0
  const cached = Number(acpUsage.cachedReadTokens ?? acpUsage.cachedTokens ?? 0) || 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: Math.min(cached, prompt) } } : {}),
  }
}

export function completion({ id, model, text, reasoning, toolCalls, finishReason, usage }) {
  const message = { role: 'assistant', content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson },
    }))
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}
