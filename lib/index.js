/**
 * Host half of dsh-subscription-antigravity: Google PKCE login for the
 * Antigravity subscription, a loopback OpenAI-compatible proxy to Cloud Code
 * Assist, provisioning of the `antigravity` pi-ai model route through the
 * settings service (per-provider merge, never a whole-config replacement),
 * credential-seam sync, and the loopback-only RPC channel the settings page
 * consumes. Follows the structure of dsh-subscription-search/lib/index.js.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { AuthStore, PROVIDER_ID } from './auth-store.js'
import { AntigravityAuth } from './oauth.js'
import { createAntigravityClient } from './antigravity-api.js'
import { createCredentialSynchronizer, CREDENTIAL_REF } from './credential-sync.js'
import { createProxy } from './proxy.js'
import { ROUTE_MODELS } from './model-catalog.js'
import { createUsageService } from './usage.js'

export const CHANNEL = '/subscription-antigravity'
export const ROUTE_ID = PROVIDER_ID
const DEFAULT_PROXY_PORT = 51122

const ENVELOPE_CODES = new Set(['cancelled', 'internal'])
const CANCELLED_CODES = new Set(['ANTIGRAVITY_LOGIN_ABORTED'])
/**
 * "The stored credential is unusable" carries a credential-rejected ref so the
 * harness UI offers re-login; only when a genuine details.ref rode along.
 */
