import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AntigravityAuth,
  AntigravityAuthError,
  createAuthUrl,
  createCallbackHandler,
  generatePkce,
  parsePastedCallback,
  redactSecrets,
  sanitizeProviderError,
} from '../lib/oauth.js'
import { AuthStore } from '../lib/auth-store.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-antigravity-store-'))
  const filename = join(dir, '.antigravity-auth.json')
  return {
    filename,
    store: new AuthStore({ filename }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

test('generatePkce produces an S256 challenge of the verifier', () => {
  const { verifier, challenge } = generatePkce()
  assert.equal(verifier.length, 43)
  const expected = createHash('sha256').update(verifier).digest().toString('base64url')
  assert.equal(challenge, expected)
  assert.notEqual(generatePkce().verifier, verifier)
})

test('createAuthUrl carries client, redirect, scopes, PKCE, state, and offline access', () => {
  const { challenge } = generatePkce()
  const url = new URL(createAuthUrl({ challenge, state: 'st4te' }))
  assert.equal(url.origin, 'https://accounts.google.com')
  assert.equal(url.pathname, '/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:51121/oauth-callback')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), challenge)
  assert.equal(url.searchParams.get('state'), 'st4te')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'select_account consent')
  assert.ok(url.searchParams.get('scope').includes('aicode'))
  assert.ok(url.searchParams.get('scope').includes('cloud-platform'))
  assert.ok(url.searchParams.get('scope').includes('userinfo.email'))
})

test('parsePastedCallback accepts full URLs and bare query strings, rejects errors and mismatches', () => {
  const parsed = parsePastedCallback('http://localhost:51121/oauth-callback?state=abc&code=xyz', 'abc')
  assert.deepEqual(parsed, { code: 'xyz', state: 'abc' })
  assert.deepEqual(parsePastedCallback('?state=abc&code=xyz', 'abc'), { code: 'xyz', state: 'abc' })
  assert.throws(() => parsePastedCallback('', 'abc'), /No callback pasted/)
  assert.throws(() => parsePastedCallback('http://localhost:51121/oauth-callback?error=access_denied', 'abc'), /access_denied/)
  assert.throws(() => parsePastedCallback('http://localhost:51121/oauth-callback?state=abc', 'abc'), /missing 'code' or 'state'/)
  assert.throws(() => parsePastedCallback('http://localhost:51121/oauth-callback?state=other&code=xyz', 'abc'), /State mismatch/)
})

test('redactSecrets and sanitizeProviderError keep tokens out of messages', () => {
  const secrets = ['supersecretaccesstokenvalue']
  const text = 'boom {"error":"invalid_grant"} token=supersecretaccesstokenvalue'
  assert.equal(redactSecrets(text, secrets), 'boom {"error":"invalid_grant"} token=[redacted]')
  assert.equal(sanitizeProviderError('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', secrets),
    'invalid_grant: Token has been expired or revoked.')
  assert.equal(sanitizeProviderError('plain text failure supersecretaccesstokenvalue', secrets), 'plain text failure [redacted]')
  // short secrets are never used for redaction (would corrupt unrelated text)
  assert.equal(redactSecrets('abc', ['abc']), 'abc')
})

test('callback handler validates method, path, error, state, and completes on success', () => {
  const outcomes = { complete: [], error: [] }
  const handler = createCallbackHandler('expected', {
    onComplete: value => outcomes.complete.push(value),
    onError: error => outcomes.error.push(error),
  })
  const respond = () => ({ writeHead() {}, end() {} })

  handler({ method: 'POST', url: '/oauth-callback' }, respond())
  handler({ method: 'GET', url: '/wrong' }, respond())
  handler({ method: 'GET', url: '/oauth-callback?error=access_denied' }, respond())
  handler({ method: 'GET', url: '/oauth-callback?state=expected' }, respond())
  handler({ method: 'GET', url: '/oauth-callback?code=x&state=wrong' }, respond())
  handler({ method: 'GET', url: '/oauth-callback?code=x&state=expected' }, respond())

  assert.deepEqual(outcomes.complete, [{ code: 'x', state: 'expected' }])
  assert.equal(outcomes.error.length, 3)
  assert.equal(outcomes.error[0].code, 'ANTIGRAVITY_LOGIN_PROVIDER_ERROR')
  assert.equal(outcomes.error[1].code, 'ANTIGRAVITY_LOGIN_FAILED')
  assert.equal(outcomes.error[2].code, 'ANTIGRAVITY_LOGIN_STATE_MISMATCH')
})

