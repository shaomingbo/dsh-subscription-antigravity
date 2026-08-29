/**
 * Best-effort quota usage for the signed-in Antigravity account.
 *
 * The aggregate summary endpoint is gated behind paid subscriptions and its
 * payload shape is undocumented, so every read here is defensive: the service
 * returns bounded, secret-free structures and degrades to per-model remaining
 * quota (from fetchAvailableModels) or to "unavailable" without ever throwing
 * at the RPC boundary.
 */

const BOUNDED_SUMMARY_BYTES = 4096

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Scan the available-models payload for per-model remaining-quota hints.
 * Field names are not documented; we accept the obvious numeric candidates
 * and otherwise omit the model's quota rather than guessing wrong.
 */
function perModelQuota(models) {
  const out = []
  for (const [id, info] of Object.entries(models ?? {})) {
    if (!isRecord(info)) continue
    const candidate = info.remainingFraction ?? info.remaining ?? info.quotaRemaining
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      out.push({ id, remaining: candidate })
    } else {
      out.push({ id })
    }
  }
  return out
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

export function createUsageService({ auth, client }) {
  let cache

  function clear() {
    cache = undefined
  }

  async function fetchUsage({ refresh = false, signal } = {}) {
    if (!refresh && cache !== undefined) return cache
    if (!auth.configured()) {
      cache = { provider: 'antigravity', configured: false }
      return cache
    }
    const status = auth.status()
    const result = {
      provider: 'antigravity',
      configured: true,
      email: status.email,
      ...(status.expired === true ? { expired: true } : {}),
    }
    try {
      const token = await auth.getAccessToken(signal)
      const projectId = typeof status.projectId === 'string' && status.projectId.length > 0
        ? status.projectId
        : await client.loadCodeAssist(token).catch(() => undefined)
      const summary = await client.retrieveUserQuotaSummary(token).catch(error => ({
        unavailable: error instanceof Error ? error.message.slice(0, 200) : 'unavailable',
      }))
      if (isRecord(summary) && summary.unavailable === undefined) result.summary = bound(summary)
      else if (isRecord(summary)) result.summaryUnavailable = summary.unavailable
      if (typeof projectId === 'string') {
        const models = await client.fetchAvailableModels(token, projectId).catch(() => undefined)
        if (models !== undefined) result.models = perModelQuota(models)
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message.slice(0, 200) : 'usage fetch failed'
    }
    cache = result
    return result
  }

  return { fetchUsage, clear }
}
