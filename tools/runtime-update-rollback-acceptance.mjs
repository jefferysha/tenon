#!/usr/bin/env node
/**
 * `tenon update` then `tenon runtime repair --rollback` on a real Codex host, in an isolated HOME / CODEX_HOME / runtime.
 *
 * It installs the current checkout the same way `npm run test:clean-install` does (install.sh --codex against a local
 * git release fixture), then walks the recovery path that the clean install never reaches:
 *   1. install build A                     -> runtime status: active A, no previous; doctor has no red check
 *   2. tenon update --codex (same build)   -> exit 0, "no update needed", the release id does not change
 *   3. build B appears (same version, changed CLI bytes: a newer build of the stable tag)
 *      tenon update --codex                -> exit 0, active B, previous A, Dashboard restarted on B
 *   4. tenon runtime repair --rollback     -> exit 0, active A again, previous B, both valid; the launcher pair converged
 * After every step it re-reads `tenon runtime status --json` and `tenon doctor --json`; steps 1 to 3 also check the Dashboard
 * health identity against the active release. After step 4 the only red doctor check allowed is `identity:release`: a rollback
 * selects the previous managed runtime, but the native host plugin still carries build B, so the identity check reports the
 * difference by design (and offers `tenon update --codex`, which rolls forward again).
 *
 * Offline for the release lookup: `tenon update` asks api.github.com for the latest stable release with Node's fetch. A
 * preload (NODE_OPTIONS=--import) answers that single URL with the fixture's version, so the walk neither needs the public
 * latest release to equal the checkout's version nor reaches GitHub for it; every other request goes to the real fetch.
 * Skill installation still clones the upstream skill repositories (as the clean install does), so this needs network.
 *
 * Nothing outside the fixture is touched: HOME, CODEX_HOME, TENON_RUNTIME_HOME and the Dashboard port are isolated, and the
 * script snapshots the real Tenon state before and after and fails if it moved (same guard as the clean install).
 * One JSON line per finished step goes to stdout as it happens, so a failure still shows how far the walk got.
 * `TENON_ACCEPTANCE_KEEP=1` keeps the isolated fixture for inspection.
 *
 *   node tools/runtime-update-rollback-acceptance.mjs [--evidence <file>]
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  assertExternalStateUnchanged,
  assertSupportedAcceptancePlatform,
  assertCodexAuthGuidance,
  assertInstalledRuntime,
  cleanupIsolatedDashboardAfterFailure,
  createIsolatedReleaseRepository,
  installFakeBrowserOpener,
  installLocal,
  parseJson,
  requireJsonObject,
  reservePort,
  runCommand,
  snapshotExternalTenonState,
  stopOwnedDashboard,
} from './clean-codex-install-acceptance.mjs'

const RELEASE_API = 'https://api.github.com/repos/jefferysha/tenon/releases/latest'

/** Preload that answers the latest-stable-release lookup with the fixture's version; everything else is the real fetch. */
function fetchStubSource(version) {
  return `const real = globalThis.fetch
const release = ${JSON.stringify({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/jefferysha/tenon/releases/tag/v${version}`,
  })}
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === ${JSON.stringify(RELEASE_API)}) {
    return Promise.resolve(new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  return real(input, init)
}
`
}

function summarize(runtime, doctor) {
  return {
    active: runtime.selection?.activeRelease ?? null,
    previous: runtime.selection?.previousRelease ?? null,
    revision: runtime.selection?.revision ?? null,
    activeValid: runtime.activeValid === true,
    previousValid: runtime.previousValid === true,
    lastAudit: runtime.lastAudit?.kind ?? null,
    doctor: doctor.summary,
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message)
}

/** Build B: the same stable tag, newer content (a changed CLI bundle), published to the local git release fixture. */
async function publishNewerBuild(fixture, env, version) {
  const work = join(fixture, 'release-work')
  const bare = join(fixture, 'release.git')
  const git = (args) => runCommand('git', args, { cwd: work, env, timeoutMs: 60_000 })
  const bundle = join(work, 'packages', 'cli', 'dist', 'tenon.mjs')
  await writeFile(bundle, `${await readFile(bundle, 'utf8')}\n// acceptance build B: same version, newer bytes\n`, 'utf8')
  await git(['add', '--all'])
  await git(['commit', '--quiet', '-m', `fixture v${version} build B`])
  await git(['tag', '--force', `v${version}`])
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  await git(['push', '--quiet', '--force', bare, `HEAD:refs/heads/${branch}`])
  await git(['push', '--quiet', '--force', bare, `refs/tags/v${version}`])
  return commit
}

