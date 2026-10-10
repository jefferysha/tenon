#!/usr/bin/env node
/**
 * `tenon setup --from-source` 的端到端验收：真实 claude / codex CLI，隔离 HOME、宿主配置目录、
 * TENON_RUNTIME_HOME、Dashboard 端口。夹具仓库是本 checkout 的发布内容拷出来的一个本地 git 仓库
 * （满足四项判据，被忽略的上游技能随 skills/ 一起带过去，所以默认不联网）。
 *
 * 每个宿主的步骤：
 *   1. tenon setup --<host> --from-source <fixture> --skip-build   -> exit 0
 *   2. tenon runtime status --json：active 带 devSource（realpath、commit），没有 stableTarget，runtime 有效
 *   3. <config>/install-channel 标记：channel=dev、repo、release_id 与 active 一致
 *   4. /api/health：channel=dev、7 位 commit、displayVersion=<version>+dev.<sha7>，version 字段不变
 *   5. tenon doctor --json（cwd=夹具）：identity:release 为 yellow 且写明开发安装，source:drift 为 green
 *   6. 经已装的稳定 tenon-hook 跑 session-start：工作区一致时没有 --from-source 提示
 *   7. 改夹具里的 hooks/gate.sh：session-start 出现 --from-source 提示，doctor 的 source:drift 变 yellow
 *   8. 重跑 setup（同一命令）：release 换新，提示消失，source:drift 回到 green
 *   9. tenon update --<host>：exit 1 并提示 --to-stable，active release 不变
 *  10. setup --from-source 与 --auto-update 同用：exit 1
 *
 * 切回正式版（update --to-stable、正式 setup 清标记）依赖本地 release 夹具与 GitHub API 桩，由
 * tools/runtime-update-rollback-acceptance.mjs 的同一套夹具负责；这里只验证开发安装一侧。
 * 本机没有的宿主跳过；CI 或显式 --host 时缺失即失败。TENON_ACCEPTANCE_KEEP=1 保留夹具。
 *
 *   node tools/source-install-acceptance.mjs [--host claude|codex|all] [--evidence <file>]
 */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FORCED_RELEASE_ENTRIES,
  LOCAL_RELEASE_ENTRIES,
  assertExternalStateUnchanged,
  assertSupportedAcceptancePlatform,
  cleanupIsolatedDashboardAfterFailure,
  installFakeBrowserOpener,
  parseJson,
  requireJsonObject,
  reservePort,
  runCommand,
  snapshotExternalTenonState,
  waitForHealth,
} from './clean-codex-install-acceptance.mjs'

const HOSTS = ['claude', 'codex']
/** 夹具 = 发布内容 + 根 package.json（四项判据之一）。 */
export const FIXTURE_ENTRIES = [...LOCAL_RELEASE_ENTRIES, 'package.json']

function must(condition, message) {
  if (!condition) throw new Error(message)
}

export function parseAcceptanceArgs(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  const host = value('--host') ?? 'all'
  if (host !== 'all' && !HOSTS.includes(host)) throw new Error(`unknown --host ${host}; expected all, claude or codex`)
  return { hosts: host === 'all' ? [...HOSTS] : [host], explicitHost: host !== 'all', evidence: value('--evidence') }
}

export async function hostAvailable(host) {
  const found = await runCommand('which', [host], { cwd: tmpdir(), env: process.env, timeoutMs: 10_000, allowFailure: true })
  return found.code === 0
}

