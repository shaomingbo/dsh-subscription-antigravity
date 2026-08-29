/**
 * Cloud Code Assist client: project-id discovery, available-model lookup,
 * SSE generation, and quota retrieval against the Google Antigravity backend.
 *
 * Endpoint, header, envelope, and fallback behavior mirror the pi-antigravity
 * reference implementation (github.com/Rahularya01/pi-antigravity,
 * src/client/client.ts + src/stream/stream.ts + src/usage/usage.ts). These are
 * internal, undocumented Google endpoints and can change without notice; all
 * protocol constants live here (see SPEC.md) so updates stay one-file small.
 */

import { createHash } from 'node:crypto'

export const DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
/** Consumer subscription generation runs on daily; prod reports false quota exhaustion. */
export const DEFAULT_GENERATION_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'
export const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  DEFAULT_GENERATION_ENDPOINT,
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
]

const DISCOVERY_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 30 * 60 * 1000

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

/** UUID-shaped stable id from a seed (account email preferred over anything cwd-derived). */
export function stableProjectId(seed) {
  const bytes = createHash('sha1').update(`antigravity:${seed}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Fallback project id: explicit env override, then a stable seed, never random per-boot. */
export function defaultProjectId(seed = 'antigravity-default') {
  return process.env.DSH_ANTIGRAVITY_PROJECT_ID?.trim() || stableProjectId(seed)
}

/**
 * Pull a project id out of the various shapes loadCodeAssist /
 * listCloudAICompanionProjects answer with. Ported from the reference.
 */
export function extractProjectId(data) {
  if (!isRecord(data)) return undefined
  const direct = data.antigravityProjectId ?? data.projectId ?? data.backendProjectId
    ?? data.userDefinedCloudaicompanionProject ?? data.cloudaicompanionProject ?? data.project
  const directId = asString(direct)
  if (directId) return directId
  if (isRecord(direct)) {
    const nestedId = asString(direct.id)
    if (nestedId) return nestedId
  }
  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
    const value = data[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item)
        if (nested) return nested
        const itemId = asString(item)
        if (itemId) return itemId
      }
    }
  }
  return undefined
}

/** `POST` JSON and fold non-OK statuses into thrown, bounded errors. */
async function postJson(fetchImpl, url, headers, body, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/json' },
    body: JSON.stringify(body),
    ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
  })
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { ok: response.ok, status: response.status, data, text }
}

/**
 * One bound Cloud Code Assist client. `fetchImpl` is injectable for tests;
 * `baseUrl` pins a single endpoint (setups behind gateways); the default walks
 * production then sandbox like the reference.
 */
export function createAntigravityClient({ fetchImpl = fetch, clock = Date.now, baseUrl } = {}) {
  function endpointCandidates() {
    const explicit = baseUrl?.trim() || process.env.DSH_ANTIGRAVITY_BASE_URL?.trim()
    return explicit ? [explicit] : ENDPOINT_FALLBACKS
  }

  /**
   * Consumer subscription credentials generate against daily, while project
   * discovery remains on prod. Do not fall through to prod: it accepts the
   * request but answers RESOURCE_EXHAUSTED even when daily quota is available.
   * An explicit base URL still pins every operation for gateways/tests.
   */
  function generationEndpointCandidates() {
    const explicit = baseUrl?.trim() || process.env.DSH_ANTIGRAVITY_BASE_URL?.trim()
    return explicit ? [explicit] : [DEFAULT_GENERATION_ENDPOINT]
  }

  function antigravityHeaders(token, accept) {
    const platform = process.platform === 'darwin' ? 'MACOS' : process.platform === 'win32' ? 'WINDOWS' : 'LINUX'
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(accept === undefined ? {} : { Accept: accept }),
      'User-Agent': process.env.DSH_ANTIGRAVITY_USER_AGENT?.trim() || `antigravity/1.15.8 ${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'}/${process.arch}`,
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'Client-Metadata': JSON.stringify({
        ideType: 'ANTIGRAVITY',
        platform,
        pluginType: 'GEMINI',
      }),
    }
  }

  const projectCache = new Map() // token → {projectId|undefined, expiresAt}

  /** Discover the Cloud Code Assist project id for this account. */
  async function loadCodeAssist(token) {
    const cached = projectCache.get(token)
    if (cached && cached.expiresAt > clock()) {
      projectCache.delete(token)
      projectCache.set(token, cached)
      return cached.projectId
    }
    let projectId
    for (const endpoint of endpointCandidates()) {
      try {
        const result = await postJson(fetchImpl, `${endpoint}/v1internal:loadCodeAssist`, antigravityHeaders(token), {
          metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
        }, DISCOVERY_TIMEOUT_MS)
        if (!result.ok) continue
        projectId = extractProjectId(result.data)
        if (projectId) break
        const listed = await postJson(fetchImpl, `${endpoint}/v1internal:listCloudAICompanionProjects`, antigravityHeaders(token), {}, DISCOVERY_TIMEOUT_MS)
        if (listed.ok) {
          projectId = extractProjectId(listed.data)
          if (projectId) break
        }
      } catch {
        // try the next endpoint
      }
    }
    projectCache.set(token, { projectId, expiresAt: clock() + CACHE_TTL_MS })
    if (projectCache.size > 32) {
      const oldest = projectCache.keys().next().value
      if (oldest !== undefined) projectCache.delete(oldest)
    }
    return projectId
  }

  /**
   * Runtime model catalog: the keys of `data.models` are the real requestable
   * ids; the nested `model` field is often a placeholder enum that 404s.
   * Returns undefined when no endpoint answered.
   */
  async function fetchAvailableModels(token, projectId) {
    for (const endpoint of endpointCandidates()) {
      try {
        const result = await postJson(fetchImpl, `${endpoint}/v1internal:fetchAvailableModels`, antigravityHeaders(token), { project: projectId }, DISCOVERY_TIMEOUT_MS)
        if (!result.ok) continue
        if (isRecord(result.data) && isRecord(result.data.models)) return result.data.models
      } catch {
        // try the next endpoint
      }
    }
    return undefined
  }

  /** User-quota summary; the backend gates it behind paid subscriptions. */
  async function retrieveUserQuotaSummary(token) {
    const result = await postJson(fetchImpl, `${DEFAULT_ENDPOINT}/v1internal:retrieveUserQuotaSummary`, antigravityHeaders(token), {})
    if (!result.ok) {
      const message = isRecord(result.data) && isRecord(result.data.error) && typeof result.data.error.message === 'string'
        ? result.data.error.message
        : truncateError(result.text)
      throw new Error(`retrieveUserQuotaSummary failed (${result.status}): ${message}`)
    }
    return result.data
  }

  /**
   * POST one generate request; on retryable statuses walk the endpoint list.
   * Returns the raw Response on success, or {ok:false,status,text} otherwise —
   * the caller owns model fallbacks and SSE parsing.
   */
  async function generate({ token, body, signal }) {
    const payload = JSON.stringify(body)
    const headers = antigravityHeaders(token, 'text/event-stream')
    let lastStatus
    let lastText = ''
    for (const endpoint of generationEndpointCandidates()) {
      let response
      try {
        response = await fetchImpl(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers,
          body: payload,
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        lastStatus = undefined
        lastText = error instanceof Error ? error.message : String(error)
        continue
      }
      if (response.ok) return { ok: true, status: response.status, response, endpoint }
      lastStatus = response.status
      lastText = await response.text().catch(() => '')
      if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break
    }
    return { ok: false, status: lastStatus, text: lastText }
  }

  return {
    endpointCandidates,
    generationEndpointCandidates,
    antigravityHeaders,
    loadCodeAssist,
    fetchAvailableModels,
    retrieveUserQuotaSummary,
    generate,
  }
}

function truncateError(text, limit = 300) {
  const value = String(text ?? '')
  return value.length <= limit ? value : value.slice(0, limit - 1)
}

/** Extract Google's `error.message` from an error body, else the raw text. */
export function jsonOrTextError(text) {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.error?.message === 'string') return parsed.error.message
  } catch {
    // not JSON
  }
  return String(text ?? '')
}

