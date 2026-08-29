/**
 * Static Antigravity model catalog and thinking-effort routing.
 *
 * Mirrors the Antigravity CLI catalog (`agy models`) as collapsed by the
 * pi-antigravity reference implementation (github.com/Rahularya01/pi-antigravity,
 * src/models/models.ts): seven public model ids, each exposing only the thinking
 * levels the backend advertises. Public ids are what DSH's model picker shows
 * and what our loopback proxy accepts; routing maps (public id, reasoning_effort)
 * to the runtime id Cloud Code Assist actually serves.
 */

export const PROVIDER_ID = 'antigravity'

/** Thinking-level shapes the backend advertises per public model id. */
const LEVEL_MAPS = {
  lowMediumHigh: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
  lowHigh: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
  thinking: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null },
  medium: { off: null, minimal: null, low: null, medium: 'medium', high: null, xhigh: null, max: null },
}

/**
 * Public selectable model ids → backend runtime ids by thinking effort.
 * `off` is the no-thinking runtime id when one exists; `routing` maps an
 * explicit reasoning_effort value. Entries here mirror the reference exactly,
 * including the working-around-backend-bugs comments.
 */
export const ANTIGRAVITY_ROUTING = {
  'claude-opus-4-6': {
    off: 'claude-opus-4-6-thinking',
    routing: { minimal: 'claude-opus-4-6-thinking', low: 'claude-opus-4-6-thinking', medium: 'claude-opus-4-6-thinking', high: 'claude-opus-4-6-thinking' },
    defaultRequestId: 'claude-opus-4-6-thinking',
  },
  // fetchAvailableModels exposes `claude-sonnet-4-6` (display: Thinking), not a separate *-thinking id.
  'claude-sonnet-4-6': {
    off: 'claude-sonnet-4-6',
    routing: { minimal: 'claude-sonnet-4-6', low: 'claude-sonnet-4-6', medium: 'claude-sonnet-4-6', high: 'claude-sonnet-4-6', xhigh: 'claude-sonnet-4-6' },
    defaultRequestId: 'claude-sonnet-4-6',
  },
  'gemini-3.1-pro': {
    // `gemini-3.1-pro-high` is advertised but currently 400s for agent streamGenerateContent;
    // `gemini-pro-agent` is the working High runtime id (same display name in fetchAvailableModels).
    off: 'gemini-3.1-pro-low',
    routing: { minimal: 'gemini-3.1-pro-low', low: 'gemini-3.1-pro-low', medium: 'gemini-3.1-pro-low', high: 'gemini-pro-agent', xhigh: 'gemini-pro-agent' },
    defaultRequestId: 'gemini-3.1-pro-low',
  },
  'gemini-3.7-flash': {
    // One tiered runtime id; the thinking effort travels in generationConfig.thinkingConfig.
    off: 'gemini-3.7-flash-tiered',
    routing: { minimal: 'gemini-3.7-flash-tiered', low: 'gemini-3.7-flash-tiered', medium: 'gemini-3.7-flash-tiered', high: 'gemini-3.7-flash-tiered', xhigh: 'gemini-3.7-flash-tiered' },
    defaultRequestId: 'gemini-3.7-flash-tiered',
  },
  'gemini-3.6-flash': {
    off: 'gemini-3.6-flash-low',
    routing: { minimal: 'gemini-3.6-flash-low', low: 'gemini-3.6-flash-low', medium: 'gemini-3.6-flash-medium', high: 'gemini-3.6-flash-high', xhigh: 'gemini-3.6-flash-high' },
    defaultRequestId: 'gemini-3.6-flash-low',
  },
  'gemini-3.5-flash': {
    // Production uses extra-low / low / gemini-3-flash-agent for Low/Medium/High.
    off: 'gemini-3.5-flash-extra-low',
    routing: { minimal: 'gemini-3.5-flash-extra-low', low: 'gemini-3.5-flash-low', medium: 'gemini-3.5-flash-low', high: 'gemini-3-flash-agent', xhigh: 'gemini-3-flash-agent' },
    defaultRequestId: 'gemini-3.5-flash-extra-low',
  },
  'gpt-oss-120b': {
    off: 'gpt-oss-120b-medium',
    routing: { minimal: 'gpt-oss-120b-medium', low: 'gpt-oss-120b-medium', medium: 'gpt-oss-120b-medium', high: 'gpt-oss-120b-medium' },
    defaultRequestId: 'gpt-oss-120b-medium',
  },
}

/**
 * Verified maximum output tokens accepted by the Cloud Code Assist backend per
 * runtime id; requesting more returns 400. Mirrors the reference table.
 */
