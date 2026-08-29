/**
 * Keep the ANTIGRAVITY_ACCESS_TOKEN credential-seam entry fresh.
 *
 * The seam value is only a presence marker for pi-ai route resolution and a
 * debugging convenience: the loopback proxy authenticates upstream with its
 * own runtime token, never with the seam value. Mirrors the dsh-subscription-search
 * synchronizer shape: per-provider in-flight de-duplication, best-effort
 * background syncs.
 */

export const CREDENTIAL_REF = 'ANTIGRAVITY_ACCESS_TOKEN'

export function createCredentialSynchronizer({ auth, credentials, logger, ref = CREDENTIAL_REF }) {
  const inFlight = new Map()

  const sync = (reason) => {
    const active = inFlight.get(ref)
    if (active !== undefined) return active

    const operation = Promise.resolve().then(async () => {
      if (!auth.configured()) return
      const token = await auth.getAccessToken()
      if (token === undefined || token.length === 0) return
      const current = await credentials.resolve(ref)
      if (current?.value !== token) {
        await credentials.set(ref, token)
        logger.info('dsh-subscription-antigravity: synchronized credential %s (%s)', ref, reason)
      }
    })
    const tracked = operation.finally(() => {
      if (inFlight.get(ref) === tracked) inFlight.delete(ref)
    })
    inFlight.set(ref, tracked)
    return tracked
  }

  const background = (reason) => sync(reason).catch(error => {
    logger.warn('dsh-subscription-antigravity: %s sync failed: %s', reason, error instanceof Error ? error.message : String(error))
  })

  return { sync, background }
}
