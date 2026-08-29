import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountRouter, isQuotaExhaustion } from '../lib/account-router.js'

function environment({ auto = false, remaining = {} } = {}) {
  let active = 'a1'
  const activations = []
  const syncs = []
  const accounts = ['a1', 'a2', 'a3'].map((accountId, index) => ({ accountId, active: index === 0, configured: true }))
  const auth = {
    activeAccountId: () => active,
    autoFailoverEnabled: () => auto,
    statuses: () => accounts.map(account => ({ ...account, active: account.accountId === active })),
    getActiveContext: async () => ({ accountId: active, token: `token-${active}`, projectId: `project-${active}` }),
    getAccountContext: async accountId => ({ accountId, token: `token-${accountId}`, projectId: `project-${accountId}` }),
    activateAccount: async accountId => {
      active = accountId
      activations.push(accountId)
    },
  }
  const usage = { remainingFor: (accountId, runtimeModel) => remaining[`${accountId}:${runtimeModel}`] }
  const router = createAccountRouter({
    auth,
    usage,
    onActivated: async (accountId, reason) => syncs.push({ accountId, reason }),
  })
  return { auth, router, activations, syncs, active: () => active }
}

const quota = { ok: false, status: 429, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }
const rateLimit = { ok: false, status: 429, text: '{"error":{"status":"RATE_LIMIT_EXCEEDED"}}' }


test('quota classification excludes ordinary rate limits and non-429 errors', () => {
  assert.equal(isQuotaExhaustion(quota), true)
  assert.equal(isQuotaExhaustion({ ...quota, status: 500 }), false)
  assert.equal(isQuotaExhaustion(rateLimit), false)
})

test('automatic failover is off by default', async () => {
  const env = environment({ auto: false })
  const calls = []
  const result = await env.router.route({
    runtimeModel: 'gemini-3.7-flash-tiered',
    attempt: async context => {
      calls.push(context.accountId)
      return quota
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(calls, ['a1'])
  assert.equal(env.active(), 'a1')
})

test('quota exhaustion rotates to a usable account and persists it only after success', async () => {
  const env = environment({ auto: true, remaining: { 'a2:gemini-3.7-flash-tiered': 0 } })
  const calls = []
  const result = await env.router.route({
    runtimeModel: 'gemini-3.7-flash-tiered',
    attempt: async context => {
      calls.push(context.accountId)
      return context.accountId === 'a3' ? { ok: true, response: 'ok' } : quota
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'a3')
  assert.equal(result.switched, true)
  assert.deepEqual(calls, ['a1', 'a3'])
  assert.deepEqual(env.activations, ['a3'])
  assert.deepEqual(env.syncs, [{ accountId: 'a3', reason: 'quota-failover' }])
  assert.deepEqual(await result.retry(), { ok: true, response: 'ok' })
})

test('rate limits and non-quota candidate failures never change the active account', async () => {
  const env = environment({ auto: true })
  const rate = await env.router.route({ runtimeModel: 'm', attempt: async () => rateLimit })
  assert.equal(rate.ok, false)
  assert.equal(env.active(), 'a1')

  const result = await env.router.route({
    runtimeModel: 'm',
    attempt: async context => context.accountId === 'a1' ? quota : { ok: false, status: 500, text: 'network edge failed' },
  })
  assert.equal(result.status, 500)
  assert.equal(env.active(), 'a1')
  assert.deepEqual(env.activations, [])
})

test('a manual switch made during failover is never overwritten by automation', async () => {
  const env = environment({ auto: true })
  let release
  let reached
  const gate = new Promise(resolve => { release = resolve })
  const candidateReached = new Promise(resolve => { reached = resolve })
  const routed = env.router.route({
    runtimeModel: 'm',
    attempt: async context => {
      if (context.accountId === 'a1') return quota
      reached()
      await gate
      return { ok: true, response: context.accountId }
    },
  })
  await candidateReached
  await env.auth.activateAccount('a3')
  release()
  const result = await routed
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'a2')
  assert.equal(result.switched, false)
  assert.equal(env.active(), 'a3')
  assert.deepEqual(env.activations, ['a3'])
})

test('concurrent quota failures serialize activation and reuse the newly active account', async () => {
  const env = environment({ auto: true })
  const calls = []
  const attempt = async context => {
    calls.push(context.accountId)
    if (context.accountId === 'a1') {
      await Promise.resolve()
      return quota
    }
    return { ok: true, response: context.accountId }
  }
  const [first, second] = await Promise.all([
    env.router.route({ runtimeModel: 'm', attempt }),
    env.router.route({ runtimeModel: 'm', attempt }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(env.active(), 'a2')
  assert.deepEqual(env.activations, ['a2'])
  assert.equal(calls.filter(id => id === 'a1').length, 2)
  assert.equal(calls.filter(id => id === 'a2').length, 2)
})
