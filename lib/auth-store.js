/**
 * Owner-only persistence for the local Antigravity account pool.
 *
 * Version 2 stores multiple OAuth credentials plus one active account and the
 * opt-in failover preference. Version 1's single `credentials.antigravity`
 * entry is migrated in memory and rewritten as v2 on the next mutation.
 * Atomic writes, 0600 file / 0700 directory modes, a serialized operation
 * queue, and last-good-snapshot survival are retained from the single-account
 * store.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const FORMAT_VERSION = 2
const LEGACY_FORMAT_VERSION = 1
export const PROVIDER_ID = 'antigravity'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableDigest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24)
}

/** Stable, non-secret local identity for a Google profile. */
export function accountIdForProfile({ id, email, projectId } = {}) {
  if (typeof id === 'string' && id.length > 0) return `google:${stableDigest(id)}`
  if (typeof email === 'string' && email.length > 0) return `email:${stableDigest(email.trim().toLowerCase())}`
  if (typeof projectId === 'string' && projectId.length > 0) return `project:${stableDigest(projectId)}`
  return 'legacy:default'
}

function assertAccountId(accountId) {
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 200) {
    throw new Error('antigravity-auth: account id must be a non-empty bounded string')
  }
  return accountId
}

/** Extra non-secret fields kept beside the pi-ai-style token triple. */
function extraFields(value) {
  const extras = {}
  if (typeof value.projectId === 'string' && value.projectId.length > 0) extras.projectId = value.projectId
  if (typeof value.email === 'string' && value.email.length > 0) extras.email = value.email
  if (typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.createdAt >= 0) extras.createdAt = value.createdAt
  return extras
}

function oauthCredential(accountId, value) {
  if (!isRecord(value) || value.type !== 'oauth') {
    throw new Error(`antigravity-auth: credential for "${accountId}" must have type "oauth"`)
  }
  if (typeof value.access !== 'string' || value.access.length === 0) {
    throw new Error(`antigravity-auth: credential for "${accountId}" has no access token`)
  }
  if (typeof value.refresh !== 'string' || value.refresh.length === 0) {
    throw new Error(`antigravity-auth: credential for "${accountId}" has no refresh token`)
  }
  if (typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires <= 0) {
    throw new Error(`antigravity-auth: credential for "${accountId}" has an invalid expiry`)
  }
  return { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires, ...extraFields(value) }
}

function sortedAccounts(accounts) {
  return [...accounts.entries()].sort(([leftId, left], [rightId, right]) => {
    const created = (left.createdAt ?? 0) - (right.createdAt ?? 0)
    return created === 0 ? leftId.localeCompare(rightId) : created
  })
}

function normalizeActive(accounts, requested) {
  if (typeof requested === 'string' && accounts.has(requested)) return requested
  return sortedAccounts(accounts)[0]?.[0]
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    const position = error instanceof SyntaxError ? error.message.match(/position \d+/)?.[0] : undefined
    throw new Error(`antigravity-auth: the auth document is not valid JSON${position === undefined ? '' : ` (${position})`}`)
  }
}

