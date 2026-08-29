/**
 * Best-effort quota usage, isolated per saved Antigravity account.
 *
 * The aggregate summary endpoint is gated for many consumer subscriptions, so
 * per-runtime quota from fetchAvailableModels remains the dependable display.
 * Cache and failures are account-scoped: one unavailable account never hides
 * the others.
 */

const BOUNDED_SUMMARY_BYTES = 4096
const USABLE_RUNTIME = /^(gemini-|claude-|gpt-oss-)/i

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function perModelQuota(models) {
  const out = []
  for (const [id, info] of Object.entries(models ?? {})) {
    if (!USABLE_RUNTIME.test(id) || !isRecord(info)) continue
    const quota = isRecord(info.quotaInfo) ? info.quotaInfo : info
    const entry = { id }
    const remaining = quota.remainingFraction ?? quota.remaining ?? quota.quotaRemaining
    if (typeof remaining === 'number' && Number.isFinite(remaining)) entry.remaining = remaining
    if (typeof quota.resetTime === 'string' && quota.resetTime.length > 0) entry.resetsAt = quota.resetTime
    out.push(entry)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function bound(value, limit = BOUNDED_SUMMARY_BYTES) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return undefined
  }
  if (text === undefined || text.length <= limit) return value
  return { truncated: `${text.slice(0, limit - 1)}…` }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export function createUsageService({ auth, client }) {
  const cache = new Map()

  function clear(accountId) {
    if (accountId === undefined) cache.clear()
    else cache.delete(accountId)
  }

  async function fetchUsage({ accountId = auth.activeAccountId?.(), refresh = false, signal } = {}) {
    if (typeof accountId !== 'string') return { provider: 'antigravity', configured: false }
    if (!refresh && cache.has(accountId)) return cache.get(accountId)
    const status = auth.status(accountId)
    if (status.configured !== true) {
      const missing = { provider: 'antigravity', configured: false, accountId }
      cache.set(accountId, missing)
      return missing
    }
    const result = {
      provider: 'antigravity',
      configured: true,
      accountId,
      email: status.email,
      ...(status.expired === true ? { expired: true } : {}),
    }
    try {
      const context = await auth.getAccountContext(accountId, signal)
      const projectId = typeof context.projectId === 'string' && context.projectId.length > 0
        ? context.projectId
        : await client.loadCodeAssist(context.token).catch(() => undefined)
      const summary = await client.retrieveUserQuotaSummary(context.token).catch(error => ({
        unavailable: error instanceof Error ? error.message.slice(0, 200) : 'unavailable',
      }))
      if (isRecord(summary) && summary.unavailable === undefined) result.summary = bound(summary)
      else if (isRecord(summary)) result.summaryUnavailable = summary.unavailable
      if (typeof projectId === 'string') {
        const models = await client.fetchAvailableModels(context.token, projectId).catch(() => undefined)
        if (models !== undefined) result.models = perModelQuota(models)
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message.slice(0, 200) : 'usage fetch failed'
    }
    cache.set(accountId, result)
    return result
  }

  async function fetchAllUsage({ refresh = false, signal, concurrency = 2 } = {}) {
    const accounts = auth.statuses()
    return mapLimit(accounts, Math.max(1, concurrency), account => fetchUsage({
      accountId: account.accountId,
      refresh,
      signal,
    }))
  }

  function remainingFor(accountId, runtimeModel) {
    const usage = cache.get(accountId)
    const model = usage?.models?.find(entry => entry.id === runtimeModel)
    return typeof model?.remaining === 'number' ? model.remaining : undefined
  }

  return { fetchUsage, fetchAllUsage, remainingFor, clear }
}
