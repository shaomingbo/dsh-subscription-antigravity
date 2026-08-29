import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, parseArgs, applyManifest, removeManifest, describeStatus, PACKAGE_NAME } from '../bin/install.js'

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-subscription-antigravity-home-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function writeProfile(home, profile = 'web', manifest = {}) {
  const profileDir = join(home, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return profileDir
}

function readProfile(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

const failingInstall = async () => { throw new Error('pnpm exploded') }
const okInstall = async () => {}

test('parseArgs defaults to install on the web profile with the pinned source', () => {
  const options = parseArgs([])
  assert.equal(options.command, 'install')
  assert.equal(options.profile, 'web')
  assert.equal(options.source, `github:shaomingbo/${PACKAGE_NAME}#v0.2.0`)
  assert.throws(() => parseArgs(['--profile']), /require values/)
  assert.throws(() => parseArgs(['bogus']), /unknown argument/)
  assert.throws(() => parseArgs(['install', 'status']), /unexpected argument/)
  assert.equal(parseArgs(['uninstall']).command, 'uninstall')
  assert.equal(parseArgs(['--help']).help, true)
})

test('the default source is pinned to a SemVer tag, never a branch or latest', () => {
  const source = parseArgs([]).source
  assert.match(source, /#v\d+\.\d+\.\d+$/)
  assert.doesNotMatch(source, /#(main|master|latest)$/)
})

test('applyManifest/removeManifest/describeStatus edit only the two allowed slots', () => {
  const manifest = {
    name: 'profile',
    dependencies: { '@deepseek-ai/dsh-web-app': 'catalog:' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] }, other: { keep: true } },
  }
  const applied = applyManifest(manifest, 'link:/tmp/x')
  assert.equal(applied.dependencies[PACKAGE_NAME], 'link:/tmp/x')
  assert.deepEqual(applied.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app', PACKAGE_NAME])
  assert.deepEqual(applied.dsh.other, { keep: true })
  assert.equal(describeStatus(applied).installed, true)

  const removed = removeManifest(applied)
  assert.equal(describeStatus(removed).installed, false)
  assert.ok(!(`${PACKAGE_NAME}` in removed.dependencies))
  assert.deepEqual(removed.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app'])
})

test('install is idempotent; status reports; uninstall removes; credentials survive', async () => {
  const env = tempHome()
  try {
    const profileDir = writeProfile(env.home)
    const argv = ['--source', 'link:/tmp/dsh-subscription-antigravity']

    await run(argv, { home: env.home, installDeps: okInstall })
    await run(argv, { home: env.home, installDeps: okInstall })
    let manifest = readProfile(profileDir)
    assert.equal(describeStatus(manifest).installed, true)
    assert.deepEqual(manifest.dsh.profile.bundles.filter((name) => name === PACKAGE_NAME), [PACKAGE_NAME])

    await run(['status', '--source', 'x'], { home: env.home, installDeps: okInstall })
    assert.equal(process.exitCode ?? 0, 0)
    process.exitCode = undefined

    await run(['uninstall'], { home: env.home, installDeps: okInstall })
    manifest = readProfile(profileDir)
    assert.equal(describeStatus(manifest).installed, false)

    await run(['uninstall'], { home: env.home, installDeps: okInstall }) // idempotent
  } finally {
    env.cleanup()
  }
})

test('install into a non-default profile targets that profile only', async () => {
  const env = tempHome()
  try {
    const webDir = writeProfile(env.home, 'web')
    const headlessDir = writeProfile(env.home, 'headless')
    await run(['--profile', 'headless', '--source', 'link:/tmp/x'], { home: env.home, installDeps: okInstall })
    assert.equal(describeStatus(readProfile(headlessDir)).installed, true)
    assert.equal(describeStatus(readProfile(webDir)).installed, false)
  } finally {
    env.cleanup()
  }
})

test('the DSH_ANTIGRAVITY_SOURCE environment variable overrides the source', () => {
  const previous = process.env.DSH_ANTIGRAVITY_SOURCE
  process.env.DSH_ANTIGRAVITY_SOURCE = 'link:/Users/me/open-source/dsh-subscription-antigravity'
  try {
    assert.equal(parseArgs([]).source, 'link:/Users/me/open-source/dsh-subscription-antigravity')
  } finally {
    if (previous === undefined) delete process.env.DSH_ANTIGRAVITY_SOURCE
    else process.env.DSH_ANTIGRAVITY_SOURCE = previous
  }
})

test('dependency-install failure rolls the manifest back', async () => {
  const env = tempHome()
  try {
    const original = { dependencies: { a: '1' }, dsh: { profile: { bundles: ['a'] } } }
    const profileDir = writeProfile(env.home, 'web', original)
    await assert.rejects(
      () => run(['--source', 'link:/tmp/x'], { home: env.home, installDeps: failingInstall }),
      /pnpm exploded/,
    )
    assert.deepEqual(readProfile(profileDir), original)
  } finally {
    env.cleanup()
  }
})

test('uninstall failure rolls the manifest back', async () => {
  const env = tempHome()
  try {
    const original = applyManifest({ dependencies: {}, dsh: { profile: { bundles: [] } } }, 'github:x#v1')
    const profileDir = writeProfile(env.home, 'web', original)
    await assert.rejects(
      () => run(['uninstall'], { home: env.home, installDeps: failingInstall }),
      /pnpm exploded/,
    )
    assert.deepEqual(readProfile(profileDir), original)
  } finally {
    env.cleanup()
  }
})

test('status fails with exit code 1 when not installed', async () => {
  const env = tempHome()
  try {
    writeProfile(env.home)
    await run(['status'], { home: env.home, installDeps: okInstall })
    assert.equal(process.exitCode, 1)
    process.exitCode = undefined
  } finally {
    env.cleanup()
  }
})

test('malformed manifest and missing profile produce clear errors', async () => {
  const env = tempHome()
  try {
    const profileDir = writeProfile(env.home)
    writeFileSync(join(profileDir, 'package.json'), '{not json')
    await assert.rejects(() => run([], { home: env.home, installDeps: okInstall }))
    await assert.rejects(() => run(['--profile', 'missing'], { home: env.home, installDeps: okInstall }), /ENOENT/)
  } finally {
    env.cleanup()
  }
})
