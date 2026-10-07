#!/usr/bin/env node
/**
 * `tenon update` then `tenon runtime repair --rollback` on a real Codex host, in an isolated HOME / CODEX_HOME / runtime.
 * Two scenarios, each in its own fixture:
 *
 * update-rollback: the current checkout, installed the way `npm run test:clean-install` does (install.sh --codex against a
 * local git release fixture), then the recovery path that the clean install never reaches:
 *   1. install build A                     -> runtime status: active A, no previous; doctor has no red check
 *   2. tenon update --codex (same build)   -> exit 0, "no update needed", the release id does not change
 *   3. build B appears (same version, changed CLI bytes: a newer build of the stable tag)
 *      tenon update --codex                -> exit 0, active B, previous A, Dashboard restarted on B
 *   4. tenon runtime repair --rollback     -> exit 0, active A again, previous B, both valid, no rollback journal left; doctor
 *                                             has no red check: identity:release is a warning that says the runtime was rolled
 *                                             back (the host plugin still carries build B, by design) and offers both ways out
 *   5. tenon update --codex                -> exit 0, active B again: the update after a rollback is not refused
 * After every step it re-reads `tenon runtime status --json` and `tenon doctor --json`; the steps that start a Dashboard also
 * check its health identity against the active release.
 *
 * wedge-recovery: an install that the released v0.3.1 wedged, then the way out with the current checkout (F18). The released
 * v0.3.1 is rebuilt from its git tag, installed, updated to a newer build, and its own `tenon runtime repair --rollback` is run:
 * that must refuse ("third-party launcher checkpoint") after the selection has flipped, leave the rollback journal behind, and
 * from then on `tenon runtime repair --rollback` and `tenon update` must refuse too. That is the real wedged state. Then the
 * current checkout is published as the fixing release and its `install.sh` is run (the documented way out: it does not go
 * through the stable launcher), which must finish the leftover rollback, activate the new release, install the fixed bootstrap,
 * leave the doctor without a red check, and from then on `tenon runtime repair --rollback` must succeed through the new bootstrap
 * and keep the launcher pair byte-identical.
 * It needs the v0.3.1 git tag. A checkout without tags skips it with a notice, except under CI or `--scenario wedge-recovery`,
 * where a missing tag fails.
 *
 * Offline for the release lookup: `tenon update` asks api.github.com for the latest stable release with Node's fetch. A
 * preload (NODE_OPTIONS=--import) answers that single URL with the fixture's version, so the walk neither needs the public
 * latest release to equal the checkout's version nor reaches GitHub for it; every other request goes to the real fetch.
 * Skill installation still clones the upstream skill repositories (as the clean install does), so this needs network.
 *
 * Nothing outside the fixture is touched: HOME, CODEX_HOME, TENON_RUNTIME_HOME and the Dashboard port are isolated, and the
 * script snapshots the real Tenon state before and after each scenario and fails if it moved (same guard as the clean install).
 * One JSON line per finished step goes to stdout as it happens, so a failure still shows how far the walk got.
 * `TENON_ACCEPTANCE_KEEP=1` keeps the isolated fixtures for inspection.
 *
 *   node tools/runtime-update-rollback-acceptance.mjs [--scenario update-rollback|wedge-recovery|all] [--evidence <file>]
 */
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  FORCED_RELEASE_ENTRIES,
  LOCAL_RELEASE_ENTRIES,
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
  writeReleaseCurlStub,
} from './clean-codex-install-acceptance.mjs'

const RELEASE_API = 'https://api.github.com/repos/jefferysha/tenon/releases/latest'
/** The newest release that still has the F18 defect: its bootstrap refuses the installer's launcher after flipping the selection. */
const WEDGED_RELEASE_TAG = 'v0.3.1'
const SCENARIOS = ['update-rollback', 'wedge-recovery']

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
  const bundle = join(work, 'packages', 'cli', 'dist', 'tenon.mjs')
  await writeFile(bundle, `${await readFile(bundle, 'utf8')}\n// acceptance build B: same version, newer bytes\n`, 'utf8')
  return commitAndPublish(fixture, env, version, `fixture v${version} build B`)
}

