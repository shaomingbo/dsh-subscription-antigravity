# SPEC — protocol references and design notes

This plugin is an independent implementation for DeepSeek Harness. The wire
protocol mirrors the open-source reference
[pi-antigravity](https://github.com/Rahularya01/pi-antigravity) (MIT), which in
turn documents the Antigravity CLI (`agy`) behavior. Current endpoint and
request-envelope behavior is also parity-checked against
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/f0de1d008fe8881dcb7431cf97b147295874c2b2/internal/runtime/executor).
Everything below lives in `lib/antigravity-api.js`, `lib/oauth.js`, and
`lib/model-catalog.js`, so a Google-side change stays localized.

## OAuth (lib/oauth.js)

| Constant | Value |
|---|---|
| Authorize | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token | `https://oauth2.googleapis.com/token` |
| Redirect | `http://localhost:51121/oauth-callback` (loopback only) |
| Flow | Authorization Code + PKCE (S256), `access_type=offline`, `prompt=consent` |
| Scopes | `aicode`, `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs` |
| Client | Google's public Antigravity desktop client id/secret (public identifiers, embedded base64 as the reference does); override with `DSH_ANTIGRAVITY_OAUTH_CLIENT_ID` / `DSH_ANTIGRAVITY_OAUTH_CLIENT_SECRET` |

State is independent of the PKCE verifier, so a leaked callback URL alone
cannot mint tokens. `expires` is stored 5 minutes early. `invalid_grant` on
refresh maps to the `credential-rejected` envelope (ref
`ANTIGRAVITY_ACCESS_TOKEN`) so the UI prompts re-login. A pasted callback URL
follows the same validation rules as the loopback handler (remote/headless
browsers).

## Cloud Code Assist (lib/antigravity-api.js)

- Control plane: `https://cloudcode-pa.googleapis.com`; model discovery may
  fall back through `https://daily-cloudcode-pa.googleapis.com` and sandbox.
  Consumer generation is pinned to `https://daily-cloudcode-pa.googleapis.com`
  (prod returns false `RESOURCE_EXHAUSTED` for subscription quota). Explicit
  override: `DSH_ANTIGRAVITY_BASE_URL`.
- Headers: `Authorization: Bearer`, `Accept: text/event-stream` (generation),
  `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1`,
  `Client-Metadata: {"ideType":"ANTIGRAVITY",...}`, UA `antigravity/1.15.8`.
- `POST /v1internal:loadCodeAssist` → project id (fallback
  `listCloudAICompanionProjects`, then a stable seeded UUID). Cached 30 min.
- `POST /v1internal:fetchAvailableModels` (`{project}`) → runtime catalog; the
  keys of `data.models` are the real requestable ids.
- `POST /v1internal:streamGenerateContent?alt=sse` — envelope
  `{project, model, request, requestType: "agent", userAgent: "antigravity",
  requestId}`; `request` is Gemini-shaped (`contents`, `systemInstruction`,
  `generationConfig`, `tools`, `toolConfig`). SSE events carry
  `{response: {candidates: [{content: {parts}, finishReason}], usageMetadata}}`.
- Gemini requires a `thoughtSignature` on replayed `functionCall` parts. Since
  OpenAI chat history has no native signature carrier, replay uses Antigravity's
  `skip_thought_signature_validator` sentinel (matching CLIProxyAPI); Claude and
  GPT-OSS replay without it.
- Retry ladder: generation stays on the consumer daily endpoint; a 404 walks
  the fallback runtime id, then a dynamic `fetchAvailableModels` lookup; empty
  streams retry with backoff.
- Quota: `POST /v1internal:retrieveUserQuotaSummary` (paid tiers) plus
  per-model hints from `fetchAvailableModels`; everything degrades gracefully.
- Generation usage maps Gemini `cachedContentTokenCount` to OpenAI
  `prompt_tokens_details.cached_tokens` and `thoughtsTokenCount` to
  `completion_tokens_details.reasoning_tokens`, so pi-ai records cache reads and
  reasoning separately instead of treating them as fresh prompt/output.

## Models and thinking routing (lib/model-catalog.js)

Seven public ids (the `agy models` catalog): `gemini-3.7-flash`,
`gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-pro`, `claude-sonnet-4-6`,
`claude-opus-4-6`, `gpt-oss-120b`. `reasoning_effort` → runtime id mapping
follows the reference `ANTIGRAVITY_ROUTING` table, including the
workaround-for-backend-bugs entries (`gemini-pro-agent` for Gemini 3.1 Pro
high; `gemini-3-flash-agent` for Gemini 3.5 Flash high; single
`gemini-3.7-flash-tiered` runtime with `generationConfig.thinkingConfig`).
Output caps come from the reference `RUNTIME_MAX_OUTPUT_TOKENS` table.

## Translation decisions (lib/translate.js)

- OpenAI `system`/`developer` messages fold into `systemInstruction`. Unlike
  the reference we do NOT inject an Antigravity persona — DSH owns its system
  prompts.
- Images: `image_url` data URLs → `inlineData`; remote URLs are dropped.
- Tool calls: Gemini `functionCall` ⇄ OpenAI `tool_calls`; function names for
  `functionResponse` are recovered from the originating assistant message.
  Claude/GPT-OSS runtimes carry explicit call ids and legacy sanitized
  `parameters` schemas; Gemini runtimes use `parametersJsonSchema` and no ids.
- Thinking: `thought: true` parts surface as `reasoning_content` deltas, which
  pi-ai's openai-completions parser reads as thinking. Known limitation: we do
  not replay `thoughtSignature` on later turns (stateless OpenAI surface);
  Claude multi-turn *tool* calls may degrade before Google's bridge if it
  demands signatures — Gemini models are unaffected.
- A conversation that opens with a model turn is prefixed with a `user`
  "Hello" turn (backend rejects otherwise).
- `finishReason` mapping: `MAX_TOKENS` → `length`; safety family →
  `content_filter`; else `stop`.

## DSH integration (lib/index.js)

- Loader entry id `subscription-antigravity` (see `cordis.patch.yml`); the
  route is written once through `settings.update('llm-pi-ai', …)` with
  per-provider merge: `apiKeyEnv: ANTIGRAVITY_ACCESS_TOKEN`,
  `api: openai-completions`, `baseURL: http://127.0.0.1:51122/v1`,
  `compat: {supportsDeveloperRole: false, maxTokensField: max_tokens}`.
  Provisioning is a repair, not a takeover: user-customized `models` and
  display names are preserved, and only this provider's own fields ever change.
- Credentials: `$DSH_HOME/.antigravity-auth.json` (own file, not the shared
  `.oauth.json`, because two plugins each keep in-memory whole-document stores
  of that file in one host process and would clobber each other). Fresh access
  tokens sync into the credentials seam for route resolution; the proxy
  authenticates upstream with its own runtime token.
- The RPC channel `/subscription-antigravity` is loopback-authority only and
  folds private error codes into schema-legal envelopes.

## Risk notes

- Cloud Code Assist is an internal, undocumented Google API; shapes and
  endpoints have changed before and will again. All constants are centralized
  for quick updates; watch the pi-antigravity repo for protocol drift.
- These tools reuse your own subscription quota through the same auth the
  official client uses. Do not share tokens or resell access.

## Release checklist (owner)

1. `npm run check`, `npm pack --dry-run`, `git diff --check`.
2. Commit, tag `vX.Y.Z` (SemVer), push tag; add the `dsh-plugin` topic.
3. From the actual tag, run the npx install / status / uninstall loop once.
4. Catalog admission into `dsh-plugin-catalog` follows its human approval gates
   and is intentionally not automated here.
