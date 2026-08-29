import test from 'node:test'
import assert from 'node:assert/strict'
import { createCredentialSynchronizer } from '../lib/credential-sync.js'

function fakes({ configured = true, token = 'tok-1', resolveValue } = {}) {
  const calls = { set: [], resolve: 0, getToken: 0 }
  const auth = {
    configured: () => configured,
    getAccessToken: async () => {
      calls.getToken += 1
      return token
    },
  }
  const credentials = {
    resolve: async () => {
      calls.resolve += 1
      return resolveValue === undefined ? undefined : { value: resolveValue }
    },
    set: async (ref, value) => {
      calls.set.push({ ref, value })
    },
  }
  const warnings = []
  const logger = {
    info: () => {},
    // printf-style: mirror the DSH logger contract by joining format + args.
    warn: (...args) => warnings.push(args.map(String).join(' ')),
  }
  return { auth, credentials, logger, calls, warnings }
}

test('sync stores the fresh token under the antigravity ref', async () => {
  const env = fakes()
  const synchronizer = createCredentialSynchronizer(env)
  await synchronizer.sync('request')
  assert.deepEqual(env.calls.set, [{ ref: 'ANTIGRAVITY_ACCESS_TOKEN', value: 'tok-1' }])
})

test('sync is skipped when the account is not configured', async () => {
  const env = fakes({ configured: false })
  const synchronizer = createCredentialSynchronizer(env)
  await synchronizer.sync('timer')
  assert.equal(env.calls.set.length, 0)
  assert.equal(env.calls.getToken, 0)
})

test('concurrent syncs de-duplicate into one credential write', async () => {
  const env = fakes()
  const synchronizer = createCredentialSynchronizer(env)
  await Promise.all([synchronizer.sync('a'), synchronizer.sync('b'), synchronizer.sync('c')])
  assert.equal(env.calls.set.length, 1)
})

test('background syncs swallow failures into warnings', async () => {
  const auth = {
    configured: () => true,
    getAccessToken: async () => { throw new Error('network down') },
  }
  const credentials = { resolve: async () => undefined, set: async () => {} }
  const warnings = []
  const synchronizer = createCredentialSynchronizer({
    auth,
    credentials,
    logger: { info: () => {}, warn: (...args) => warnings.push(args.map(String).join(' ')) },
  })
  synchronizer.background('timer')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(warnings.length, 1)
  assert.match(warnings.at(-1), /network down/)
})
