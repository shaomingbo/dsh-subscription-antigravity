import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageService } from '../lib/usage.js'

function fakeAuth(configured = true) {
  return {
    configured: () => configured,
    status: () => ({ provider: 'antigravity', configured, projectId: 'proj-1', email: 'me@example.com', expired: false }),
    getAccessToken: async () => 'tok',
  }
}

function fakeClient({ summary, models } = {}) {
  return {
    loadCodeAssist: async () => 'proj-upstream',
    retrieveUserQuotaSummary: async () => {
      if (summary instanceof Error) throw summary
      return summary
    },
    fetchAvailableModels: async () => models,
  }
}

test('usage for an unconfigured account is honest and secret-free', async () => {
  const usage = createUsageService({ auth: fakeAuth(false), client: fakeClient() })
  const result = await usage.fetchUsage()
  assert.deepEqual(result, { provider: 'antigravity', configured: false })
})

test('usage surfaces the quota summary and per-model remaining quota', async () => {
  const usage = createUsageService({
    auth: fakeAuth(),
    client: fakeClient({
      summary: { quotaBuckets: [{ window: 'weekly', percentLeft: 80 }] },
      models: {
        'gemini-3.1-pro-low': { quotaInfo: { remainingFraction: 0.42, resetTime: '2026-09-05T13:03:20Z' } },
        'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 1, resetTime: '2026-09-05T13:03:20Z' }, label: 'x' },
        tab_flash_lite_preview: { quotaInfo: { remainingFraction: 0.9 } },
        chat_20706: {},
      },
    }),
  })
  const result = await usage.fetchUsage()
  assert.equal(result.configured, true)
  assert.equal(result.email, 'me@example.com')
  assert.deepEqual(result.summary, { quotaBuckets: [{ window: 'weekly', percentLeft: 80 }] })
  // tab_*/chat_* placeholders are filtered; quota reads the nested quotaInfo.
  assert.deepEqual(result.models, [
    { id: 'claude-sonnet-4-6', remaining: 1, resetsAt: '2026-09-05T13:03:20Z' },
    { id: 'gemini-3.1-pro-low', remaining: 0.42, resetsAt: '2026-09-05T13:03:20Z' },
  ])
  // Cached until refreshed.
  assert.equal(await usage.fetchUsage(), result)
  const refreshed = await usage.fetchUsage({ refresh: true })
  assert.notEqual(refreshed, result)
})

test('a paid-tier gate on the summary degrades to a note, not a failure', async () => {
  const usage = createUsageService({
    auth: fakeAuth(),
    client: fakeClient({ summary: new Error('retrieveUserQuotaSummary failed (403): Permission denied'), models: {} }),
  })
  const result = await usage.fetchUsage()
  assert.match(result.summaryUnavailable, /Permission denied/)
  assert.equal(result.summary, undefined)
  assert.equal(result.error, undefined)
})

test('oversized summaries are truncated, never streamed whole to the client', async () => {
  const big = { blob: 'x'.repeat(10_000) }
  const usage = createUsageService({ auth: fakeAuth(), client: fakeClient({ summary: big, models: {} }) })
  const result = await usage.fetchUsage()
  assert.ok(JSON.stringify(result.summary).length < 5000)
  assert.ok(result.summary.truncated !== undefined)
})