test('AuthStore round-trips an account pool atomically and survives a corrupt rewrite', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    assert.equal(env.store.configured(), false)
    await env.store.upsertAccount('a1', { type: 'oauth', access: 'a1', refresh: 'r1', expires: 1000, email: 'me@example.com' })
    await env.store.upsertAccount('a2', { type: 'oauth', access: 'a2', refresh: 'r2', expires: 2000, email: 'other@example.com' }, { activate: false })
    assert.equal(env.store.configured(), true)
    assert.equal(env.store.activeId(), 'a1')
    assert.equal(env.store.listAccounts().length, 2)
    const raw = JSON.parse(readFileSync(env.filename, 'utf8'))
    assert.equal(raw.version, 2)
    assert.equal(raw.accounts.a1.email, 'me@example.com')

    await env.store.modifyAccount('a1', current => ({ ...current, projectId: 'proj-1' }))
    await env.store.activateAccount('a2')
    await env.store.setAutoFailover(true)
    assert.equal(env.store.readAccount('a1').projectId, 'proj-1')
    assert.equal(env.store.activeId(), 'a2')
    assert.equal(env.store.preferences().autoFailover, true)

    writeFileSync(env.filename, '{not json')
    await env.store.reload()
    assert.equal(env.store.readAccount('a1').access, 'a1')

    await env.store.deleteAccount('a2')
    assert.equal(env.store.activeId(), 'a1')
    await env.store.deleteAccount('a1')
    assert.equal(env.store.configured(), false)
    assert.equal(existsSync(env.filename), false)
  } finally {
    env.cleanup()
  }
})