/** Replace the fixture's release tree with the checkout's and publish it under that checkout's stable tag. */
async function publishCheckoutRelease(fixture, env, repoRoot, version) {
  const work = join(fixture, 'release-work')
  for (const entry of await readdir(work)) {
    if (entry !== '.git') await rm(join(work, entry), { recursive: true, force: true })
  }
  for (const entry of LOCAL_RELEASE_ENTRIES) {
    await cp(join(repoRoot, entry), join(work, entry), { recursive: true, preserveTimestamps: false })
  }
  return commitAndPublish(fixture, env, version, `fixture v${version} (the release that fixes the rollback)`)
}

async function commitAndPublish(fixture, env, version, message) {
  const work = join(fixture, 'release-work')
  const bare = join(fixture, 'release.git')
  const git = (args) => runCommand('git', args, { cwd: work, env, timeoutMs: 60_000 })
  await git(['add', '--all'])
  for (const entry of FORCED_RELEASE_ENTRIES) await git(['add', '--force', entry])
  await git(['commit', '--quiet', '-m', message])
  await git(['tag', '--force', `v${version}`])
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  await git(['push', '--quiet', '--force', bare, `HEAD:refs/heads/${branch}`])
  await git(['push', '--quiet', '--force', bare, `refs/tags/v${version}`])
  return commit
}

/** `runtime status --json` and `doctor --json` through the installed launcher (doctor exits 1 when a check is red). */
async function readRuntime(launcher, env, cwd) {
  const runtime = await readRuntimeStatus(launcher, env, cwd)
  const doctorRun = await runCommand(launcher, ['doctor', '--json'], { cwd, env, timeoutMs: 120_000, allowFailure: true })
  const doctor = requireJsonObject(parseJson(doctorRun.stdout, 'tenon doctor'), 'tenon doctor')
  return { runtime, doctor, red: (doctor.checks ?? []).filter((check) => check.status === 'red').map((check) => check.id) }
}

async function readRuntimeStatus(launcher, env, cwd) {
  return requireJsonObject(parseJson((await runCommand(launcher, ['runtime', 'status', '--json'], { cwd, env, timeoutMs: 30_000 })).stdout, 'tenon runtime status'), 'tenon runtime status')
}

/** The two files `git archive` of a tag yields, unpacked: the released tree, byte for byte. */
async function extractTag(repoRoot, tag, destination) {
  await mkdir(destination, { recursive: true })
  const tarFile = join(dirname(destination), `${basename(destination)}.tar`)
  await runCommand('git', ['-C', repoRoot, 'archive', '--format=tar', '-o', tarFile, tag], { cwd: repoRoot, env: process.env, timeoutMs: 120_000 })
  await runCommand('tar', ['-xf', tarFile, '-C', destination], { cwd: repoRoot, env: process.env, timeoutMs: 120_000 })
}

async function tagAvailable(repoRoot, tag) {
  const result = await runCommand('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
    cwd: repoRoot,
    env: process.env,
    timeoutMs: 30_000,
    allowFailure: true,
  })
  return result.code === 0
}

/**
 * One scenario in its own isolated fixture: HOME, CODEX_HOME, TENON_RUNTIME_HOME, a random Dashboard port and a fake browser
 * opener. Whatever happens, the Dashboard this scenario started is stopped and the real Tenon state is checked to be unchanged.
 */