/** 夹具仓库：拷出发布内容，git init + 提交（被忽略的上游技能随 skills/ 拷过去但不进提交）。返回 HEAD。 */
async function createSourceFixture(repoRoot, repo, env) {
  await mkdir(repo, { recursive: true })
  for (const entry of FIXTURE_ENTRIES) {
    await cp(join(repoRoot, entry), join(repo, entry), { recursive: true, preserveTimestamps: false })
  }
  const git = (args) => runCommand('git', args, { cwd: repo, env, timeoutMs: 60_000 })
  await git(['init', '--quiet', '-b', 'main'])
  await git(['config', 'user.name', 'Tenon source-install acceptance'])
  await git(['config', 'user.email', 'acceptance@invalid.example'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['add', '--all'])
  for (const entry of FORCED_RELEASE_ENTRIES) await git(['add', '--force', entry])
  await git(['commit', '--quiet', '-m', 'source install acceptance fixture'])
  return (await git(['rev-parse', 'HEAD'])).stdout.trim()
}

function hostEnv(host, fixture, port) {
  const home = join(fixture, 'home')
  const base = {
    HOME: home,
    TENON_RUNTIME_HOME: join(fixture, 'runtime'),
    TENON_DASHBOARD_PORT: String(port),
    PATH: `${join(fixture, 'fake-browser')}:${join(home, '.local/bin')}:${process.env.PATH}`,
    TENON_ACCEPTANCE_OPENED_URL: join(fixture, 'opened-url.txt'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CI: '1',
  }
  return host === 'claude'
    ? { ...base, CLAUDE_CONFIG_DIR: join(home, '.claude') }
    : { ...base, CODEX_HOME: join(home, '.codex') }
}

/** 一个宿主一份隔离夹具；无论成败都停掉本场景起的 Dashboard，并确认真实 Tenon 状态没动。 */
async function inFixture(host, body) {
  const externalBefore = await snapshotExternalTenonState(process.env)
  const track = { fixture: null, port: null, owned: null, started: false }
  let cleanupComplete = false
  let result = null
  try {
    const fixture = await mkdtemp(join(tmpdir(), 'tenon-source-install-'))
    track.fixture = fixture
    await Promise.all(['home', 'runtime', 'work'].map((name) => mkdir(join(fixture, name))))
    const port = await reservePort()
    track.port = port
    await installFakeBrowserOpener(join(fixture, 'fake-browser'))
    const env = hostEnv(host, fixture, port)
    // 真实 codex 要求 CODEX_HOME 事先存在（claude 会自己创建 CLAUDE_CONFIG_DIR）。
    await mkdir(env.CODEX_HOME ?? env.CLAUDE_CONFIG_DIR, { recursive: true })
    result = await body({
      fixture, env, port, work: join(fixture, 'work'), runtimeHome: join(fixture, 'runtime'),
      launcher: join(fixture, 'home', '.local', 'bin', 'tenon'),
      hook: join(fixture, 'home', '.local', 'bin', 'tenon-hook'),
      startInstallation: () => { track.started = true },
      ownDashboard: (health) => { track.owned = health },
    })
    cleanupComplete = true
  } finally {
    if (!track.started && track.owned === null) cleanupComplete = true
    if (track.port !== null && track.fixture !== null) {
      try {
        await cleanupIsolatedDashboardAfterFailure({ TENON_RUNTIME_HOME: join(track.fixture, 'runtime') }, track.port, track.owned)
        cleanupComplete = true
      } catch (error) {
        process.stderr.write(`[source-install] ${error.message}\n`)
      }
    }
    let externalError = null
    try {
      assertExternalStateUnchanged(externalBefore, await snapshotExternalTenonState(process.env))
    } catch (error) {
      externalError = error
    }
    const safePrefix = join(tmpdir(), 'tenon-source-install-')
    if (track.fixture !== null && cleanupComplete && externalError === null
      && track.fixture.startsWith(safePrefix) && process.env.TENON_ACCEPTANCE_KEEP !== '1') {
      await rm(track.fixture, { recursive: true, force: true })
    } else if (track.fixture !== null) {
      process.stderr.write(`[source-install] retained isolated fixture (${host}): ${track.fixture}\n`)
    }
    if (externalError !== null) throw externalError
  }
  if (result === null) throw new Error(`${host} produced no result`)
  return result
}

async function hostScenario(host, repoRoot, steps) {
  const cli = join(repoRoot, 'packages', 'cli', 'dist', 'tenon.mjs')
  return inFixture(host, async (ctx) => {
    const { env, work, fixture, port, runtimeHome } = ctx
    const record = (step) => { steps.push(step); process.stdout.write(`${JSON.stringify(step)}\n`) }
    const fixtureRepo = join(fixture, 'source-repo')
    const commit = await createSourceFixture(repoRoot, fixtureRepo, env)
    const repoReal = await realpath(fixtureRepo)
    const status = async () => requireJsonObject(parseJson(
      (await runCommand(ctx.launcher, ['runtime', 'status', '--json'], { cwd: work, env, timeoutMs: 60_000 })).stdout,
      'tenon runtime status',
    ), 'tenon runtime status')
    const doctor = async () => {
      const run = await runCommand(ctx.launcher, ['doctor', '--json'], { cwd: fixtureRepo, env, timeoutMs: 180_000, allowFailure: true })
      const checks = requireJsonObject(parseJson(run.stdout, 'tenon doctor'), 'tenon doctor').checks ?? []
      return (id) => checks.find((check) => check.id === id)
    }
    const sessionStart = async () => {
      const run = await runCommand('bash', [ctx.hook, 'session-start'], {
        cwd: fixtureRepo,
        env: { ...env, TENON_SESSION_START_FORMAT: 'plain' },
        input: JSON.stringify({ cwd: fixtureRepo }),
        timeoutMs: 120_000,
        allowFailure: true,
      })
      return `${run.stdout}\n${run.stderr}`
    }

    ctx.startInstallation()
    // 1. 安装
    const install = await runCommand('node', [cli, 'setup', `--${host}`, '--from-source', fixtureRepo, '--skip-build'], {
      cwd: work, env, timeoutMs: 900_000,
    })
    must(/源码开发安装/u.test(install.stdout), `the install did not announce a development install:\n${install.stdout}`)
    const health = await waitForHealth(port)
    ctx.ownDashboard(health)

    // 2. runtime 身份
    const first = await status()
    must(first.activeValid === true, 'the active runtime must verify after a source install')
    must(first.active?.devSource?.repoRealpath === repoReal, `devSource.repoRealpath ${first.active?.devSource?.repoRealpath} != ${repoReal}`)
    must(first.active.devSource.commit === commit, 'devSource.commit is not the fixture HEAD')
    must(first.active.stableTarget === undefined, 'a development release must not claim a stable target')
    record({ step: `${host} 1-2 install + runtime identity`, release: first.selection.activeRelease })

    // 3. 标记
    const marker = await readFile(join(runtimeHome, 'config', 'install-channel'), 'utf8')
    must(marker.includes('channel=dev') && marker.includes(`repo=${repoReal}`) && marker.includes(`release_id=${first.selection.activeRelease}`),
      `install-channel marker does not match the active release:\n${marker}`)

    // 4. health
    const body = requireJsonObject(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), 'health')
    must(body.channel === 'dev' && body.commit === commit.slice(0, 7), `health channel/commit wrong: ${JSON.stringify(body)}`)
    must(body.displayVersion === `${body.version}+dev.${commit.slice(0, 7)}`, `health displayVersion wrong: ${JSON.stringify(body)}`)

    // 5. doctor
    const checkOf = await doctor()
    must(checkOf('identity:release')?.status === 'yellow' && /开发安装/u.test(checkOf('identity:release').detail),
      `identity:release must be a yellow development-install warning, got ${JSON.stringify(checkOf('identity:release'))}`)
    must(checkOf('source:drift')?.status === 'green', `source:drift must start green, got ${JSON.stringify(checkOf('source:drift'))}`)

    // 6. 同步时 hook 沉默
    must(!(await sessionStart()).includes('--from-source'), 'session-start warned although the checkout is in sync')

    // 7. 改了安装内容之后 hook 与 doctor 都发现漂移
    const gate = join(fixtureRepo, 'hooks', 'gate.sh')
    await writeFile(gate, `${await readFile(gate, 'utf8')}\n# drift introduced by the acceptance\n`, 'utf8')
    const warned = await sessionStart()
    must(warned.includes(`tenon setup --${host} --from-source ${repoReal}`), `session-start did not report the drift:\n${warned}`)
    must((await doctor())('source:drift')?.status === 'yellow', 'source:drift must be yellow after editing installed content')
    record({ step: `${host} 3-7 marker, health, doctor, hook before and after a drift` })

    // 8. 重新同步
    await runCommand('node', [cli, 'setup', `--${host}`, '--from-source', fixtureRepo, '--skip-build'], { cwd: work, env, timeoutMs: 900_000 })
    // 新 release 起了新的 Dashboard 进程：清理要认这一份，不能拿第一次安装的身份去停它。
    ctx.ownDashboard(await waitForHealth(port))
    const second = await status()
    must(second.selection.activeRelease !== first.selection.activeRelease, 'the re-sync must activate a new release')
    must(!(await sessionStart()).includes('--from-source'), 'session-start still warns after the re-sync')
    must((await doctor())('source:drift')?.status === 'green', 'source:drift must be green again after the re-sync')

    // 9. update 默认拒绝
    const update = await runCommand(ctx.launcher, ['update', `--${host}`], { cwd: work, env, timeoutMs: 120_000, allowFailure: true })
    must(update.code === 1 && /--to-stable/u.test(update.stderr), `tenon update must refuse a development install:\n${update.stdout}\n${update.stderr}`)
    must((await status()).selection.activeRelease === second.selection.activeRelease, 'the refused update changed the active release')

    // 10. 选项冲突
    const conflict = await runCommand('node', [cli, 'setup', `--${host}`, '--from-source', fixtureRepo, '--auto-update'], {
      cwd: work, env, timeoutMs: 60_000, allowFailure: true,
    })
    must(conflict.code === 1 && /--auto-update/u.test(conflict.stderr), 'setup --from-source --auto-update must be refused')
    record({ step: `${host} 8-10 re-sync, update refusal, option conflict`, release: second.selection.activeRelease })
    return { ok: true }
  })
}

async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  assertSupportedAcceptancePlatform()
  const { hosts, explicitHost, evidence } = parseAcceptanceArgs(argv)
  const steps = []
  const ran = []
  for (const host of hosts) {
    if (!await hostAvailable(host)) {
      must(!explicitHost && process.env.CI === undefined, `${host} CLI is required (--host ${host} or CI) but is not on PATH`)
      process.stderr.write(`[source-install] SKIP ${host}: CLI not on PATH\n`)
      continue
    }
    await hostScenario(host, repoRoot, steps)
    ran.push(host)
  }
  must(ran.length > 0 || process.env.CI === undefined, 'no host CLI available in CI')
  const result = { ok: true, hosts: ran, steps }
  if (evidence !== undefined) await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, hosts: ran, steps: steps.length })}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[source-install] FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