test('AuthStore migrates v1 without re-login and preserves foreign entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-antigravity-store-'))
  const filename = join(dir, '.antigravity-auth.json')
  try {
    writeFileSync(filename, `${JSON.stringify({
      version: 1,
      credentials: {
        antigravity: { type: 'oauth', access: 'a', refresh: 'r', expires: 5, email: 'legacy@example.com' },
        'openai-codex': { type: 'oauth', access: 'x', refresh: 'y', expires: 6 },
      },
    }, null, 2)}\n`)
    const store = new AuthStore({ filename })
    await store.init()
    assert.equal(store.configured(), true)
    const legacy = store.listAccounts()[0]
    assert.equal(legacy.email, 'legacy@example.com')
    assert.equal(store.activeId(), legacy.accountId)
    await store.modifyAccount(legacy.accountId, current => ({ ...current, access: 'a2' }))
    const raw = JSON.parse(readFileSync(filename, 'utf8'))
    assert.equal(raw.version, 2)
    assert.equal(raw.foreignCredentials['openai-codex'].access, 'x')
    assert.equal(raw.accounts[legacy.accountId].access, 'a2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startLogin returns an auth URL; paste completion exchanges the code and stores credentials', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    const fetchCalls = []
    const auth = new AntigravityAuth({
      store: env.store,
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, body: options?.body })
        if (url.includes('oauth2/v1/userinfo')) return jsonResponse({ id: 'google-user-1', email: 'me@example.com' })
        return jsonResponse({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 })
      },
      discoverProject: async () => 'proj-discovered',
      clock: () => 1_000_000,
    })
    await auth.init()
    const challenge = await auth.startLogin()
    assert.ok(challenge.authUrl.startsWith('https://accounts.google.com/'))
    assert.equal(typeof challenge.loginId, 'string')

    await auth.completeWithPaste(challenge.loginId, `http://localhost:51121/oauth-callback?state=${new URL(challenge.authUrl).searchParams.get('state')}&code=one`)
    const accountId = env.store.activeId()
    const credential = env.store.readAccount(accountId)
    assert.equal(typeof accountId, 'string')
    assert.equal(credential.access, 'at1')
    assert.equal(credential.refresh, 'rt1')
    assert.equal(credential.email, 'me@example.com')
    assert.equal(credential.projectId, 'proj-discovered')
    // expires_in 3600 minus the 5-minute safety margin
    assert.equal(credential.expires, 1_000_000 + (3600 - 300) * 1000)

    const exchange = fetchCalls.find(call => call.url.includes('oauth2.googleapis.com/token'))
    assert.ok(exchange.body.includes('grant_type=authorization_code'))
    assert.ok(exchange.body.includes('code=one'))
    assert.deepEqual(auth.status(), {
      provider: 'antigravity',
      configured: true,
      accountId,
      active: true,
      email: 'me@example.com',
      projectId: 'proj-discovered',
      expires: credential.expires,
      expired: false,
    })
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('two Google profiles coexist and can be activated without re-authentication', async () => {
  const env = tempStore()
  try {
    const auth = new AntigravityAuth({
      store: env.store,
      fetchImpl: async (url, options) => {
        if (url.includes('oauth2/v1/userinfo')) {
          const token = options.headers.Authorization.slice('Bearer '.length)
          return token === 'access-one'
            ? jsonResponse({ id: 'google-one', email: 'one@example.com' })
            : jsonResponse({ id: 'google-two', email: 'two@example.com' })
        }
        const code = new URLSearchParams(options.body).get('code')
        return jsonResponse({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, expires_in: 3600 })
      },
      discoverProject: async token => `project-${token}`,
      clock: () => 2_000_000,
    })
    await auth.init()
    for (const code of ['one', 'two']) {
      const login = await auth.startLogin()
      const state = new URL(login.authUrl).searchParams.get('state')
      await auth.completeWithPaste(login.loginId, `http://localhost:51121/oauth-callback?state=${state}&code=${code}`)
    }
    const accounts = auth.statuses()
    assert.equal(accounts.length, 2)
    assert.equal(auth.status().email, 'two@example.com')
    const first = accounts.find(account => account.email === 'one@example.com')
    await auth.activateAccount(first.accountId)
    assert.equal(auth.status().email, 'one@example.com')
    await auth.removeAccount(first.accountId)
    assert.equal(auth.status().email, 'two@example.com')
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('userinfo outages create unique anonymous records instead of overwriting accounts', async () => {
  const env = tempStore()
  try {
    const auth = new AntigravityAuth({
      store: env.store,
      fetchImpl: async (url, options) => {
        if (url.includes('oauth2/v1/userinfo')) return jsonResponse({ error: 'unavailable' }, 503)
        const code = new URLSearchParams(options.body).get('code')
        return jsonResponse({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, expires_in: 3600 })
      },
      clock: () => 2_000_000,
    })
    await auth.init()
    for (const code of ['one', 'two']) {
      const login = await auth.startLogin()
      const state = new URL(login.authUrl).searchParams.get('state')
      await auth.completeWithPaste(login.loginId, `http://localhost:51121/oauth-callback?state=${state}&code=${code}`)
    }
    const accounts = env.store.listAccounts()
    assert.equal(accounts.length, 2)
    assert.equal(new Set(accounts.map(account => account.accountId)).size, 2)
    assert.ok(accounts.every(account => account.accountId.startsWith('anonymous:')))
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('a second startLogin while one is pending is refused', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    const auth = new AntigravityAuth({ store: env.store, fetchImpl: async () => { throw new Error('unused') } })
    await auth.init()
    await auth.startLogin()
    await assert.rejects(() => auth.startLogin(), error => error.code === 'ANTIGRAVITY_LOGIN_IN_PROGRESS')
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('cancelLogin settles the login as cancelled', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    const auth = new AntigravityAuth({ store: env.store, fetchImpl: async () => { throw new Error('unused') } })
    await auth.init()
    const challenge = await auth.startLogin()
    await auth.cancelLogin(challenge.loginId)
    assert.equal(auth.loginStatus(challenge.loginId).kind, 'cancelled')
    await assert.rejects(() => auth.completeWithPaste(challenge.loginId, 'http://localhost:51121/oauth-callback?state=x&code=y'))
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('getAccessToken refreshes near expiry under a single flight and persists the new token', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    await env.store.upsertAccount('a1', { type: 'oauth', access: 'stale', refresh: 'rt', expires: 1_000_000 + 30 * 1000 })
    let fetchCount = 0
    const auth = new AntigravityAuth({
      store: env.store,
      fetchImpl: async () => {
        fetchCount += 1
        return jsonResponse({ access_token: `fresh-${fetchCount}`, expires_in: 3600 })
      },
      clock: () => 1_000_000 + 30 * 1000, // inside the margin
    })
    await auth.init()
    const [first, second] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])
    assert.equal(first, 'fresh-1')
    assert.equal(second, 'fresh-1')
    assert.equal(fetchCount, 1)
    assert.equal(env.store.readAccount('a1').access, 'fresh-1')
    // Now outside the margin: no refresh round-trip.
    auth.clock = () => 1_000_000 + 120 * 1000
    assert.equal(await auth.getAccessToken(), 'fresh-1')
    assert.equal(fetchCount, 1)
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('refresh single-flight is isolated per account', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    await env.store.upsertAccount('a1', { type: 'oauth', access: 'old-1', refresh: 'refresh-1', expires: 1 })
    await env.store.upsertAccount('a2', { type: 'oauth', access: 'old-2', refresh: 'refresh-2', expires: 1 }, { activate: false })
    const calls = []
    const auth = new AntigravityAuth({
      store: env.store,
      fetchImpl: async (_url, options) => {
        const refresh = new URLSearchParams(options.body).get('refresh_token')
        calls.push(refresh)
        return jsonResponse({ access_token: `new-${refresh.at(-1)}`, expires_in: 3600 })
      },
      clock: () => 10_000,
    })
    await auth.init()
    const [one, oneAgain, two] = await Promise.all([
      auth.getAccessToken('a1'),
      auth.getAccessToken('a1'),
      auth.getAccessToken('a2'),
    ])
    assert.equal(one, 'new-1')
    assert.equal(oneAgain, 'new-1')
    assert.equal(two, 'new-2')
    assert.deepEqual(calls.sort(), ['refresh-1', 'refresh-2'])
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('a rejected refresh maps to ANTIGRAVITY_AUTH_EXPIRED with the credential ref', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    await env.store.upsertAccount('a1', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    const auth = new AntigravityAuth({
      store: env.store,
      fetchImpl: async () => jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
      clock: () => 10_000,
    })
    await auth.init()
    await assert.rejects(
      () => auth.getAccessToken(),
      error => {
        assert.ok(error instanceof AntigravityAuthError)
        assert.equal(error.code, 'ANTIGRAVITY_AUTH_EXPIRED')
        assert.equal(error.details.ref, 'ANTIGRAVITY_ACCESS_TOKEN')
        return true
      },
    )
    // The store entry is kept so diagnostics still show the account.
    assert.equal(env.store.readAccount('a1').refresh, 'r')
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})

test('logout clears the store and closes pending logins', async () => {
  const env = tempStore()
  try {
    await env.store.init()
    await env.store.upsertAccount('a1', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    const auth = new AntigravityAuth({ store: env.store, fetchImpl: async () => { throw new Error('unused') } })
    await auth.init()
    await auth.startLogin()
    await auth.logout()
    assert.equal(auth.configured(), false)
    assert.deepEqual(auth.status(), { provider: 'antigravity', configured: false })
    await auth.dispose()
  } finally {
    env.cleanup()
  }
})
