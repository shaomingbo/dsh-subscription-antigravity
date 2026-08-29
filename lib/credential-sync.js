/** Keep the credential-seam marker aligned with the active account. */

export const CREDENTIAL_REF = 'ANTIGRAVITY_ACCESS_TOKEN'

export function createCredentialSynchronizer({ auth, credentials, logger, ref = CREDENTIAL_REF }) {
  let active

  async function syncOnce(reason) {
    if (!auth.configured()) {
      await credentials.unset(ref)
      logger.info('dsh-subscription-antigravity: cleared credential %s (%s)', ref, reason)
      return
    }
    const context = await auth.getActiveContext()
    const current = await credentials.resolve(ref)
    if (current?.value !== context.token) {
      await credentials.set(ref, context.token)
      logger.info('dsh-subscription-antigravity: synchronized credential %s (%s)', ref, reason)
    }
  }

  /**
   * Coalesce concurrent callers but remember that another pass is required.
   * This matters when the active account changes while an older sync is in
   * flight: every caller shares one promise, and that promise settles only
   * after the final pass observes the latest active account.
   */
  function sync(reason) {
    const requestedAccountId = auth.activeAccountId?.()
    if (active !== undefined) {
      if (active.requestedAccountId !== requestedAccountId) {
        active.rerun = true
        active.requestedAccountId = requestedAccountId
        active.reason = reason
      }
      return active.promise
    }
    const state = { rerun: false, reason, requestedAccountId, promise: undefined }
    state.promise = (async () => {
      do {
        state.rerun = false
        await syncOnce(state.reason)
      } while (state.rerun)
    })().finally(() => {
      if (active === state) active = undefined
    })
    active = state
    return state.promise
  }

  const background = reason => sync(reason).catch(error => {
    logger.warn('dsh-subscription-antigravity: %s sync failed: %s', reason, error instanceof Error ? error.message : String(error))
  })

  return { sync, background }
}
