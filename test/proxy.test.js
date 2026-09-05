import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxy, findDynamicRuntimeModel } from '../lib/proxy.js'

function fakeAuth({ projectId = 'proj-1', expiredToken = false } = {}) {
  return {
    configured: () => true,
    status: () => ({ provider: 'antigravity', configured: true, projectId, email: 'me@example.com', expired: expiredToken }),
    getAccessToken: async () => 'access-token',
    rememberProjectId: async () => {},
  }
}

function sseResponse(frames) {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, { status: 200 })
}

const TEXT_CHUNK = { response: { candidates: [{ content: { parts: [{ text: 'hello' }] } }], finishReason: 'STOP' } }
const EMPTY_DONE = []

function fakeClient(responses) {
  let call = 0
  const generateCalls = []
  return {
    generateCalls,
    generate: async ({ body, token }) => {
      generateCalls.push({ body, token })
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      if (response instanceof Response) return { ok: true, status: 200, response }
      return { ok: false, status: response.status, text: response.text }
    },
    loadCodeAssist: async () => 'proj-upstream',
    fetchAvailableModels: async () => ({ 'gemini-3.1-pro-low': { label: 'Gemini 3.1 Pro (Low)' } }),
    retrieveUserQuotaSummary: async () => ({}),
  }
}

async function startProxy(client, options = {}) {
  const proxy = createProxy({
    auth: fakeAuth(options.auth),
    client,
    port: 0,
    emptyRetryDelays: [1, 1],
    ...options,
  })
  await proxy.start()
  return { proxy, url: proxy.url, stop: () => proxy.stop() }
}

test('GET /v1/models lists the static catalog', async () => {
  const env = await startProxy(fakeClient([]))
  try {
    const response = await fetch(`${env.url}/models`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 8)
    assert.ok(body.data.some(model => model.id === 'gemini-3.7-flash'))
    assert.ok(body.data.some(model => model.id === 'gemini-3.8-flash'))
    assert.ok(body.data.every(model => model.owned_by === 'antigravity'))
  } finally {
    await env.stop()
  }
})

test('streaming chat completions translate Cloud Code Assist SSE into OpenAI deltas', async () => {
  const client = fakeClient([sseResponse([TEXT_CHUNK])])
  const env = await startProxy(client)
  try {
    const response = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(text.endsWith('data: [DONE]\n\n'))
    const frames = text.split('\n\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)))
    assert.deepEqual(frames[0].choices[0].delta, { role: 'assistant', content: '' })
    assert.deepEqual(frames.at(-1).choices[0].delta, {})
    assert.equal(frames.at(-1).choices[0].finish_reason, 'stop')
    // The upstream envelope carries the runtime id, project, and agent request type.
    const upstream = client.generateCalls[0].body
    assert.equal(upstream.model, 'gemini-3.1-pro-low')
    assert.equal(upstream.project, 'proj-1')
    assert.equal(upstream.requestType, 'agent')
    assert.equal(client.generateCalls[0].token, 'access-token')
  } finally {
    await env.stop()
  }
})

test('non-streaming requests assemble a full completion', async () => {
  const upstream = sseResponse([{
    response: {
      candidates: [{ content: { parts: [{ text: 'answer text' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    },
  }])
  const env = await startProxy(fakeClient([upstream]))
  try {
    const response = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, 'answer text')
    assert.deepEqual(body.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 })
  } finally {
    await env.stop()
  }
})

test('upstream 429 maps to HTTP 429 with an actionable message', async () => {
  const env = await startProxy(fakeClient([{ status: 429, text: '{"error":{"message":"Individual quota reached"}}' }]))
  try {
    const response = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 429)
    const body = await response.json()
    assert.match(body.error.message, /[Qq]uota/)
  } finally {
    await env.stop()
  }
})

test('a 404 walks the fallback runtime, then the dynamic catalog, before failing', async () => {
  let generateCount = 0
  const client = fakeClient([
    sseResponse([TEXT_CHUNK]), // primary runtime (set below to 404 first)
  ])
  const failing = {
    ...client,
    generate: async ({ body }) => {
      generateCount += 1
      client.generateCalls.push({ body })
      if (generateCount === 1) return { ok: false, status: 404, text: 'Requested entity was not found' }
      return { ok: true, status: 200, response: sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'fallback ok' }] }, finishReason: 'STOP' }] } }]) }
    },
    fetchAvailableModels: async () => ({ 'gemini-3.1-pro-low': {} }),
  }
  const env = await startProxy(failing)
  try {
    const response = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /fallback ok/)
    const models = [failing.generateCalls[0].body.model, failing.generateCalls.at(-1).body.model]
    assert.equal(models[0], 'gemini-3.7-flash-tiered')
    assert.notEqual(models[1], 'gemini-3.7-flash-tiered')
  } finally {
    await env.stop()
  }
})

