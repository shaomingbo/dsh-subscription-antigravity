/**
 * Pure OpenAI chat-completions ⇄ Cloud Code Assist (Gemini envelope) conversion.
 *
 * No I/O and no logging: every function here is deterministic and unit-tested.
 * Divergence from the pi-antigravity reference: we do NOT inject the Antigravity
 * persona system prompt — DSH owns its system prompts — and thinking parts
 * surface as `reasoning_content` deltas, which pi-ai's openai-completions
 * parser reads as thinking.
 */

import { getMaxOutputTokens, toolCallIdNeeded } from './model-catalog.js'

const TIERED_GEMINI_RUNTIME = 'gemini-3.7-flash-tiered'

let requestCounter = 0

export function nextRequestId() {
  requestCounter += 1
  return `dsh-antigravity-${Date.now().toString(36)}-${requestCounter}`
}

export function sanitizeToolCallId(id, fallbackName, counter) {
  const cleaned = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  if (cleaned.length > 0) return cleaned
  return `${fallbackName || 'tool'}_${Date.now().toString(36)}_${counter}`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an OpenAI image part (data URL only; remote URLs cannot be inlined). */
export function parseImageData(url, explicitMime) {
  const match = typeof url === 'string' ? url.match(/^data:([^;]+);base64,(.+)$/s) : undefined
  if (match) return { mimeType: explicitMime || match[1] || 'image/png', data: match[2].trim() }
  return undefined
}

function textPartsFromContent(content) {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts = []
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      parts.push({ text: item.text })
    } else if (item.type === 'image_url') {
      const url = item.image_url?.url
      const image = parseImageData(url, item.mimeType)
      if (image) parts.push({ inlineData: image })
    }
  }
  return parts
}

function appendTurn(contents, role, parts) {
  if (parts.length === 0) return
  const last = contents[contents.length - 1]
  if (last && last.role === role) last.parts.push(...parts)
  else contents.push({ role, parts })
}

const SYSTEM_ROLES = new Set(['system', 'developer'])

/**
 * Convert OpenAI chat messages to Gemini contents plus a system text.
 * `toolCallIdNeededFor(runtimeModel)` decides whether functionCall / functionResponse
 * parts carry explicit ids (Claude and GPT-OSS bridges require them).
 */
export function convertMessages(messages, runtimeModel) {
  const needsIds = toolCallIdNeeded(runtimeModel, runtimeModel)
  let idCounter = 0
  const systemTexts = []
  const contents = []
  const toolNames = new Map() // tool_call_id → function name, from assistant tool_calls

  for (const message of messages ?? []) {
    if (!isRecord(message)) continue
    if (message.role === 'system' || message.role === 'developer') {
      const parts = textPartsFromContent(message.content)
      if (parts.length > 0) systemTexts.push(parts.map(part => part.text).join('\n'))
      continue
    }
    if (message.role === 'user') {
      appendTurn(contents, 'user', textPartsFromContent(message.content))
      continue
    }
    if (message.role === 'assistant') {
      const parts = textPartsFromContent(message.content)
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (toolCall?.type !== 'function' || !isRecord(toolCall.function)) continue
        const name = toolCall.function.name
        if (typeof name === 'string' && name.length > 0) {
          if (typeof toolCall.id === 'string' && toolCall.id.length > 0) toolNames.set(toolCall.id, name)
          idCounter += 1
          let args = toolCall.function.arguments
          if (typeof args === 'string') {
            try {
              args = args.trim().length === 0 ? {} : JSON.parse(args)
            } catch {
              args = { _raw: args }
            }
          }
          parts.push({
            functionCall: {
              name,
              args: isRecord(args) ? args : {},
              ...(needsIds ? { id: sanitizeToolCallId(toolCall.id, name, idCounter) } : {}),
            },
          })
        }
      }
      appendTurn(contents, 'model', parts)
      continue
    }
    if (message.role === 'tool') {
      const name = toolNames.get(message.tool_call_id) ?? (typeof message.name === 'string' ? message.name : 'tool')
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
      appendTurn(contents, 'user', [{
        functionResponse: {
          name,
          response: { output: text || 'ok' },
          ...(needsIds && typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
            ? { id: sanitizeToolCallId(message.tool_call_id, name, ++idCounter) }
            : {}),
        },
      }])
    }
  }

  // Cloud Code Assist rejects conversations that do not open with a user turn.
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] })
  }
  return { contents, systemText: systemTexts.join('\n\n') }
}