export const RUNTIME_MAX_OUTPUT_TOKENS = {
  'gemini-3.7-flash': 65536,
  'gemini-3.7-flash-tiered': 65536,
  'gemini-3.7-flash-low': 65536,
  'gemini-3.7-flash-medium': 65536,
  'gemini-3.7-flash-high': 65536,
  'gemini-3.6-flash': 65536,
  'gemini-3.6-flash-low': 65536,
  'gemini-3.6-flash-medium': 65536,
  'gemini-3.6-flash-high': 65536,
  'gemini-3.5-flash': 65536,
  'gemini-3.5-flash-extra-low': 65536,
  'gemini-3.5-flash-low': 65536,
  'gemini-3-flash-agent': 65536,
  'gemini-3.1-pro': 65535,
  'gemini-3.1-pro-low': 65535,
  'gemini-3.1-pro-high': 65535,
  'gemini-pro-agent': 65535,
  'claude-opus-4-6': 64000,
  'claude-opus-4-6-thinking': 64000,
  'claude-sonnet-4-6': 64000,
  'gpt-oss-120b': 32768,
  'gpt-oss-120b-medium': 32768,
}

/** Output cap for a runtime id, falling back by family, then a safe default. */
export function getMaxOutputTokens(modelId, runtimeModel) {
  if (runtimeModel !== undefined && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel]
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) return RUNTIME_MAX_OUTPUT_TOKENS[modelId]
  if (runtimeModel !== undefined) {
    if (runtimeModel.startsWith('claude-')) return 64000
    if (runtimeModel.startsWith('gpt-oss-')) return 32768
    if (runtimeModel.startsWith('gemini-3.1-pro') || runtimeModel === 'gemini-pro-agent') return 65535
    if (runtimeModel.startsWith('gemini-')) return 65536
  }
  return 8192
}

/** Runtime ids that need explicit function call ids (Claude and GPT-OSS bridges). */
export function toolCallIdNeeded(modelId, runtimeModel) {
  return modelId.startsWith('claude-') || modelId.startsWith('gpt-oss-')
    || runtimeModel.startsWith('claude-') || runtimeModel.startsWith('gpt-oss-')
}

/** Resolve public model id + reasoning effort (reasoning_effort) to a runtime id. */
export function resolveRuntimeModelId(modelId, effort) {
  const routing = ANTIGRAVITY_ROUTING[modelId]
  if (!routing) return modelId
  if (effort === undefined || effort === null || effort === 'off') {
    return routing.off ?? routing.routing?.low ?? routing.routing?.minimal ?? routing.defaultRequestId ?? modelId
  }
  const byEffort = routing.routing?.[effort]
  return byEffort
    ?? routing.routing?.low
    ?? routing.routing?.minimal
    ?? routing.off
    ?? routing.defaultRequestId
    ?? modelId
}

/** Fallback runtime id when a next-gen model is not yet served by the backend. */
export function getFallbackRuntimeModel(runtimeModel, effort) {
  if (runtimeModel === 'gemini-3.7-flash-tiered') return resolveRuntimeModelId('gemini-3.6-flash', effort)
  if (runtimeModel.startsWith('gemini-3.7-flash-')) {
    return runtimeModel.replace('gemini-3.7-flash-', 'gemini-3.6-flash-')
  }
  if (runtimeModel === 'gemini-3.7-flash') return 'gemini-3.6-flash-low'
  return undefined
}

/**
 * The static model route entries provisioned into `llm-pi-ai.providers`.
 * `reasoningEfforts` maps DSH thinking levels to the `reasoning_effort` value
 * pi-ai sends on the wire; null hides a level the backend does not advertise.
 */
export const ROUTE_MODELS = [
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash (Antigravity)',
    contextWindow: 1048576,
    maxTokens: 65536,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { ...LEVEL_MAPS.lowMediumHigh },
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash (Antigravity)',
    contextWindow: 1048576,
    maxTokens: 65536,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { ...LEVEL_MAPS.lowMediumHigh },
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash (Antigravity)',
    contextWindow: 1048576,
    maxTokens: 65536,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { ...LEVEL_MAPS.lowMediumHigh },
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro (Antigravity)',
    contextWindow: 1048576,
    maxTokens: 65535,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { ...LEVEL_MAPS.lowHigh },
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Antigravity)',
    contextWindow: 200000,
    maxTokens: 64000,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { ...LEVEL_MAPS.thinking },
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (Antigravity)',
    contextWindow: 250000,
    maxTokens: 64000,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { ...LEVEL_MAPS.thinking },
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B (Antigravity)',
    contextWindow: 131072,
    maxTokens: 32768,
    input: ['text'],
    reasoning: true,
    reasoningEfforts: { ...LEVEL_MAPS.medium },
  },
]

export const ROUTE_MODEL_IDS = ROUTE_MODELS.map(model => model.id)
