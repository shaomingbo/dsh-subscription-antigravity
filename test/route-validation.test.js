import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { antigravityRoutePatch } from '../lib/index.js'
import { ROUTE_MODELS } from '../lib/model-catalog.js'

/**
 * The rule that killed provisioning in v0.1.0/v0.1.1, straight from
 * dsh-llm-pi-ai's resolveModelReasoning: inside reasoningEfforts, only "off"
 * may be null — any other null level throws and the whole settings update is
 * refused. Hidden levels must be omitted instead.
 */
test('every reasoningEfforts map offers only string levels and a null off', () => {
  for (const model of ROUTE_MODELS) {
    const efforts = model.reasoningEfforts
    assert.ok(efforts && typeof efforts === 'object', `${model.id} has no reasoningEfforts`)
    const keys = Object.keys(efforts)
    assert.ok(efforts.off === null, `${model.id} should hide the off level via null`)
    const offered = keys.filter((level) => level !== 'off')
    assert.ok(offered.length > 0, `${model.id} offers no thinking level beyond off`)
    for (const level of keys) {
      if (level === 'off') continue
      assert.equal(typeof efforts[level], 'string', `${model.id} reasoningEfforts.${level} must be a non-null wire value (only "off" may be null)`)
      assert.ok(efforts[level].length > 0, `${model.id} reasoningEfforts.${level} must not be empty`)
    }
  }
})

test('route models carry no unknown top-level fields beyond the schema\'s modelFields', () => {
  // dsh-llm-pi-ai modelFields: id, name, contextWindow, maxTokens, input,
  // reasoningEfforts, compat. Anything else is dead weight at best.
  const known = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])
  for (const model of ROUTE_MODELS) {
    for (const key of Object.keys(model)) {
      assert.ok(known.has(key), `${model.id} carries unknown field "${key}"`)
    }
  }
})

test('the route passes the actually installed dsh-llm-pi-ai schema', { skip: !existsSync(process.env.HOME + '/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js') ? 'installed harness llm-pi-ai not found' : false }, async () => {
  const { Config } = await import(process.env.HOME + '/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
  const patch = antigravityRoutePatch(undefined, 'http://127.0.0.1:51122/v1')
  const resolved = Config({ providers: { antigravity: patch } })
  const route = resolved.providers.antigravity
  assert.equal(route.api, 'openai-completions')
  assert.equal(route.baseURL, 'http://127.0.0.1:51122/v1')
  assert.equal(route.models.length, ROUTE_MODELS.length)
  // Config is the public schema seam; serviceability derives reasoning later.
  // At this seam we assert the corrected declaration reaches that stage intact.
  const gemini = route.models.find((model) => model.id === 'gemini-3.7-flash')
  assert.deepEqual(gemini.reasoningEfforts, {
    off: null, low: 'low', medium: 'medium', high: 'high',
  })
  assert.equal('reasoning' in gemini, false)
  const sonnet = route.models.find((model) => model.id === 'claude-sonnet-4-6')
  assert.deepEqual(sonnet.reasoningEfforts, { off: null, high: 'high' })
})