test('an unrolled gemini-3.8-flash account falls back to the tiered 3.7 runtime', async () => {
  let generateCount = 0
  const client = fakeClient([])
  const failing = {
    ...client,
    generate: async ({ body }) => {
      generateCount += 1
      client.generateCalls.push({ body })
      if (generateCount === 1) return { ok: false, status: 404, text: 'Requested entity was not found' }
      return { ok: true, status: 200, response: sseResponse([{ response: { candidates: [{ content: { parts: [{ text: '3.7 fallback ok' }] }, finishReason: 'STOP' }] } }]) }
    },
    fetchAvailableModels: async () => ({}),
  }
  const env = await startProxy(failing)
  try {
    const response = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /3\.7 fallback ok/)
    const models = failing.generateCalls.map(call => call.body.model)
    assert.deepEqual(models, ['gemini-3.8-flash-low', 'gemini-3.7-flash-tiered'])
    assert.equal(failing.generateCalls[1].body.request.generationConfig.thinkingConfig.thinkingLevel, 'LOW')
  } finally {
    await env.stop()
  }
})

test('an empty upstream stream is retried, then succeeds', async () => {
  let generateCount = 0
  const client = fakeClient([])
  client.generate = async () => {
    generateCount += 1
    if (generateCount === 1) return { ok: true, status: 200, response: sseResponse(EMPTY_DONE) }
    return { ok: true, status: 200, response: sseResponse([TEXT_CHUNK]) }
  }
  const env = await startProxy(client)
  try {
    const response = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /hello/)
    assert.equal(generateCount, 2)
  } finally {
    await env.stop()
  }
})

test('unknown models and malformed bodies are rejected before any upstream call', async () => {
  const client = fakeClient([])
  const env = await startProxy(client)
  try {
    const unknown = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(unknown.status, 400)
    const malformed = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.equal(malformed.status, 400)
    const noMessages = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-pro', messages: [] }),
    })
    assert.equal(noMessages.status, 400)
    assert.equal(client.generateCalls.length, 0)
  } finally {
    await env.stop()
  }
})

test('an unconfigured account surfaces a credential-style 401', async () => {
  const auth = {
    ...fakeAuth(),
    configured: () => false,
    getAccessToken: async () => {
      const error = new Error('No Antigravity credentials; sign in under Settings → Antigravity')
      error.code = 'ANTIGRAVITY_AUTH_NOT_CONFIGURED'
      throw error
    },
  }
  const env = await startProxy(fakeClient([]), { auth })
  try {
    const response = await fetch(`${env.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 401)
    assert.match((await response.json()).error.message, /sign in/i)
  } finally {
    await env.stop()
  }
})

test('findDynamicRuntimeModel matches exact keys and labels, never placeholder enums', () => {
  const models = {
    'gemini-3.1-pro-low': { label: 'Gemini 3.1 Pro (Low)' },
    'MODEL_PLACEHOLDER_X': { label: 'Gemini 3.1 Pro (Low)' },
  }
  assert.equal(findDynamicRuntimeModel(models, 'gemini-3.1-pro-low'), 'gemini-3.1-pro-low')
  assert.equal(findDynamicRuntimeModel(models, 'gemini-3.1-pro'), 'gemini-3.1-pro-low')
  assert.equal(findDynamicRuntimeModel(models, 'claude-opus-4-6'), undefined)
  assert.equal(findDynamicRuntimeModel(undefined, 'x'), undefined)
})