const LEGACY_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'anyOf', 'oneOf', 'allOf',
])

/** Keep the Draft-2020-12 subset the custom-tool bridge accepts in legacy `parameters`. */
export function sanitizeLegacySchema(schema) {
  if (Array.isArray(schema)) return schema.map(item => sanitizeLegacySchema(item))
  if (!isRecord(schema)) return schema
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!LEGACY_SCHEMA_KEYS.has(key)) continue
    if (key === 'properties' && isRecord(value)) {
      const properties = {}
      for (const [name, propertySchema] of Object.entries(value)) properties[name] = sanitizeLegacySchema(propertySchema)
      out.properties = properties
      continue
    }
    out[key] = key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf'
      ? sanitizeLegacySchema(value)
      : value
  }
  if (out.type === undefined && out.properties !== undefined) out.type = 'object'
  return out
}

/** OpenAI tools → Gemini functionDeclarations; Claude/GPT-OSS take legacy `parameters`. */
export function convertTools(tools, runtimeModel) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const useLegacy = runtimeModel.startsWith('claude-') || runtimeModel.startsWith('gpt-oss-')
  const declarations = []
  for (const tool of tools) {
    const fn = tool?.type === 'function' ? tool.function : undefined
    if (!isRecord(fn) || typeof fn.name !== 'string' || fn.name.length === 0) continue
    const schema = isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }
    declarations.push({
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(useLegacy ? { parameters: sanitizeLegacySchema(schema) } : { parametersJsonSchema: schema }),
    })
  }
  if (declarations.length === 0) return undefined
  return [{ functionDeclarations: declarations }]
}

function mapToolChoice(toolChoice, publicModelId, runtimeModel) {
  if (toolChoice === 'none') return { mode: 'NONE' }
  if (isRecord(toolChoice) && toolChoice.type === 'function' && typeof toolChoice.function?.name === 'string') {
    return { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] }
  }
  if (toolChoice === 'required') return { mode: 'ANY' }
  return undefined
}

/**
 * Build the full Cloud Code Assist generate envelope.
 * `reasoningEffort` is the `reasoning_effort` value pi-ai sent (or undefined).
 */
export function buildGenerateRequest({
  publicModelId,
  runtimeModel,
  projectId,
  messages,
  tools,
  toolChoice,
  temperature,
  maxTokens,
  reasoningEffort,
  requestId = nextRequestId(),
}) {
  const { contents, systemText } = convertMessages(messages, runtimeModel)
  const request = { contents }
  if (systemText.length > 0) {
    request.systemInstruction = { role: 'user', parts: [{ text: systemText }] }
  }

  const generationConfig = {}
  if (typeof temperature === 'number') generationConfig.temperature = temperature
  const cap = getMaxOutputTokens(publicModelId, runtimeModel)
  generationConfig.maxOutputTokens = typeof maxTokens === 'number' && Number.isFinite(maxTokens)
    ? Math.min(Math.max(1, Math.trunc(maxTokens)), cap)
    : cap
  if (runtimeModel === TIERED_GEMINI_RUNTIME) {
    generationConfig.thinkingConfig = {
      thinkingLevel: reasoningEffort === 'high' ? 'HIGH' : reasoningEffort === 'medium' ? 'MEDIUM' : 'LOW',
    }
  }
  request.generationConfig = generationConfig

  const convertedTools = convertTools(tools, runtimeModel)
  if (convertedTools !== undefined) {
    request.tools = convertedTools
    const config = mapToolChoice(toolChoice, publicModelId, runtimeModel)
    if (config !== undefined && runtimeModel.startsWith('claude-')) request.toolConfig = { functionCallingConfig: config }
  }

  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: 1, // Agent
    userAgent: 'ANTIGRAVITY',
    requestId,
  }
}

export function mapFinishReason(finishReason) {
  if (finishReason === 'MAX_TOKENS') return 'length'
  if (finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'BLOCKLIST'
    || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'SPII') return 'content_filter'
  return 'stop'
}

/**
 * Incremental upstream-SSE → downstream-OpenAI-SSE translator.
 * `push(text)` feeds raw upstream bytes; each call returns the downstream SSE
 * frames produced so far; `finish()` flushes the tail (usage + [DONE]).
 * `error` is set when the upstream stream carried an error payload.
 */