/** Parse v1 or v2; exported for migration and corruption tests. */
export function parseAuthDocument(text) {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) throw new Error('antigravity-auth: the auth document must be an object')

  if (parsed.version === LEGACY_FORMAT_VERSION) {
    if (!isRecord(parsed.credentials)) {
      throw new Error('antigravity-auth: the legacy auth document has no credentials object')
    }
    const accounts = new Map()
    const foreign = {}
    for (const [providerId, value] of Object.entries(parsed.credentials)) {
      if (providerId !== PROVIDER_ID) {
        foreign[providerId] = value
        continue
      }
      const credential = oauthCredential(providerId, value)
      const accountId = accountIdForProfile(credential)
      accounts.set(accountId, credential)
    }
    return {
      accounts,
      activeAccountId: normalizeActive(accounts),
      autoFailover: false,
      foreign,
      migrated: true,
    }
  }

  if (parsed.version !== FORMAT_VERSION) {
    throw new Error('antigravity-auth: the auth document has an unsupported version')
  }
  if (!isRecord(parsed.accounts)) {
    throw new Error('antigravity-auth: the auth document has no accounts object')
  }
  const accounts = new Map()
  for (const [accountId, value] of Object.entries(parsed.accounts)) {
    accounts.set(assertAccountId(accountId), oauthCredential(accountId, value))
  }
  return {
    accounts,
    activeAccountId: normalizeActive(accounts, parsed.activeAccountId),
    autoFailover: parsed.autoFailover === true,
    foreign: isRecord(parsed.foreignCredentials) ? parsed.foreignCredentials : {},
    migrated: false,
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * The account-pool persistence module. Callers see account operations rather
 * than the JSON layout; every mutating operation is serialized and atomic.
 */
export class AuthStore {
  constructor({ filename, onError = () => {}, onChanged = () => {} } = {}) {
    this.filename = filename
    this.onError = onError
    this.onChanged = onChanged
    this.accounts = new Map()
    this.activeAccountId = undefined
    this.autoFailover = false
    this.foreignEntries = {}
    this.migrated = false
    this.closed = false
    this.operations = Promise.resolve()
  }

  async init() {
    try {
      await this.reload()
    } catch (error) {
      this.onError(error)
    }
  }

  configured() {
    return this.accounts.size > 0
  }

  activeId() {
    return this.activeAccountId
  }

  preferences() {
    return { autoFailover: this.autoFailover }
  }

  listAccounts() {
    return sortedAccounts(this.accounts).map(([accountId, credential]) => ({ accountId, ...credential }))
  }

  readAccount(accountId = this.activeAccountId) {
    if (accountId === undefined) return undefined
    return this.accounts.get(accountId)
  }

  findByEmail(email) {
    if (typeof email !== 'string' || email.length === 0) return undefined
    const normalized = email.trim().toLowerCase()
    return this.listAccounts().find(account => account.email?.trim().toLowerCase() === normalized)
  }

  async upsertAccount(accountId, value, { activate = true } = {}) {
    assertAccountId(accountId)
    return this.enqueue(async () => {
      if (this.closed) return this.readAccount(accountId)
      const current = this.accounts.get(accountId)
      const credential = oauthCredential(accountId, {
        ...value,
        createdAt: value.createdAt ?? current?.createdAt ?? Date.now(),
      })
      const nextAccounts = new Map(this.accounts)
      nextAccounts.set(accountId, credential)
      const nextActive = activate ? accountId : normalizeActive(nextAccounts, this.activeAccountId)
      if (same(current, credential) && nextActive === this.activeAccountId && !this.migrated) return current
      await this.writeState({ accounts: nextAccounts, activeAccountId: nextActive, autoFailover: this.autoFailover })
      this.commit(nextAccounts, nextActive, this.autoFailover)
      this.onChanged({ kind: 'upsert', accountId, activeAccountId: nextActive })
      return credential
    })
  }

  async modifyAccount(accountId, mutator) {
    assertAccountId(accountId)
    return this.enqueue(async () => {
      const current = this.accounts.get(accountId)
      if (this.closed || current === undefined) return current
      const returned = await mutator(current)
      if (returned === undefined) return current
      const credential = oauthCredential(accountId, { ...returned, createdAt: returned.createdAt ?? current.createdAt })
      if (same(current, credential) && !this.migrated) return current
      const nextAccounts = new Map(this.accounts)
      nextAccounts.set(accountId, credential)
      await this.writeState({ accounts: nextAccounts, activeAccountId: this.activeAccountId, autoFailover: this.autoFailover })
      this.commit(nextAccounts, this.activeAccountId, this.autoFailover)
      this.onChanged({ kind: 'modify', accountId, activeAccountId: this.activeAccountId })
      return credential
    })
  }

  async activateAccount(accountId) {
    assertAccountId(accountId)
    return this.enqueue(async () => {
      if (this.closed) return this.activeAccountId
      if (!this.accounts.has(accountId)) throw new Error(`Unknown Antigravity account: ${accountId}`)
      if (this.activeAccountId === accountId && !this.migrated) return accountId
      await this.writeState({ accounts: this.accounts, activeAccountId: accountId, autoFailover: this.autoFailover })
      this.commit(this.accounts, accountId, this.autoFailover)
      this.onChanged({ kind: 'activate', accountId, activeAccountId: accountId })
      return accountId
    })
  }

  async deleteAccount(accountId) {
    assertAccountId(accountId)
    return this.enqueue(async () => {
      if (this.closed || !this.accounts.has(accountId)) return this.activeAccountId
      const nextAccounts = new Map(this.accounts)
      nextAccounts.delete(accountId)
      const nextActive = this.activeAccountId === accountId
        ? normalizeActive(nextAccounts)
        : normalizeActive(nextAccounts, this.activeAccountId)
      const nextAutoFailover = nextAccounts.size === 0 ? false : this.autoFailover
      await this.writeState({ accounts: nextAccounts, activeAccountId: nextActive, autoFailover: nextAutoFailover })
      this.commit(nextAccounts, nextActive, nextAutoFailover)
      this.onChanged({ kind: 'delete', accountId, activeAccountId: nextActive })
      return nextActive
    })
  }

  async setAutoFailover(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('autoFailover must be a boolean')
    return this.enqueue(async () => {
      if (this.closed) return this.autoFailover
      if (this.autoFailover === enabled && !this.migrated) return enabled
      await this.writeState({ accounts: this.accounts, activeAccountId: this.activeAccountId, autoFailover: enabled })
      this.commit(this.accounts, this.activeAccountId, enabled)
      this.onChanged({ kind: 'preferences', activeAccountId: this.activeAccountId })
      return enabled
    })
  }

  /** Replace the in-memory snapshot from disk; keep the last good snapshot on failure. */
  async reload() {
    if (this.closed) return
    let text
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.accounts = new Map()
        this.activeAccountId = undefined
        this.autoFailover = false
        this.foreignEntries = {}
        this.migrated = false
        return
      }
      throw error
    }
    try {
      const parsed = parseAuthDocument(text)
      this.accounts = parsed.accounts
      this.activeAccountId = parsed.activeAccountId
      this.autoFailover = parsed.autoFailover
      this.foreignEntries = parsed.foreign
      this.migrated = parsed.migrated
    } catch (error) {
      this.onError(error)
    }
  }

  commit(accounts, activeAccountId, autoFailover) {
    this.accounts = new Map(accounts)
    this.activeAccountId = activeAccountId
    this.autoFailover = autoFailover
    this.migrated = false
  }

  async writeState({ accounts, activeAccountId, autoFailover }) {
    if (accounts.size === 0 && Object.keys(this.foreignEntries).length === 0) {
      await unlink(this.filename).catch(() => {})
      return
    }
    const document = {
      version: FORMAT_VERSION,
      ...(activeAccountId === undefined ? {} : { activeAccountId }),
      autoFailover: autoFailover === true,
      accounts: Object.fromEntries([...accounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ...(Object.keys(this.foreignEntries).length === 0 ? {} : { foreignCredentials: this.foreignEntries }),
    }
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    const temp = `${this.filename}.tmp-${process.pid}`
    try {
      await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' })
      await chmod(temp, 0o600)
      await rename(temp, this.filename)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  enqueue(operation) {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  async dispose() {
    this.closed = true
    await this.operations
  }
}
