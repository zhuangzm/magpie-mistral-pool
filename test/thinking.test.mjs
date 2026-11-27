import test from 'node:test'
import assert from 'node:assert/strict'

import { asMistralMessage, mistralBody, thinkingText } from '../src/thinking.mjs'

test('reasoning_content becomes the typed thinking part ahead of the text', () => {
  const body = JSON.stringify({
    model: 'deepseek-v4-1-flash-1017',
    messages: [
      { role: 'user', content: 'Is 91 prime?' },
      { role: 'assistant', content: '91 = 7 x 13.', reasoning_content: '7*13=91.' },
      { role: 'user', content: 'And 97?' },
    ],
  })
  const out = JSON.parse(mistralBody(body))
  assert.deepEqual(out.messages[0], { role: 'user', content: 'Is 91 prime?' })
  assert.deepEqual(out.messages[2], { role: 'user', content: 'And 97?' })
  assert.deepEqual(out.messages[1], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: [{ type: 'text', text: '7*13=91.' }] },
      { type: 'text', text: '91 = 7 x 13.' },
    ],
  })
  assert.equal(out.messages[1].reasoning_content, undefined)
})

test('reasoning_details are merged and reasoning is accepted', () => {
  const body = JSON.stringify({
    model: 'm',
    messages: [
      { role: 'assistant', content: 'ok', reasoning_details: [{ type: 'reasoning.text', text: 'a' }, { summary: 'b' }] },
      { role: 'assistant', content: 'ok', reasoning: 'r' },
    ],
  })
  const out = JSON.parse(mistralBody(body))
  assert.deepEqual(out.messages[0].content, [
    { type: 'thinking', thinking: [{ type: 'text', text: 'ab' }] },
    { type: 'text', text: 'ok' },
  ])
  assert.deepEqual(out.messages[1].content, [
    { type: 'thinking', thinking: [{ type: 'text', text: 'r' }] },
    { type: 'text', text: 'ok' },
  ])
  assert.equal(thinkingText({ reasoning_details: [{ text: 'a' }, { summary: 'b' }] }), 'ab')
})

test('a tool-call turn keeps its calls and gets the thinking part alone', () => {
  const calls = [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }]
  const body = JSON.stringify({
    model: 'm',
    messages: [
      { role: 'assistant', content: null, tool_calls: calls, reasoning_content: 'Let me read it.' },
    ],
  })
  const out = JSON.parse(mistralBody(body))
  assert.deepEqual(out.messages[0], {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Let me read it.' }] }],
    tool_calls: calls,
  })
})

test('a prefix turn only loses the field, never gains a thinking part', () => {
  const body = JSON.stringify({
    model: 'm',
    messages: [{ role: 'assistant', content: 'The answer is', prefix: true, reasoning_content: 'think' }],
  })
  assert.deepEqual(JSON.parse(mistralBody(body)).messages[0], {
    role: 'assistant',
    content: 'The answer is',
    prefix: true,
  })
  const message = { role: 'assistant', content: 'x', prefix: true, reasoning_content: 'think' }
  assert.equal(asMistralMessage(message), true)
  assert.equal(message.content, 'x')
})

test('a non-assistant message drops the field and keeps its content', () => {
  const body = JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: 'hi', reasoning: 'not a turn' }],
  })
  assert.deepEqual(JSON.parse(mistralBody(body)).messages[0], { role: 'user', content: 'hi' })
})

test('a body with nothing to move comes back byte for byte', () => {
  const plain = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(mistralBody(plain), plain)
  const embeddings = JSON.stringify({ model: 'm', input: ['reasoning'] })
  assert.equal(mistralBody(embeddings), embeddings)
  assert.equal(mistralBody('not json at all, reasoning'), 'not json at all, reasoning')
  assert.equal(mistralBody(undefined), undefined)
  const bytes = new TextEncoder().encode(plain)
  assert.equal(mistralBody(bytes), bytes)
  const buffer = new TextEncoder().encode(plain).buffer
  assert.equal(mistralBody(buffer), buffer)
})

test('a Uint8Array body is transformed and re-encoded', () => {
  const body = new TextEncoder().encode(JSON.stringify({
    model: 'm',
    messages: [{ role: 'assistant', content: 'hi', reasoning_content: 'why' }],
  }))
  const out = mistralBody(body)
  assert.ok(out instanceof Uint8Array)
  assert.notEqual(out, body)
  const parsed = JSON.parse(new TextDecoder().decode(out))
  assert.deepEqual(parsed.messages[0].content[0], { type: 'thinking', thinking: [{ type: 'text', text: 'why' }] })
})
