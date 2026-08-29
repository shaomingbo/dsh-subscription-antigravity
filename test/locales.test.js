import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { AntigravityAuth } from '../lib/oauth.js'
import { AuthStore, PROVIDER_ID } from '../lib/auth-store.js'
import { ROUTE_MODEL_IDS } from '../lib/model-catalog.js'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/**
 * Load lib/client.js in a sandbox with a fake `window.__ModuleLoader__` and a
 * fake `require('react')`. The factory runs at load time only on plain values,
 * so a stub is enough; the factory hands back its locales for parity checks.
 */
function loadClientModule() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let loaded
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: definition => {
          loaded = definition
        },
      },
    },
    require: name => {
      if (name === 'react') {
        return new Proxy({}, { get: (_target, prop) => (prop === '__esModule' ? false : () => null) })
      }
      throw new Error(`unexpected require: ${name}`)
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded?.id, 'dsh-subscription-antigravity')
  const factoryResult = loaded.factory(sandbox.require)
  // Values cross a vm realm, so compare structurally via JSON.
  assert.equal(JSON.stringify(factoryResult.inject), JSON.stringify(['slots', 'connection']))
  return factoryResult
}

test('the zh/en dictionaries carry the same keys', () => {
  const { locales } = loadClientModule()
  const en = Object.keys(locales.en).sort()
  const zh = Object.keys(locales.zh).sort()
  assert.deepEqual(zh, en)
  for (const key of en) {
    assert.equal(typeof locales.en[key], 'string', `en.${key} should be a string`)
    assert.equal(typeof locales.zh[key], 'string', `zh.${key} should be a string`)
  }
  for (const key of ['addAccount', 'removeAccount', 'switchAccount', 'autoFailover', 'modelsTitle', 'usageTitle', 'statusDisconnected']) {
    assert.ok(key in locales.en, `missing UX key ${key}`)
  }
})

test('the RPC endpoints the client calls all exist on the host channel handler', async () => {
  // Extract the endpoint list from lib/index.js and assert the client-side set is a subset.
  const hostSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const endpoints = new Set([...hostSource.matchAll(/endpoint === '([a-z-]+)'/g)].map(match => match[1]))
  for (const endpoint of ['accounts', 'activate-account', 'remove-account', 'set-auto-failover', 'usage-all', 'start-login', 'paste-callback', 'login-status', 'cancel-login', 'usage', 'models']) {
    assert.ok(endpoints.has(endpoint), `host is missing the ${endpoint} endpoint`)
  }
  assert.ok(ROUTE_MODEL_IDS.length > 0)
})

test('smoke: the host auth runtime answers a providers RPC shape without touching tokens', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dirName = mkdtempSync(join(tmpdir(), 'dsh-antigravity-smoke-'))
  try {
    const store = new AuthStore({ filename: join(dirName, '.antigravity-auth.json') })
    const auth = new AntigravityAuth({ store })
    await auth.init()
    assert.deepEqual(auth.status(), { provider: PROVIDER_ID, configured: false })
    assert.equal(auth.configured(), false)
    assert.equal(readFileSyncSafe(join(dirName, '.antigravity-auth.json')), undefined)
  } finally {
    rmSync(dirName, { recursive: true, force: true })
  }
})

function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
