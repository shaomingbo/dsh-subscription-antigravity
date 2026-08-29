/**
 * Loopback OpenAI-compatible proxy in front of Cloud Code Assist.
 *
 * Binds 127.0.0.1 only and speaks just enough of the OpenAI wire protocol for
 * pi-ai's `openai-completions` route: `GET /v1/models` and
 * `POST /v1/chat/completions` (SSE streaming and JSON). Requests are trusted
 * by loopback binding; no bearer check — the boundary is the local machine.
 * Upstream model fallbacks (fallback runtime id, then a dynamic
 * fetchAvailableModels lookup) and empty-response retries mirror the
 * pi-antigravity reference streaming loop.
 */

import { createServer } from 'node:http'
import { ROUTE_MODELS, ROUTE_MODEL_IDS, resolveRuntimeModelId, getFallbackRuntimeModel } from './model-catalog.js'
import {
  buildGenerateRequest,
  completionFromTranslator,
  createStreamTranslator,
  nextRequestId,
  openAiErrorBody,
} from './translate.js'
import { defaultProjectId, friendlyError } from './antigravity-api.js'

const MAX_BODY_BYTES = 64 * 1024 * 1024
const EMPTY_RETRY_DELAYS_MS = [500, 1000]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `auth` is an AntigravityAuth; `client` a createAntigravityClient() product.
 * Both are injected so tests can fake them without network or OAuth.
 */