async function inFixture(name, body) {
  const externalBefore = await snapshotExternalTenonState(process.env)
  const track = { fixture: null, port: null, owned: null, installationStarted: false }
  let cleanupComplete = false
  let result = null
  try {
    const fixture = await mkdtemp(join(tmpdir(), 'tenon-clean-install-'))
    track.fixture = fixture
    const home = join(fixture, 'home')
    const codexHome = join(fixture, 'codex')
    const runtimeHome = join(fixture, 'runtime')
    const work = join(fixture, 'work')
    await Promise.all([mkdir(home), mkdir(codexHome), mkdir(runtimeHome), mkdir(work)])
    const port = await reservePort()
    track.port = port
    const inheritedPath = process.env.PATH
    must(inheritedPath !== undefined, 'PATH is required for real Codex acceptance')
    const fakeBrowserDir = join(fixture, 'fake-browser')
    await installFakeBrowserOpener(fakeBrowserDir)
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
    const stubbed = async (version) => {
      const stubFile = join(fixture, `latest-release-stub-${version}.mjs`)
      await writeFile(stubFile, fetchStubSource(version), 'utf8')
      return { ...env, NODE_OPTIONS: `--import=${pathToFileURL(stubFile).href}` }
    }
    const ctx = {
      name,
      fixture,
      home,
      runtimeHome,
      work,
      port,
      env,
      stubbed,
      launcher: join(home, '.local', 'bin', 'tenon'),
      journalPath: join(runtimeHome, 'state', 'managed-release-transaction', 'runtime-rollback.json'),
      bootstrapPath: join(runtimeHome, 'data', 'bootstrap', 'active.mjs'),
      startInstallation: () => { track.installationStarted = true },
      ownDashboard: (health) => { track.owned = health },
    }
    result = await body(ctx)
    await stopOwnedDashboard(port, track.owned).catch(() => undefined)
    cleanupComplete = true
  } finally {
    if (!track.installationStarted && track.owned === null) cleanupComplete = true
    if (!cleanupComplete && track.port !== null && track.fixture !== null) {
      try {
        await cleanupIsolatedDashboardAfterFailure({ TENON_RUNTIME_HOME: join(track.fixture, 'runtime') }, track.port, track.owned)
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
    if (track.fixture !== null && cleanupComplete && externalError === null && track.fixture.startsWith(safePrefix) && process.env.TENON_ACCEPTANCE_KEEP !== '1') {
      await rm(track.fixture, { recursive: true, force: true })
    } else if (track.fixture !== null) {
      process.stderr.write(`[update-rollback] retained isolated fixture (${name}): ${track.fixture}\n`)
    }
    if (externalError !== null) throw externalError
  }
  if (result === null) throw new Error(`${name} produced no result`)
  return result
}

/** Steps with the full clean-install assertions (verified active release, doctor without red, Dashboard identity). */
function stepRecorder(ctx, steps) {
  const record = (step) => {
    steps.push(step)
    process.stdout.write(`${JSON.stringify(step)}\n`)
  }
  const observe = async (name, extra = {}) => {
    const checked = await assertInstalledRuntime(ctx.env, ctx.work, ctx.port, ctx.ownDashboard)
    record({ step: name, ...summarize(checked.runtime, checked.doctor), dashboardPid: checked.health.pid, ...extra })
    return checked
  }
  return { record, observe }
}

async function updateRollbackScenario(repoRoot, version, steps) {
  return inFixture('update-rollback', async (ctx) => {
    const { env, work, launcher } = ctx
    const { record, observe } = stepRecorder(ctx, steps)
    const withStub = await ctx.stubbed(version)

    await createIsolatedReleaseRepository(repoRoot, ctx.fixture, env, version)
    ctx.startInstallation()

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
    const commit = await publishNewerBuild(ctx.fixture, env, version)
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
    must(!existsSync(ctx.journalPath), 'the rollback left its journal behind: setup and update would refuse')
    must(after.red.length === 0, `doctor has red checks after the rollback: ${after.red.join(', ')}`)
    // A rollback swaps only the managed runtime; the host plugin still carries build B. That is the state, not damage.
    const identity = (after.doctor.checks ?? []).find((check) => check.id === 'identity:release')
    must(identity?.status === 'yellow' && /已回滚到上一份 release/u.test(identity.detail),
      `identity:release must be a warning that names the rollback, got ${JSON.stringify(identity)}`)
    must(identity.hint.includes('tenon update --codex') && identity.hint.includes('tenon setup --codex'),
      `the identity:release warning must offer both ways out, got ${identity.hint}`)

    // 5. the update after a rollback is not refused: it returns to the newer release, which is what the warning says
    const forward = await runCommand(launcher, ['update', '--codex'], { cwd: work, env: withStub, timeoutMs: 600_000 })
    const c = await observe('5 tenon update --codex (return to the newer release)', { updateExit: forward.code })
    must(c.activeRelease === b.activeRelease, 'the update after the rollback did not return to build B')
    must(c.runtime.selection.previousRelease === a.activeRelease, 'the update after the rollback must keep build A as the previous release')
    return { ok: true }
  })
}

async function wedgeRecoveryScenario(repoRoot, version, steps) {
  const oldVersion = WEDGED_RELEASE_TAG.slice(1)
  return inFixture('wedge-recovery', async (ctx) => {
    const { env, work, launcher } = ctx
    const { record, observe } = stepRecorder(ctx, steps)
    const stubOld = await ctx.stubbed(oldVersion)
    const oldTree = join(ctx.fixture, 'wedged-release-tree')
    await extractTag(repoRoot, WEDGED_RELEASE_TAG, oldTree)

    await createIsolatedReleaseRepository(oldTree, ctx.fixture, env, oldVersion)
    ctx.startInstallation()

    // w1. the released v0.3.1 installs (build A), then updates to a newer build with its own CLI (build B)
    await installLocal(oldTree, env, work, oldVersion)
    const a = await observe(`w1 install ${WEDGED_RELEASE_TAG} (build A)`)
    const commitB = await publishNewerBuild(ctx.fixture, env, oldVersion)
    const update = await runCommand(launcher, ['update', '--codex'], { cwd: work, env: stubOld, timeoutMs: 600_000 })
    const b = await observe(`w2 ${WEDGED_RELEASE_TAG} tenon update --codex (newer build)`, { updateExit: update.code, bCommit: commitB })
    must(b.activeRelease !== a.activeRelease && b.runtime.selection.previousRelease === a.activeRelease, 'the v0.3.1 update must leave build A as the previous release')
    const launchersBefore = await readLaunchers(ctx)

    // w3. the defect: the v0.3.1 rollback refuses AFTER flipping the selection and leaves its journal, and every command after it refuses
    const wedge = await runCommand(launcher, ['runtime', 'repair', '--rollback'], { cwd: work, env, timeoutMs: 300_000, allowFailure: true })
    must(wedge.code === 1 && /rollback refuses a third-party launcher checkpoint: tenon/u.test(wedge.stderr),
      `the released ${WEDGED_RELEASE_TAG} bootstrap was expected to refuse its own launcher (exit ${wedge.code}):\n${wedge.stderr}`)
    const wedged = await readRuntimeStatus(launcher, env, work)
    must(wedged.selection.activeRelease === a.activeRelease && wedged.selection.previousRelease === b.activeRelease,
      'the wedge reproduction expected the selection to have flipped to build A before the refusal')
    must(existsSync(ctx.journalPath), 'the wedge reproduction expected the rollback journal to be left behind')
    const rollbackAgain = await runCommand(launcher, ['runtime', 'repair', '--rollback'], { cwd: work, env, timeoutMs: 300_000, allowFailure: true })
    const updateAgain = await runCommand(launcher, ['update', '--codex'], { cwd: work, env: stubOld, timeoutMs: 600_000, allowFailure: true })
    must(rollbackAgain.code !== 0, 'the wedged rollback was expected to refuse again')
    must(updateAgain.code !== 0 && /未完成的 runtime rollback/u.test(`${updateAgain.stdout}\n${updateAgain.stderr}`),
      `the wedged update was expected to refuse on the leftover rollback (exit ${updateAgain.code}):\n${updateAgain.stdout}\n${updateAgain.stderr}`)
    record({
      step: 'w3 wedged by the released rollback',
      rollbackExit: wedge.code,
      rollbackAgainExit: rollbackAgain.code,
      updateExit: updateAgain.code,
      active: wedged.selection.activeRelease,
      previous: wedged.selection.previousRelease,
      journal: true,
    })

    // w4. the way out: the fixing release's install.sh (it does not go through the stable launcher)
    const commitC = await publishCheckoutRelease(ctx.fixture, env, repoRoot, version)
    const realCurl = (await runCommand('which', ['curl'], { cwd: work, env: process.env, timeoutMs: 10_000 })).stdout.trim()
    await writeReleaseCurlStub(join(ctx.home, '.local', 'bin'), realCurl, `v${version}`, commitC)
    const recovery = await runCommand('bash', [join(repoRoot, 'install.sh'), '--codex', '--ref', `v${version}`], {
      cwd: work,
      env,
      timeoutMs: 600_000,
    })
    must(!existsSync(ctx.journalPath), 'the recovery install left the rollback journal behind')
    const c = await observe('w4 recovery: the fixing release install.sh', { installExit: recovery.code, cCommit: commitC })
    must(c.activeRelease !== a.activeRelease && c.activeRelease !== b.activeRelease, 'the recovery must activate the fixing release')
    must(c.runtime.selection.previousRelease === a.activeRelease, 'the recovery must keep the rolled-back-to release A as the previous release')
    must(c.runtime.previousValid === true, 'the previous release must stay valid after the recovery')
    must(await readFile(ctx.bootstrapPath, 'utf8') === await readFile(join(repoRoot, 'runtime', 'tenon-bootstrap.mjs'), 'utf8'),
      'the recovery did not install the checkout\'s bootstrap')
    const launchersRecovered = await readLaunchers(ctx)
    must(launchersRecovered.tenon.includes('export TENON_NODE_PATH=') && launchersRecovered.hook.includes('export TENON_NODE_PATH='),
      'the recovered launchers are not the installer launchers')

    // w5. the fixed bootstrap rolls back over the installer's launchers, and the launcher pair stays byte-identical
    const rollback = await runCommand(launcher, ['runtime', 'repair', '--rollback'], { cwd: work, env, timeoutMs: 300_000 })
    const rolledBack = await readRuntimeStatus(launcher, env, work)
    must(rolledBack.selection.activeRelease === a.activeRelease && rolledBack.selection.previousRelease === c.activeRelease,
      'the rollback after the recovery did not return to release A')
    must(rolledBack.activeValid === true && rolledBack.previousValid === true, 'both releases must stay valid after the rollback')
    must(!existsSync(ctx.journalPath), 'the rollback after the recovery left its journal behind')
    const launchersAfter = await readLaunchers(ctx)
    must(launchersAfter.tenon === launchersRecovered.tenon && launchersAfter.hook === launchersRecovered.hook,
      'the rollback rewrote the launcher pair: the bootstrap and the installer generate different bytes')
    record({
      step: 'w5 rollback through the fixed bootstrap',
      rollbackExit: rollback.code,
      active: rolledBack.selection.activeRelease,
      previous: rolledBack.selection.previousRelease,
      launchersIdentical: true,
      launchersBeforeRecovery: launchersBefore.tenon === launchersRecovered.tenon ? 'same' : 'rewritten',
    })
    return { ok: true }
  })
}

async function readLaunchers(ctx) {
  const bin = join(ctx.home, '.local', 'bin')
  return { tenon: await readFile(join(bin, 'tenon'), 'utf8'), hook: await readFile(join(bin, 'tenon-hook'), 'utf8') }
}

function selectedScenarios(argv) {
  const at = argv.indexOf('--scenario')
  const value = at === -1 ? 'all' : argv[at + 1]
  if (value === 'all') return { names: SCENARIOS, explicit: false }
  must(SCENARIOS.includes(value), `unknown --scenario ${String(value)}; expected all, ${SCENARIOS.join(' or ')}`)
  return { names: [value], explicit: true }
}

async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const evidenceAt = argv.indexOf('--evidence')
  const evidenceFile = evidenceAt === -1 ? null : argv[evidenceAt + 1]
  const version = requireJsonObject(JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')), 'root package manifest').version
  must(typeof version === 'string', 'root package version is invalid')
  assertSupportedAcceptancePlatform()
  const { names, explicit } = selectedScenarios(argv)

  const steps = []
  const ran = []
  for (const name of names) {
    if (name === 'wedge-recovery' && !await tagAvailable(repoRoot, WEDGED_RELEASE_TAG)) {
      must(!explicit && process.env.CI === undefined,
        `wedge-recovery needs the ${WEDGED_RELEASE_TAG} git tag; fetch tags (git fetch --tags) or use a full clone`)
      process.stderr.write(`[update-rollback] SKIP wedge-recovery: no ${WEDGED_RELEASE_TAG} git tag in this checkout (git fetch --tags)\n`)
      continue
    }
    if (name === 'update-rollback') await updateRollbackScenario(repoRoot, version, steps)
    else await wedgeRecoveryScenario(repoRoot, version, steps)
    ran.push(name)
  }
  const result = { ok: true, version, scenarios: ran, steps }
  if (evidenceFile !== null) await writeFile(evidenceFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, version, scenarios: ran, steps: steps.length })}\n`)
}

main().catch((error) => {
  process.stderr.write(`[update-rollback] FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
