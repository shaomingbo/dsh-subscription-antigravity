import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGenerateRequest,
  completionFromTranslator,
  convertMessages,
  convertTools,
  createStreamTranslator,
  mapFinishReason,
  sanitizeLegacySchema,
  sanitizeToolCallId,
} from '../lib/translate.js'

test('system and developer messages fold into one system text; user text becomes text parts', () => {
  const { contents, systemText } = convertMessages([
    { role: 'system', content: 'be brief' },
    { role: 'developer', content: 'no preamble' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'go on' },
  ], 'gemini-3.1-pro-low')
  assert.equal(systemText, 'be brief\n\nno preamble')
  assert.equal(contents[0].role, 'user')
  assert.deepEqual(contents[0].parts, [{ text: 'hello' }])
  assert.equal(contents[1].role, 'model')
  assert.equal(contents[2].role, 'user')
})

test('image data URLs become inlineData; remote URLs are dropped', () => {
  const { contents } = convertMessages([
    { role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
    ] },
  ], 'gemini-3.1-pro-low')
  assert.deepEqual(contents[0].parts, [
    { text: 'what is this' },
    { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
  ])
})

test('assistant tool_calls become functionCall parts; ids only for claude/gpt-oss runtimes', () => {
  const calls = [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
  const gemini = convertMessages([
    { role: 'assistant', content: null, tool_calls: calls },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
  ], 'gemini-3.1-pro-low')
  // contents[0] is the synthesized "Hello" user turn (conversation must open with user).
  assert.deepEqual(gemini.contents[1].parts, [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }])
  assert.deepEqual(gemini.contents[2].parts, [{ functionResponse: { name: 'read_file', response: { output: 'file body' } } }])

  const claude = convertMessages([
    { role: 'assistant', content: null, tool_calls: calls },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
  ], 'claude-sonnet-4-6')
  assert.deepEqual(claude.contents[1].parts, [{ functionCall: { name: 'read_file', args: { path: 'a.txt' }, id: 'call_1' } }])
  assert.equal(claude.contents[2].parts[0].functionResponse.id, 'call_1')
  assert.equal(claude.contents[2].parts[0].functionResponse.name, 'read_file')
})

test('a conversation opening with a model turn is prefixed with a user turn', () => {
  const { contents } = convertMessages([{ role: 'assistant', content: 'greeting' }], 'gemini-3.1-pro-low')
  assert.equal(contents[0].role, 'user')
  assert.deepEqual(contents[0].parts, [{ text: 'Hello' }])
  assert.equal(contents[1].role, 'model')
})

test('convertTools picks parametersJsonSchema for Gemini and sanitized legacy parameters otherwise', () => {
  const tools = [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string', $comment: 'x' } }, $schema: 'https://json-schema.org/draft/2020-12/schema' } } }]
  const gemini = convertTools(tools, 'gemini-3.1-pro-low')
  assert.deepEqual(gemini[0].functionDeclarations[0].parametersJsonSchema, tools[0].function.parameters)
  assert.equal(gemini[0].functionDeclarations[0].parameters, undefined)

  const claude = convertTools(tools, 'claude-sonnet-4-6')
  assert.equal(claude[0].functionDeclarations[0].parametersJsonSchema, undefined)
  assert.deepEqual(claude[0].functionDeclarations[0].parameters, { type: 'object', properties: { a: { type: 'string' } } })
  assert.equal(convertTools([], 'gemini-3.1-pro-low'), undefined)
  assert.deepEqual(sanitizeLegacySchema({ type: 'object', properties: { p: { type: 'number', minimum: 1 } }, additionalProperties: false }),
    { type: 'object', properties: { p: { type: 'number', minimum: 1 } } })
})

test('buildGenerateRequest shapes the Cloud Code Assist envelope and clamps output tokens', () => {
  const envelope = buildGenerateRequest({
    publicModelId: 'gemini-3.1-pro',
    runtimeModel: 'gemini-3.1-pro-low',
    projectId: 'proj',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }],
    temperature: 0.4,
    maxTokens: 10_000_000,
  })
  assert.equal(envelope.project, 'proj')
  assert.equal(envelope.model, 'gemini-3.1-pro-low')
  assert.equal(envelope.requestType, 1)
  assert.equal(envelope.userAgent, 'ANTIGRAVITY')
  assert.ok(envelope.requestId.startsWith('dsh-antigravity-'))
  assert.deepEqual(envelope.request.systemInstruction, { role: 'user', parts: [{ text: 'sys' }] })
  assert.deepEqual(envelope.request.generationConfig, { temperature: 0.4, maxOutputTokens: 65535 })
  assert.equal(envelope.request.tools[0].functionDeclarations[0].name, 't')
  assert.equal(envelope.request.toolConfig, undefined)
})