export function createStreamTranslator({ model, created = Math.floor(Date.now() / 1000), id = `chatcmpl-${nextRequestId()}` }) {
  let buffer = ''
  let started = false
  let toolIndex = 0
  let finishReason
  let usage
  let error
  let contentText = ''
  const toolCalls = []

  const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
  const chatFrame = (delta, extra = {}) => frame({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
  })

  const startIfNeeded = () => {
    if (started) return []
    started = true
    return [chatFrame({ role: 'assistant', content: '' })]
  }

  return {
    get id() {
      return id
    },
    push(chunk) {
      buffer += chunk
      const events = []
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (isRecord(chunk) && isRecord(chunk.error)) {
          error = typeof chunk.error.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error)
          continue
        }
        const response = isRecord(chunk) && isRecord(chunk.response) ? chunk.response : chunk
        const candidate = isRecord(response) && Array.isArray(response.candidates) ? response.candidates[0] : undefined
        const parts = isRecord(candidate) && isRecord(candidate.content) && Array.isArray(candidate.content.parts)
          ? candidate.content.parts
          : []
        for (const part of parts) {
          if (!isRecord(part)) continue
          if (typeof part.text === 'string' && part.text.length > 0) {
            if (part.thought === true) {
              events.push(...startIfNeeded(), chatFrame({ reasoning_content: part.text }))
            } else {
              contentText += part.text
              events.push(...startIfNeeded(), chatFrame({ content: part.text }))
            }
          }
          if (isRecord(part.functionCall) && typeof part.functionCall.name === 'string') {
            events.push(...startIfNeeded())
            const args = isRecord(part.functionCall.args) ? part.functionCall.args : {}
            const callId = `call_${toolIndex}_${sanitizeToolCallId(part.functionCall.id ?? '', part.functionCall.name, toolIndex)}`
            toolCalls.push({ id: callId, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(args) } })
            events.push(chatFrame({
              tool_calls: [{
                index: toolIndex,
                type: 'function',
                id: callId,
                function: { name: part.functionCall.name, arguments: JSON.stringify(args) },
              }],
            }))
            toolIndex += 1
          }
        }
        if (isRecord(candidate) && typeof candidate.finishReason === 'string') {
          finishReason = candidate.finishReason
        }
        if (isRecord(response) && isRecord(response.usageMetadata)) {
          const meta = response.usageMetadata
          const prompt = typeof meta.promptTokenCount === 'number' ? meta.promptTokenCount : 0
          const output = (typeof meta.candidatesTokenCount === 'number' ? meta.candidatesTokenCount : 0)
            + (typeof meta.thoughtsTokenCount === 'number' ? meta.thoughtsTokenCount : 0)
          usage = {
            prompt_tokens: prompt,
            completion_tokens: output,
            total_tokens: typeof meta.totalTokenCount === 'number' ? meta.totalTokenCount : prompt + output,
          }
        }
      }
      return events
    },
    finish() {
      const events = []
      if (error !== undefined) return events
      if (!started) {
        // Upstream completed without any candidate content — surface an empty
        // assistant message rather than a hung client.
        events.push(chatFrame({ role: 'assistant', content: '' }))
        started = true
      }
      const mapped = mapFinishReason(finishReason)
      events.push(chatFrame({}, { finish_reason: mapped, ...(usage === undefined ? {} : { usage }) }))
      events.push('data: [DONE]\n\n')
      return events
    },
    get error() {
      return error
    },
    get receivedAnything() {
      return started
    },
    /** Assembled non-stream completion state (only meaningful after finish()). */
    result() {
      return { id, created, finishReason, usage, error, text: contentText, toolCalls }
    },
  }
}

/** Assemble a non-streaming OpenAI completion from a finished translator. */
export function completionFromTranslator(translator, { model }) {
  const state = translator.result()
  const message = { role: 'assistant', content: state.text.length > 0 ? state.text : null }
  if (state.toolCalls.length > 0) message.tool_calls = state.toolCalls
  return {
    id: state.id,
    object: 'chat.completion',
    created: state.created,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapFinishReason(state.finishReason),
    }],
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  }
}

export function openAiErrorBody(message, { type = 'upstream_error', code } = {}) {
  return { error: { message, type, ...(code === undefined ? {} : { code }) } }
}