const CREDENTIAL_CODES = new Set(['ANTIGRAVITY_AUTH_EXPIRED', 'ANTIGRAVITY_AUTH_NOT_CONFIGURED'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fold any internal error code into a schema-legal RPC outcome. */
export function envelopeOutcome(code, details) {
  if (typeof code === 'string') {
    if (ENVELOPE_CODES.has(code)) return { code, details: {} }
    if (CREDENTIAL_CODES.has(code) && isRecord(details) && typeof details.ref === 'string') {
      return { code: 'credential-rejected', details: { ref: details.ref } }
    }
    if (CANCELLED_CODES.has(code)) return { code: 'cancelled', details: {} }
  }
  return { code: 'internal', details: {} }
}

function failure(message, code = 'internal', details) {
  const safe = envelopeOutcome(code, details)
  const tag = typeof code === 'string' && code !== safe.code ? `[${code}] ` : ''
  return { ok: false, error: { code: safe.code, message: `${tag}${message}`, details: safe.details } }
}

function success(value) {
  return { ok: true, value }
}

function requireObject(payload) {
  if (!isRecord(payload)) throw new Error('request payload must be an object')
  return payload
}

/**
 * The pi-ai route this plugin provisions. Only identity + connectivity fields
 * are ever written; a user-customized `models` list is preserved, and a route
 * the user fully owns stays untouched except for repairing the seam reference
 * and proxy URL this plugin owns.
 */
export function antigravityRoutePatch(existing, proxyUrl) {
  const models = Array.isArray(existing?.models) && existing.models.length > 0 ? existing.models : structuredClone(ROUTE_MODELS)
  return {
    ...(typeof existing?.displayName === 'string' && existing.displayName.length > 0 ? { displayName: existing.displayName } : { displayName: 'Antigravity (Google AI subscription)' }),
    apiKeyEnv: CREDENTIAL_REF,
    api: 'openai-completions',
    baseURL: proxyUrl,
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models,
  }
}

export function routeNeedsProvisioning(existing, proxyUrl) {
  return !(existing?.apiKeyEnv === CREDENTIAL_REF
    && existing?.baseURL === proxyUrl
    && existing?.api === 'openai-completions'
    && Array.isArray(existing?.models)
    && existing.models.length > 0)
}

async function ensureAntigravityRoute(settings, proxyUrl, logger) {
  const existing = settings.get('llm-pi-ai')?.providers?.[ROUTE_ID]
  if (!routeNeedsProvisioning(existing, proxyUrl)) return
  await settings.update('llm-pi-ai', {
    providers: {
      [ROUTE_ID]: antigravityRoutePatch(existing, proxyUrl),
    },
  })
  logger.info('dsh-subscription-antigravity: provisioned the antigravity model route at %s', proxyUrl)
}

export const name = 'dsh-subscription-antigravity'
export const inject = ['connection', 'credentials', 'settings', 'timer']

export function apply(ctx) {
  const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
  const filename = join(home, '.antigravity-auth.json')
  const configuredPort = Number.parseInt(process.env.DSH_ANTIGRAVITY_PROXY_PORT ?? '', 10)

  const client = createAntigravityClient({})
  const store = new AuthStore({
    filename,
    onError: error => ctx.logger.warn('dsh-subscription-antigravity: %s', error instanceof Error ? error.message : String(error)),
  })
  const auth = new AntigravityAuth({
    store,
    logger: ctx.logger,
    discoverProject: token => client.loadCodeAssist(token),
  })
  const synchronizer = createCredentialSynchronizer({ auth, credentials: ctx.credentials, logger: ctx.logger })
  const usage = createUsageService({ auth, client })
  const proxy = createProxy({
    auth,
    client,
    logger: ctx.logger,
    port: Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_PROXY_PORT,
  })

  let activeProxy = proxy
  let proxyUrl = `http://127.0.0.1:${Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_PROXY_PORT}/v1`

  void auth.init()

  // Start the loopback proxy, then provision/repair the model route. A busy
  // preferred port degrades to an ephemeral one; the route repair at the next
  // boot keeps baseURL honest either way.
  void Promise.resolve().then(async () => {
    try {
      await proxy.start()
      proxyUrl = proxy.url
    } catch (error) {
      ctx.logger.warn('dsh-subscription-antigravity: proxy start failed on port %d (%s); retrying on an ephemeral port',
        proxy.port, error instanceof Error ? error.message : String(error))
      const fallback = createProxy({ auth, client, logger: ctx.logger, port: 0 })
      try {
        await fallback.start()
        activeProxy = fallback
        proxyUrl = activeProxy.url
      } catch (fallbackError) {
        ctx.logger.warn('dsh-subscription-antigravity: proxy start failed entirely: %s',
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
        return
      }
    }
    try {
      await ensureAntigravityRoute(ctx.settings, proxyUrl, ctx.logger)
    } catch (error) {
      ctx.logger.warn('dsh-subscription-antigravity: route provisioning failed: %s', error instanceof Error ? error.message : String(error))
    }
  })

  // Keep the model credential fresh before any antigravity stream.
  ctx.on('llm/stream', (options, next) => {
    if (options?.provider !== ROUTE_ID) return next()
    return (async function* () {
      await synchronizer.sync('request')
      yield* next()
    })()
  })

  // Periodic background refresh of the subscription credential.
  ctx.interval(() => {
    synchronizer.background('timer')
  }, 10 * 60 * 1000)

  // Loopback-only RPC channel consumed by the settings section.
  ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'providers') return success({ providers: [auth.status()] })
      if (endpoint === 'start-login') {
        requireObject(payload)
        return success(await auth.startLogin(signal))
      }
      if (endpoint === 'paste-callback') {
        const { loginId, url } = requireObject(payload)
        if (typeof loginId !== 'string' || typeof url !== 'string') {
          throw new Error('paste-callback requires loginId and url strings')
        }
        await auth.completeWithPaste(loginId, url)
        return success({})
      }
      if (endpoint === 'login-status') {
        const { loginId } = requireObject(payload)
        return success({ status: auth.loginStatus(loginId) })
      }
      if (endpoint === 'cancel-login') {
        const { loginId } = requireObject(payload)
        await auth.cancelLogin(loginId)
        return success({})
      }
      if (endpoint === 'logout') {
        requireObject(payload)
        await auth.logout()
        usage.clear()
        synchronizer.background('logout').catch(() => {})
        return success({})
      }
      if (endpoint === 'usage') {
        const payloadObject = requireObject(payload)
        return success({ usage: await usage.fetchUsage({ refresh: payloadObject.refresh === true, signal }) })
      }
      if (endpoint === 'models') {
        return success({
          models: ROUTE_MODELS.map(model => ({
            id: model.id,
            name: model.name,
            input: model.input,
            reasoning: model.reasoning === true,
            reasoningEfforts: model.reasoningEfforts,
          })),
        })
      }
      if (endpoint === 'diagnostics') {
        const status = auth.status()
        return success({
          provider: ROUTE_ID,
          configured: status.configured === true,
          proxyUrl,
          routeConfigured: ctx.settings.get('llm-pi-ai')?.providers?.[ROUTE_ID] !== undefined,
        })
      }
      return failure(`unknown subscription-antigravity endpoint: ${endpoint}`)
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : 'subscription-antigravity request failed',
        error?.code,
        error?.details,
      )
    }
  }, { authority: 'loopback' })

  ctx.on('dispose', () => {
    usage.clear()
    void activeProxy.stop()
    void auth.dispose()
  })
}
