import test from 'node:test'
import assert from 'node:assert/strict'
import { ROUTE_ID, antigravityRoutePatch, envelopeOutcome, routeNeedsProvisioning } from '../lib/index.js'
import { ROUTE_MODELS } from '../lib/model-catalog.js'

test('antigravityRoutePatch provisions identity fields and the default model catalog', () => {
  const patch = antigravityRoutePatch(undefined, 'http://127.0.0.1:51122/v1')
  assert.equal(patch.displayName, 'Antigravity (Google AI subscription)')
  assert.equal(patch.apiKeyEnv, 'ANTIGRAVITY_ACCESS_TOKEN')
  assert.equal(patch.api, 'openai-completions')
  assert.equal(patch.baseURL, 'http://127.0.0.1:51122/v1')
  assert.deepEqual(patch.compat, { supportsDeveloperRole: false, maxTokensField: 'max_tokens' })
  assert.equal(patch.models.length, ROUTE_MODELS.length)
  // structuredClone guard: mutating the patch must not touch the shared catalog
  patch.models.pop()
  assert.equal(ROUTE_MODELS.length, 7)
})

test('a user-customized models list and display name survive route provisioning', () => {
  const existing = {
    displayName: 'My Antigravity',
    models: [{ id: 'gemini-3.1-pro' }],
  }
  const patch = antigravityRoutePatch(existing, 'http://127.0.0.1:51122/v1')
  assert.equal(patch.displayName, 'My Antigravity')
  assert.deepEqual(patch.models, [{ id: 'gemini-3.1-pro' }])
})

test('routeNeedsProvisioning is exact about what it repairs', () => {
  const good = {
    apiKeyEnv: 'ANTIGRAVITY_ACCESS_TOKEN',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:51122/v1',
    models: [{ id: 'gemini-3.1-pro' }],
  }
  assert.equal(routeNeedsProvisioning(good, 'http://127.0.0.1:51122/v1'), false)
  assert.equal(routeNeedsProvisioning(good, 'http://127.0.0.1:59999/v1'), true, 'stale proxy URL must be repaired')
  assert.equal(routeNeedsProvisioning({ ...good, apiKeyEnv: 'OTHER' }, 'http://127.0.0.1:51122/v1'), true)
  assert.equal(routeNeedsProvisioning({ ...good, api: 'openai-responses' }, 'http://127.0.0.1:51122/v1'), true)
  assert.equal(routeNeedsProvisioning({ ...good, models: [] }, 'http://127.0.0.1:51122/v1'), true)
  assert.equal(routeNeedsProvisioning(undefined, 'http://127.0.0.1:51122/v1'), true)
})

test('private error codes fold into schema-legal RPC envelopes', () => {
  assert.deepEqual(envelopeOutcome('ANTIGRAVITY_LOGIN_ABORTED'), { code: 'cancelled', details: {} })
  assert.deepEqual(
    envelopeOutcome('ANTIGRAVITY_AUTH_EXPIRED', { ref: 'ANTIGRAVITY_ACCESS_TOKEN' }),
    { code: 'credential-rejected', details: { ref: 'ANTIGRAVITY_ACCESS_TOKEN' } },
  )
  assert.deepEqual(envelopeOutcome('ANTIGRAVITY_AUTH_EXPIRED'), { code: 'internal', details: {} },
    'a credential-rejected fold requires a genuine ref')
  assert.deepEqual(envelopeOutcome('SOMETHING_ELSE'), { code: 'internal', details: {} })
  assert.deepEqual(envelopeOutcome('cancelled'), { code: 'cancelled', details: {} })
  assert.equal(ROUTE_ID, 'antigravity')
})
