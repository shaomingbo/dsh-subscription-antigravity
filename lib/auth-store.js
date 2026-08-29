/**
 * Owner-only JSON persistence for this plugin's Antigravity OAuth credentials.
 *
 * Lives at `$DSH_HOME/.antigravity-auth.json` — deliberately NOT the shared
 * `$DSH_HOME/.oauth.json` that dsh-subscription-search owns: both plugins run
 * in the same host process, each with its own in-memory store, and two writers
 * of one whole-document file would clobber each other's provider entries.
 * Atomic writes (temp file + rename), 0600 file / 0700 directory modes, a
 * serialized operation queue, and last-good-snapshot survival when an external
 * edit is invalid. Ported from the dsh-subscription-search oauth-store shape.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const FORMAT_VERSION = 1
export const PROVIDER_ID = 'antigravity'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extra non-secret fields this plugin keeps beside the pi-ai-style token triple. */
function extraFields(value) {
  const extras = {}
  if (typeof value.projectId === 'string' && value.projectId.length > 0) extras.projectId = value.projectId
  if (typeof value.email === 'string' && value.email.length > 0) extras.email = value.email
  return extras
}

function oauthCredential(providerId, value) {
  if (!isRecord(value) || value.type !== 'oauth') {
    throw new Error(`antigravity-auth: credential for "${providerId}" must have type "oauth"`)
  }
  if (typeof value.access !== 'string' || value.access.length === 0) {
    throw new Error(`antigravity-auth: credential for "${providerId}" has no access token`)
  }
  if (typeof value.refresh !== 'string' || value.refresh.length === 0) {
    throw new Error(`antigravity-auth: credential for "${providerId}" has no refresh token`)
  }
  if (typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires <= 0) {
    throw new Error(`antigravity-auth: credential for "${providerId}" has an invalid expiry`)
  }
  return { type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires, ...extraFields(value) }
}

/** Parse a stored document; exported for tests. */
export function parseAuthDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const position = error instanceof SyntaxError ? error.message.match(/position \d+/)?.[0] : undefined
    throw new Error(`antigravity-auth: the auth document is not valid JSON${position === undefined ? '' : ` (${position})`}`)
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION) {
    throw new Error('antigravity-auth: the auth document has an unsupported version')
  }
  if (!isRecord(parsed.credentials)) {
    throw new Error('antigravity-auth: the auth document has no credentials object')
  }
  const credentials = new Map()
  const foreign = {}
  for (const [providerId, value] of Object.entries(parsed.credentials)) {
    if (providerId !== PROVIDER_ID) {
      foreign[providerId] = value // foreign entries stay untouched on rewrite
      continue
    }
    credentials.set(providerId, oauthCredential(providerId, value))
  }
  return { credentials, foreign }
}

export class AuthStore {
  constructor({ filename, onError = () => {}, onChanged = () => {} } = {}) {
    this.filename = filename
    this.onError = onError
    this.onChanged = onChanged
    this.credentials = new Map()
    this.foreignEntries = {}
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

  has(providerId = PROVIDER_ID) {
    return this.credentials.has(providerId)
  }

  read(providerId = PROVIDER_ID) {
    return this.credentials.get(providerId)
  }

  async modify(providerId = PROVIDER_ID, mutator) {
    return this.enqueue(async () => {
      const current = this.credentials.get(providerId)
      if (this.closed) return current
      const returned = await mutator(current)
      if (returned === undefined) return current
      const credential = oauthCredential(providerId, returned)
      if (credentialEquals(current, credential)) return current
      const next = new Map(this.credentials)
      next.set(providerId, credential)
      await this.writeCredentials(next)
      this.credentials = next
      this.onChanged(providerId)
      return credential
    })
  }

  /** Remove one credential; unlinks the file once nothing at all is stored. */
  async delete(providerId = PROVIDER_ID) {
    return this.enqueue(async () => {
      if (this.closed || !this.credentials.has(providerId)) return
      const next = new Map(this.credentials)
      next.delete(providerId)
      this.credentials = next
      if (next.size === 0 && Object.keys(this.foreignEntries).length === 0) {
        await unlink(this.filename).catch(() => {})
        this.onChanged(providerId)
        return
      }
      await this.writeCredentials(next)
      this.onChanged(providerId)
    })
  }

  /** Replace the in-memory map from a fresh read; keeps the last good snapshot on failure. */
  async reload() {
    if (this.closed) return
    let text
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.credentials = new Map()
        return
      }
      throw error
    }
    try {
      const parsed = parseAuthDocument(text)
      this.credentials = parsed.credentials
      this.foreignEntries = parsed.foreign
    } catch (error) {
      this.onError(error)
    }
  }

  async writeCredentials(credentials) {
    const merged = {
      ...this.foreignEntries,
      ...Object.fromEntries(
        [...credentials.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, value]),
      ),
    }
    const document = { version: FORMAT_VERSION, credentials: merged }
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

  /** Enqueue one operation behind earlier ones; refresh and login writes serialize here. */
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

function credentialEquals(left, right) {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return JSON.stringify(left) === JSON.stringify(right)
}