test('tiered Gemini carries thinkingConfig; Claude toolChoice becomes functionCallingConfig', () => {
  const tiered = buildGenerateRequest({
    publicModelId: 'gemini-3.7-flash',
    runtimeModel: 'gemini-3.7-flash-tiered',
    projectId: 'p',
    messages: [{ role: 'user', content: 'hi' }],
    reasoningEffort: 'high',
  })
  assert.deepEqual(tiered.request.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' })

  const claude = buildGenerateRequest({
    publicModelId: 'claude-sonnet-4-6',
    runtimeModel: 'claude-sonnet-4-6',
    projectId: 'p',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }],
    toolChoice: { type: 'function', function: { name: 't' } },
  })
  assert.deepEqual(claude.request.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['t'] } })
})

test('mapFinishReason maps length and safety families', () => {
  assert.equal(mapFinishReason('STOP'), 'stop')
  assert.equal(mapFinishReason('MAX_TOKENS'), 'length')
  assert.equal(mapFinishReason('SAFETY'), 'content_filter')
  assert.equal(mapFinishReason(undefined), 'stop')
})

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

test('the stream translator emits role, reasoning, content, tool calls, usage, and DONE', () => {
  const translator = createStreamTranslator({ model: 'gemini-3.1-pro' })
  const out = [
    ...translator.push('data: {"response":{"candidates":[{"content":{"parts":[{"text":"thinking","thought":true},{"text":"answer"}]}}]}}\n'),
  ]
  // The SSE frame was split mid-way; finish feeding the remainder.
  out.push(...translator.push('\n'))
  out.push(...translator.push(sse({ response: { candidates: [{ content: { parts: [{ functionCall: { name: 't', args: { x: 1 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 15 } } }) + '\n'))
  out.push(...translator.push('data: [DONE]\n\n'))
  out.push(...translator.finish())

  const frames = out.filter(text => text.startsWith('data: ') && !text.startsWith('data: [DONE]'))
    .map(text => JSON.parse(text.slice(6)))
  assert.deepEqual(frames[0].choices[0].delta, { role: 'assistant', content: '' })
  assert.deepEqual(frames[1].choices[0].delta, { reasoning_content: 'thinking' })
  assert.deepEqual(frames[2].choices[0].delta, { content: 'answer' })
  const toolFrame = frames[3].choices[0].delta.tool_calls[0]
  assert.equal(toolFrame.function.name, 't')
  assert.equal(toolFrame.function.arguments, '{"x":1}')
  const final = frames[4]
  assert.equal(final.choices[0].finish_reason, 'stop')
  assert.deepEqual(final.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  assert.equal(out.at(-1), 'data: [DONE]\n\n')
  assert.equal(translator.error, undefined)
})

test('the translator flags upstream error payloads and skips malformed lines', () => {
  const translator = createStreamTranslator({ model: 'm' })
  translator.push('not sse at all\ndata: {broken json}\n')
  assert.equal(translator.finish().length > 0, true)
  assert.equal(translator.error, undefined)

  const failing = createStreamTranslator({ model: 'm' })
  failing.push(sse({ error: { message: 'quota exhausted' } }) + '\n')
  assert.equal(failing.error, 'quota exhausted')
  assert.deepEqual(failing.finish(), [])
})

test('completionFromTranslator assembles a non-streaming completion with tool calls', () => {
  const translator = createStreamTranslator({ model: 'gemini-3.1-pro' })
  translator.push(sse({ response: { candidates: [{ content: { parts: [{ text: 'let me ' }, { functionCall: { name: 't', args: {} } }] }, finishReason: 'STOP' }] } }) + '\n')
  translator.finish()
  const completion = completionFromTranslator(translator, { model: 'gemini-3.1-pro' })
  assert.equal(completion.object, 'chat.completion')
  assert.equal(completion.choices[0].message.content, 'let me ')
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, 't')
  assert.equal(completion.choices[0].finish_reason, 'stop')
})

test('sanitizeToolCallId keeps only safe characters and falls back with a counter', () => {
  assert.equal(sanitizeToolCallId('a/b c', 'tool', 1), 'a_b_c')
  assert.match(sanitizeToolCallId('', 'tool', 1), /^tool_\w+_\d+/)
})
