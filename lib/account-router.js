/**
 * Route one generation request through a stable account context, with optional
 * quota-only failover. The proxy knows nothing about account ordering, locks,
 * activation, or quota classification; callers provide one attempt function.
 */

export function isQuotaExhaustion(outcome) {
  if (outcome?.status !== 429) return false
  const text = String(outcome?.text ?? '').toUpperCase()
  if (text.includes('RATE_LIMIT_EXCEEDED')) return false
  return text.includes('QUOTA_EXHAUSTED')
    || text.includes('RESOURCE_EXHAUSTED')
    || text.includes('RESOURCE HAS BEEN EXHAUSTED')
}

function rotateAfter(accounts, accountId) {
  if (accounts.length === 0) return []
  const index = accounts.findIndex(account => account.accountId === accountId)
  if (index < 0) return accounts
  return [...accounts.slice(index + 1), ...accounts.slice(0, index)]
}

function createLock() {
  let tail = Promise.resolve()
  return async function locked(operation) {
    let release
    const turn = new Promise(resolve => { release = resolve })
    const previous = tail
    tail = turn
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export function createAccountRouter({ auth, usage, onActivated = async () => {}, logger = { warn: () => {} } }) {
  const locked = createLock()

  async function contextFor(accountId, signal) {
    try {
      return await auth.getAccountContext(accountId, signal)
    } catch (error) {
      logger.warn('dsh-subscription-antigravity: skipped account %s during failover: %s',
        accountId, error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  async function route({ runtimeModel, signal, attempt }) {
    const finish = (outcome, context, switched) => ({
      ...outcome,
      accountId: context.accountId,
      switched,
      retry: () => attempt(context),
    })
    const initial = await auth.getActiveContext(signal)
    const first = await attempt(initial)
    if (first.ok || !auth.autoFailoverEnabled() || !isQuotaExhaustion(first)) {
      return finish(first, initial, false)
    }

    return locked(async () => {
      if (!auth.autoFailoverEnabled()) return finish(first, initial, false)

      // Another request or a manual action may have switched while this request
      // waited for the failover lock. Try that active account before walking the
      // remainder of the pool.
      const currentId = auth.activeAccountId()
      const tried = new Set([initial.accountId])
      if (typeof currentId === 'string' && currentId !== initial.accountId) {
        const current = await contextFor(currentId, signal)
        if (current !== undefined) {
          tried.add(current.accountId)
          const outcome = await attempt(current)
          if (outcome.ok || !isQuotaExhaustion(outcome)) {
            return finish(outcome, current, outcome.ok)
          }
        }
      }

      const accounts = rotateAfter(auth.statuses(), initial.accountId)
      for (const account of accounts) {
        if (tried.has(account.accountId)) continue
        const remaining = usage.remainingFor(account.accountId, runtimeModel)
        if (typeof remaining === 'number' && remaining <= 0) continue
        tried.add(account.accountId)
        const context = await contextFor(account.accountId, signal)
        if (context === undefined) continue
        const outcome = await attempt(context)
        if (!outcome.ok) {
          if (isQuotaExhaustion(outcome)) continue
          return finish(outcome, context, false)
        }
        // A manual switch made while this candidate was running wins over the
        // automatic policy. The current request can still use the successful
        // candidate response without overwriting the user's newer selection.
        if (auth.activeAccountId() !== currentId) return finish(outcome, context, false)
        try {
          await auth.activateAccount(context.accountId)
        } catch (error) {
          logger.warn('dsh-subscription-antigravity: post-failover activation failed: %s',
            error instanceof Error ? error.message : String(error))
          return finish(outcome, context, false)
        }
        try {
          await onActivated(context.accountId, 'quota-failover')
        } catch (error) {
          logger.warn('dsh-subscription-antigravity: post-failover credential sync failed: %s',
            error instanceof Error ? error.message : String(error))
        }
        return finish(outcome, context, true)
      }
      return finish(first, initial, false)
    })
  }

  return { route }
}
