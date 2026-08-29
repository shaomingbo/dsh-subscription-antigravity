import test from 'node:test'
import assert from 'node:assert/strict'
import { createCredentialSynchronizer } from '../lib/credential-sync.js'

function fakes({ configured = true, token = 'tok-1', resolveValue } = {}) {
  const calls = { set: [], unset: [], resolve: 0, getToken: 0 }
  const auth = {
    configured: () => configured,
    activeAccountId: () => configured ? 'a1' : undefined,
    getActiveContext: async () => {
      calls.getToken += 1
      return { accountId: 'a1', token }
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
    unset: async ref => {
      calls.unset.push(ref)
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

test('sync clears the seam when the account pool is empty', async () => {
  const env = fakes({ configured: false })
  const synchronizer = createCredentialSynchronizer(env)
  await synchronizer.sync('timer')
  assert.equal(env.calls.set.length, 0)
  assert.deepEqual(env.calls.unset, ['ANTIGRAVITY_ACCESS_TOKEN'])
  assert.equal(env.calls.getToken, 0)
})

test('concurrent syncs de-duplicate into one credential write', async () => {
  const env = fakes()
  const synchronizer = createCredentialSynchronizer(env)
  await Promise.all([synchronizer.sync('a'), synchronizer.sync('b'), synchronizer.sync('c')])
  assert.equal(env.calls.set.length, 1)
})

test('a switch during an in-flight sync leaves the seam on the new account', async () => {
  let active = 'a1'
  let release
  const gate = new Promise(resolve => { release = resolve })
  let first = true
  const auth = {
    configured: () => true,
    activeAccountId: () => active,
    getActiveContext: async () => {
      const captured = active
      if (first) {
        first = false
        await gate
      }
      return { accountId: captured, token: `token-${captured}` }
    },
  }
  let stored
  const writes = []
  const credentials = {
    resolve: async () => stored === undefined ? undefined : { value: stored },
    set: async (_ref, value) => {
      stored = value
      writes.push(value)
    },
    unset: async () => { stored = undefined },
  }
  const synchronizer = createCredentialSynchronizer({ auth, credentials, logger: { info: () => {}, warn: () => {} } })
  const oldSync = synchronizer.sync('old')
  active = 'a2'
  const switchedSync = synchronizer.sync('switch')
  release()
  await Promise.all([oldSync, switchedSync])
  assert.deepEqual(writes, ['token-a1', 'token-a2'])
  assert.equal(stored, 'token-a2')
})

test('background syncs swallow failures into warnings', async () => {
  const auth = {
    configured: () => true,
    getActiveContext: async () => { throw new Error('network down') },
  }
  const credentials = { resolve: async () => undefined, set: async () => {}, unset: async () => {} }
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