/** `runtime status --json` and `doctor --json` through the installed launcher (doctor exits 1 when a check is red). */
async function readRuntime(launcher, env, cwd) {
  const runtime = requireJsonObject(parseJson((await runCommand(launcher, ['runtime', 'status', '--json'], { cwd, env, timeoutMs: 30_000 })).stdout, 'tenon runtime status'), 'tenon runtime status')
  const doctorRun = await runCommand(launcher, ['doctor', '--json'], { cwd, env, timeoutMs: 120_000, allowFailure: true })
  const doctor = requireJsonObject(parseJson(doctorRun.stdout, 'tenon doctor'), 'tenon doctor')
  return { runtime, doctor, red: (doctor.checks ?? []).filter((check) => check.status === 'red').map((check) => check.id) }
}

async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const evidenceAt = argv.indexOf('--evidence')
  const evidenceFile = evidenceAt === -1 ? null : argv[evidenceAt + 1]
  const version = requireJsonObject(JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')), 'root package manifest').version
  must(typeof version === 'string', 'root package version is invalid')
  assertSupportedAcceptancePlatform()
  const externalBefore = await snapshotExternalTenonState(process.env)

  const steps = []
  let fixture = null
  let port = null
  let owned = null
  let cleanupComplete = false
  let installationStarted = false
  let result = null
  try {
    fixture = await mkdtemp(join(tmpdir(), 'tenon-clean-install-'))
    const home = join(fixture, 'home')
    const codexHome = join(fixture, 'codex')
    const runtimeHome = join(fixture, 'runtime')
    const work = join(fixture, 'work')
    await Promise.all([mkdir(home), mkdir(codexHome), mkdir(runtimeHome), mkdir(work)])
    port = await reservePort()
    const inheritedPath = process.env.PATH
    must(inheritedPath !== undefined, 'PATH is required for real Codex acceptance')
    const fakeBrowserDir = join(fixture, 'fake-browser')
    await installFakeBrowserOpener(fakeBrowserDir)
    const stubFile = join(fixture, 'latest-release-stub.mjs')
    await writeFile(stubFile, fetchStubSource(version), 'utf8')
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      TENON_RUNTIME_HOME: runtimeHome,
      TENON_DASHBOARD_PORT: String(port),
      PATH: `${fakeBrowserDir}:${join(home, '.local/bin')}:${inheritedPath}`,
      TENON_ACCEPTANCE_OPENED_URL: join(fixture, 'opened-url.txt'),
      LANG: process.env.LANG ?? 'C.UTF-8',
      CI: '1',
    }
    const launcher = join(home, '.local', 'bin', 'tenon')
    const withStub = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(stubFile).href}` }
    const track = (health) => { owned = health }
    const record = (step) => {
      steps.push(step)
      process.stdout.write(`${JSON.stringify(step)}\n`)
    }
    // Steps 1 to 3: the full clean-install assertions (verified active release, doctor without red, Dashboard identity).
    const observe = async (name, extra = {}) => {
      const checked = await assertInstalledRuntime(env, work, port, track)
      record({ step: name, ...summarize(checked.runtime, checked.doctor), dashboardPid: checked.health.pid, ...extra })
      return checked
    }

    await createIsolatedReleaseRepository(repoRoot, fixture, env, version)
    installationStarted = true

    // 1. install build A
    const install = await installLocal(repoRoot, env, work, version)
    assertCodexAuthGuidance(`${install.stdout}\n${install.stderr}`, 'install output')
    const a = await observe('1 install (build A)')
    must(a.runtime.selection.previousRelease === null, 'a clean install must have no previous release')

    // 2. update to the same build
    const same = await runCommand(launcher, ['update', '--codex'], { cwd: work, env: withStub, timeoutMs: 600_000 })
    must(/无需更新/u.test(same.stdout), `same-build update did not report "no update needed":\n${same.stdout}`)
    const afterSame = await observe('2 tenon update --codex (same build)', { updateExit: same.code })
    must(afterSame.activeRelease === a.activeRelease, 'same-build update changed the active release')
    must(afterSame.runtime.selection.previousRelease === null, 'same-build update must not create a previous release')

    // 3. update to a newer build (same stable tag, new content)
    const commit = await publishNewerBuild(fixture, env, version)
    const update = await runCommand(launcher, ['update', '--codex'], { cwd: work, env: withStub, timeoutMs: 600_000 })
    const b = await observe('3 tenon update --codex (newer build)', { updateExit: update.code, bCommit: commit })
    must(b.activeRelease !== a.activeRelease, 'update to a newer build did not activate a new release')
    must(b.runtime.selection.previousRelease === a.activeRelease, 'the update must keep build A as the previous release')
    must(b.runtime.previousValid === true, 'build A must be a valid rollback target after the update')

    // 4. rollback
    const rollback = await runCommand(launcher, ['runtime', 'repair', '--rollback'], { cwd: work, env, timeoutMs: 300_000 })
    must(rollback.stdout.includes(a.activeRelease), `rollback did not name release A:\n${rollback.stdout}`)
    const after = await readRuntime(launcher, env, work)
    record({ step: '4 tenon runtime repair --rollback', rollbackExit: rollback.code, ...summarize(after.runtime, after.doctor), red: after.red })
    must(after.runtime.selection.activeRelease === a.activeRelease, 'rollback did not reactivate build A')
    must(after.runtime.selection.previousRelease === b.activeRelease, 'rollback must keep build B as the previous release')
    must(after.runtime.activeValid === true && after.runtime.previousValid === true, 'both releases must stay valid after the rollback')
    must(after.red.every((id) => id === 'identity:release'), `doctor has red checks beyond the expected host-versus-runtime identity: ${after.red.join(', ')}`)

    await stopOwnedDashboard(port, owned).catch(() => undefined)
    cleanupComplete = true
    result = { ok: true, version, steps }
  } finally {
    if (!installationStarted && owned === null) cleanupComplete = true
    if (!cleanupComplete && port !== null && fixture !== null) {
      try {
        await cleanupIsolatedDashboardAfterFailure({ TENON_RUNTIME_HOME: join(fixture, 'runtime') }, port, owned)
        cleanupComplete = true
      } catch (error) {
        process.stderr.write(`[update-rollback] ${error.message}\n`)
      }
    }
    let externalError = null
    try {
      assertExternalStateUnchanged(externalBefore, await snapshotExternalTenonState(process.env))
    } catch (error) {
      externalError = error
    }
    const safePrefix = join(tmpdir(), 'tenon-clean-install-')
    if (fixture !== null && cleanupComplete && externalError === null && fixture.startsWith(safePrefix) && process.env.TENON_ACCEPTANCE_KEEP !== '1') {
      await rm(fixture, { recursive: true, force: true })
    } else if (fixture !== null) {
      process.stderr.write(`[update-rollback] retained isolated fixture: ${fixture}\n`)
    }
    if (externalError !== null) throw externalError
  }
  if (result === null) throw new Error('update/rollback acceptance produced no result')
  if (evidenceFile !== null) await writeFile(evidenceFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, version, steps: steps.length })}\n`)
}

main().catch((error) => {
  process.stderr.write(`[update-rollback] FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
