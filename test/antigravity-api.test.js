import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAntigravityClient,
  DEFAULT_ENDPOINT,
  DEFAULT_GENERATION_ENDPOINT,
} from '../lib/antigravity-api.js'

test('consumer generation uses daily while control-plane discovery still starts at prod', async () => {
  const previous = process.env.DSH_ANTIGRAVITY_BASE_URL
  delete process.env.DSH_ANTIGRAVITY_BASE_URL
  const calls = []
  try {
    const client = createAntigravityClient({
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options })
        return new Response('data: {"response":{}}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    })
    assert.equal(client.endpointCandidates()[0], DEFAULT_ENDPOINT)
    assert.deepEqual(client.generationEndpointCandidates(), [DEFAULT_GENERATION_ENDPOINT])
    const result = await client.generate({ token: 'token', body: { requestType: 'agent' } })
    assert.equal(result.ok, true)
    assert.equal(result.endpoint, DEFAULT_GENERATION_ENDPOINT)
    assert.equal(calls[0].url, `${DEFAULT_GENERATION_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`)
  } finally {
    if (previous === undefined) delete process.env.DSH_ANTIGRAVITY_BASE_URL
    else process.env.DSH_ANTIGRAVITY_BASE_URL = previous
  }
})

test('an explicit base URL pins generation for gateway and test setups', async () => {
  let seen
  const client = createAntigravityClient({
    baseUrl: 'https://gateway.example',
    fetchImpl: async url => {
      seen = String(url)
      return new Response('{}', { status: 200 })
    },
  })
  const result = await client.generate({ token: 'token', body: {} })
  assert.equal(result.ok, true)
  assert.equal(seen, 'https://gateway.example/v1internal:streamGenerateContent?alt=sse')
})