/**
 * Turn an upstream failure into one bounded, actionable sentence.
 * Trimmed port of the reference `friendlyAntigravityError`.
 */
export function friendlyError(status, text) {
  const message = jsonOrTextError(text).slice(0, 500)
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(message)) {
      return 'Antigravity login expired or credentials are invalid; sign in again under Settings → Antigravity, then retry.'
    }
    return `Antigravity rejected this request. Retry once; if it keeps failing, switch models or update the plugin. Backend said: ${message}`
  }
  if (status === 401) return 'Antigravity authentication failed; sign in again under Settings → Antigravity.'
  if (status === 403) return `Antigravity denied this request for this account or project. Re-login or try another model. Backend said: ${message}`
  if (status === 404) return 'This model is not available right now; switch to another Antigravity model or retry later.'
  if (status === 408) return 'Antigravity timed out; retry the same request.'
  if (status === 429) {
    const wait = message.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim()
    return `Antigravity quota reached or rate limited.${wait ? ` Resets: ${wait}.` : ''} Switch models or retry later.`
  }
  if (status === 500) return 'Antigravity had an internal server error; retry in a moment or switch models.'
  if (status === 502) return 'Antigravity returned a bad gateway error; retry in a moment.'
  if (status === 503) {
    if (/No capacity available/i.test(message)) return 'This model has no capacity right now; retry later or switch models.'
    return 'Antigravity is temporarily unavailable; retry in a moment or switch models.'
  }
  if (status === 504) return 'Antigravity timed out upstream; retry in a moment.'
  return message
}