export function createProxy({ auth, accountRouter, client, logger = { warn: () => {}, info: () => {} }, port = 51122, host = '127.0.0.1', emptyRetryDelays = EMPTY_RETRY_DELAYS_MS } = {}) {
  let server
  let actualPort = port
  let starting

  function modelsDocument() {
    return {
      object: 'list',
      data: ROUTE_MODELS.map(model => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'antigravity',
        input: model.input,
        reasoning: model.reasoning === true,
      })),
    }
  }

  async function resolveProjectId(context) {
    if (typeof context.projectId === 'string' && context.projectId.length > 0) return context.projectId
    let discovered
    try {
      discovered = await client.loadCodeAssist(context.token)
    } catch {
      discovered = undefined
    }
    if (typeof discovered === 'string' && discovered.length > 0) {
      await auth.rememberProjectId(context.accountId, discovered)
      return discovered
    }
    return defaultProjectId(typeof context.email === 'string' ? context.email : context.accountId)
  }

  const router = accountRouter ?? {
    async route({ signal, attempt }) {
      const context = typeof auth.getActiveContext === 'function'
        ? await auth.getActiveContext(signal)
        : { accountId: 'antigravity', token: await auth.getAccessToken(), ...auth.status() }
      return { ...(await attempt(context)), accountId: context.accountId, switched: false, retry: () => attempt(context) }
    },
  }

  function sendError(res, status, message, extra) {
    if (res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ...openAiErrorBody(message), ...(extra ?? {}) }))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** One upstream generate attempt; returns {ok, response?} or {ok:false, status, text}. */
  async function attempt({ token, projectId, params, runtimeModel, signal }) {
    const body = buildGenerateRequest({
      publicModelId: params.model,
      runtimeModel,
      projectId,
      messages: params.messages,
      tools: params.tools,
      toolChoice: params.tool_choice,
      temperature: params.temperature,
      maxTokens: params.max_tokens,
      reasoningEffort: params.reasoning_effort,
      requestId: nextRequestId(),
    })
    const result = await client.generate({ token, body, signal })
    if (result.ok) return { ok: true, response: result.response }
    return { ok: false, status: result.status, text: result.text }
  }

  /** The full ladder: primary runtime → fallback runtime → dynamic lookup. */
  async function generateWithFallbacks({ token, projectId, params, signal }) {
    const runtime = resolveRuntimeModelId(params.model, params.reasoning_effort)
    const tried = new Set()
    const candidates = [runtime]
    const fallback = getFallbackRuntimeModel(runtime, params.reasoning_effort)
    if (fallback !== undefined && fallback !== runtime) candidates.push(fallback)

    let last
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      tried.add(candidate)
      last = await attempt({ token, projectId, params, runtimeModel: candidate, signal })
      if (last.ok) return { ...last, runtimeModel: candidate }
      if (last.status !== 404) return { ...last, runtimeModel: candidate }
      if (index + 1 === candidates.length) {
        const models = await client.fetchAvailableModels(token, projectId).catch(() => undefined)
        if (models !== undefined) {
          const dynamic = findDynamicRuntimeModel(models, params.model)
          if (dynamic !== undefined && !tried.has(dynamic)) candidates.push(dynamic)
        }
      }
    }
    return { ...last, runtimeModel: candidates[candidates.length - 1] }
  }

  /** Stream one attempt; returns {empty} when upstream finished without content. */
  async function streamAttempt({ response, res, publicModelId }) {
    const translator = createStreamTranslator({ model: publicModelId })
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let upstreamError
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const frames = translator.push(decoder.decode(value, { stream: true }))
        if (frames.length > 0) res.write(frames.join(''))
        if (translator.error !== undefined) {
          upstreamError = translator.error
          break
        }
      }
    } finally {
      reader.releaseLock?.()
    }
    // Capture before finish(): an empty stream gets synthesized tail frames.
    const received = translator.receivedAnything
    let tail = translator.finish()
    if (upstreamError !== undefined) {
      tail = [
        `data: ${JSON.stringify({ error: openAiErrorBody(upstreamError) })}\n\n`,
        'data: [DONE]\n\n',
      ]
    }
    // An empty attempt writes nothing: the retry loop keeps the SSE open.
    if ((received || upstreamError !== undefined) && !res.writableEnded) res.write(tail.join(''))
    return { empty: !received && upstreamError === undefined, error: upstreamError }
  }

  async function handleChatCompletions(req, res) {
    let params
    try {
      params = JSON.parse(await readBody(req))
    } catch (error) {
      sendError(res, 400, `invalid request body: ${error instanceof Error ? error.message : String(error)}`, { type: 'invalid_request_error' })
      return
    }
    if (typeof params?.model !== 'string' || !ROUTE_MODEL_IDS.includes(params.model)) {
      sendError(res, 400, `unknown model: ${String(params?.model)}; known models: ${ROUTE_MODEL_IDS.join(', ')}`, { type: 'invalid_request_error' })
      return
    }
    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      sendError(res, 400, 'messages must be a non-empty array', { type: 'invalid_request_error' })
      return
    }

    const abort = new AbortController()
    let closed = false
    req.on('close', () => {
      if (!res.writableEnded) {
        closed = true
        abort.abort()
      }
    })

    let outcome
    try {
      outcome = await router.route({
        runtimeModel: resolveRuntimeModelId(params.model, params.reasoning_effort),
        signal: abort.signal,
        attempt: async context => {
          const projectId = await resolveProjectId(context)
          return generateWithFallbacks({ token: context.token, projectId, params, signal: abort.signal })
        },
      })
    } catch (error) {
      const status = error?.code === 'ANTIGRAVITY_AUTH_NOT_CONFIGURED' || error?.code === 'ANTIGRAVITY_AUTH_EXPIRED' ? 401 : 502
      sendError(res, status, error instanceof Error ? error.message : String(error))
      return
    }
    if (!outcome.ok) {
      const status = outcome.status === 401 || outcome.status === 403 ? 401
        : outcome.status === 429 ? 429
          : 502
      sendError(res, status, friendlyError(outcome.status, outcome.text))
      return
    }

    const wantsStream = params.stream === true
    const streamingResponse = outcome.response
    if (!wantsStream) {
      const collector = createStreamTranslator({ model: params.model })
      const decoder = new TextDecoder()
      const reader = streamingResponse.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          collector.push(decoder.decode(value, { stream: true }))
        }
      } finally {
        reader.releaseLock?.()
      }
      collector.finish()
      const state = collector.result()
      if (state.error !== undefined) {
        sendError(res, 502, state.error)
        return
      }
      if (!collector.receivedAnything) {
        sendError(res, 502, 'Antigravity returned an empty response; retry the request.')
        return
      }
      const completion = completionFromTranslator(collector, { model: params.model })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(completion))
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    // Empty-response retry: Cloud Code Assist occasionally finishes a stream
    // without any candidate; retry with backoff like the reference client.
    let attemptCount = 0
    let result = await streamAttempt({ response: streamingResponse, res, publicModelId: params.model })
    while (result.empty && attemptCount < emptyRetryDelays.length && !closed) {
      await sleep(emptyRetryDelays[attemptCount])
      attemptCount += 1
      const retry = await outcome.retry()
      if (!retry.ok) break
      result = await streamAttempt({ response: retry.response, res, publicModelId: params.model })
    }
    if (result.empty) {
      // Retries exhausted without any content — close the stream honestly.
      res.write([
        `data: ${JSON.stringify({ error: openAiErrorBody('Antigravity returned an empty response; retry the request.') })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''))
    }
    res.end()
  }

  function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(modelsDocument()))
      return
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      handleChatCompletions(req, res).catch(error => {
        logger.warn('dsh-subscription-antigravity: proxy request failed: %s', error?.stack ?? String(error))
        sendError(res, res.writableEnded ? 200 : 500, error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/v1' || url.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, plugin: 'dsh-subscription-antigravity', provider: 'antigravity' }))
      return
    }
    sendError(res, 404, `no such endpoint: ${req.method} ${url.pathname}`, { type: 'invalid_request_error' })
  }

  return {
    async start() {
      if (starting !== undefined) return starting
      starting = new Promise((resolve, reject) => {
        server = createServer(handler)
        server.once('error', reject)
        server.listen(port, host, () => {
          actualPort = server.address()?.port ?? port
          resolve(actualPort)
        })
      })
      return starting
    },
    stop() {
      if (server === undefined) return Promise.resolve()
      const closing = server
      server = undefined
      starting = undefined
      return new Promise(resolve => {
        closing.closeAllConnections?.()
        closing.close(() => resolve())
      })
    },
    get port() {
      return actualPort
    },
    get url() {
      return `http://127.0.0.1:${actualPort}/v1`
    },
  }
}

/**
 * Resolve a requested public model id against a fetchAvailableModels payload.
 * Runtime ids are the payload keys; label matches are a secondary path.
 */
export function findDynamicRuntimeModel(models, requestedId) {
  if (models === undefined || typeof requestedId !== 'string') return undefined
  if (typeof models[requestedId] !== 'undefined') return requestedId
  const escaped = requestedId.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\-/g, '[- ]')
  const pattern = new RegExp(escaped, 'i')
  for (const [runtimeId, info] of Object.entries(models)) {
    if (!/^(gemini-|claude-|gpt-oss-)/i.test(runtimeId)) continue
    if (pattern.test(runtimeId)) return runtimeId
    const label = info?.label ?? info?.displayName ?? info?.name
    if (typeof label === 'string' && pattern.test(label)) return runtimeId
  }
  return undefined
}
