/**
 * afk run —— #29-wire 真接线 e2e（GOAL C9）：`tenon afk run` 不再只 report，真调
 * automation.runRound(createDockerRunChange(...)) 跑真容器 + 真 git worktree + 真 merge-back。
 *
 * 镜像同 dockerRunChange.integration.test.ts 用 `sandcastle:test`（同名同 Dockerfile，docker build
 * 天然幂等去重）；本文件**自足**真构建（不假设另一文件先跑过）——vitest 默认并行/乱序跑测试文件，
 * 依赖跨文件执行顺序会在 CI 上偶发假 honest-skip（docker 有、只是镜像还没建好）。
 * 无 docker → honest skip，绝不伪绿。
 */
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileEffectiveWorkflowPlan } from '@tenon/kernel'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from './integration-harness.js'

// afkloop 的 phases：下方 loops.yaml 与「子进程 HOME 里要装哪些技能」共用这一份，避免两处漂移。
const AFK_LOOP_PHASES = ['explore', 'build'] as const

/**
 * GOAL H · Stage C：afk run 现经 admission 权威闸门——change 必须归属到一个 active loop 才被 admit。
 * 本 loops.yaml + `afk enqueue --loop afkloop`（显式 change-loop-binding）让 e2e change 被 admit，
 * 顺带真跑通显式绑定 → admission ② → reserve → claim → run → settle 全链。
 *
 * H10 §1/§8任务7：`skill_bundle_id: _all` 是必填——缺省/null 会被 loop-admission.ts::reserveOnce
 * 的 unwired 硬闸拒绝（fail-closed，pause-loop），change 永远到不了 claim/prepareSkillBundle/
 * runChange，本文件下方对 automation 终态字段的断言会全部落空。`_all` 无需 isSkillProfileKnown
 * 装配即合法；下方 x/y/x2 三个 change 的当前 phase 均为 'build'。default coordinate 会携带
 * frozen `tenon-build` phase capability，显式 `_all` profile 只叠加其 named allowlist；本测试
 * 关注完整 AFK wiring/settle 链，不用 profile-only 空 bundle 绕过 phase 内容校验。
 */
const AFK_LOOPS_YAML = `version: 1
loops:
  - id: afkloop
    name: AFK Loop
    kind: orchestrator
    goal: run afk e2e changes reliably over time
    cadence: 1h
    risk: low
    runner: claude-code
    change_prefix: null
    skill_bundle_id: _all
    phases:
${AFK_LOOP_PHASES.map((phase) => `      - ${phase}`).join('\n')}
    human_gates:
      - verify
    state: .superpowers/loops/progress.md
    design_doc: docs/loops/afkloop.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 4
      on_exceed: skip
    kill_criteria:
      - no-change-3
    # G5：L3 必须显式声明产物路径；本 fixture 要继续走到 H7 verifier gate，而非先因空 allowlist conflict。
    allowlist:
      - .sandcastle-build/**
`

// AFK 资格只读分支的 automation.eligible：夹具工作流用一条声明了它的 backend 分支，而不是平铺。
const CUSTOM_BUILD_WORKFLOW = `name: h7s3-custom-workflow
interaction:
  version: v1
  mode: afk
tracks:
  backend:
    automation: { eligible: true }
    steps:
      - id: build
        label: Build
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

const AFK_BUILD_WORKFLOW_ID = 'afk-build-fixture'
const AFK_BUILD_WORKFLOW = `name: ${AFK_BUILD_WORKFLOW_ID}
interaction:
  version: v1
  mode: afk
tracks:
  backend:
    automation: { eligible: true }
    steps:
      - id: build
        label: Build
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

async function seedLoops(cwd: string): Promise<void> {
  await mkdir(join(cwd, '.pipeline'), { recursive: true })
  await writeFile(join(cwd, '.pipeline', 'loops.yaml'), AFK_LOOPS_YAML)
  await mkdir(join(cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(cwd, '.pipeline', 'workflows', `${AFK_BUILD_WORKFLOW_ID}.yaml`), AFK_BUILD_WORKFLOW)
}

const execFileAsync = promisify(execFile)
const IMAGE = 'sandcastle:test' // 与 dockerRunChange.integration.test.ts 同名同 Dockerfile，build 天然去重
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..') // src → cli → packages → 根
const bundlePath = join(repoRoot, 'packages', 'cli', 'dist', 'tenon.mjs')
const dockerfile = join(repoRoot, 'tools', 'sandcastle', 'Dockerfile')

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

interface BundleRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * afkloop 在 default 工作流（backend 分支，同 automation 的 LOOP_DEFAULT_TRACK）各 phase 声明的技能 id。
 * 不手抄清单：工作流 YAML 改了步骤技能，这里跟着变。`_all` profile 不会再叠加别的技能——CLI 的 resolver
 * 没有覆写 resolveExplicitProfile，resolveSkillBundle 只取计划冻结的步骤声明——所以只取 phases 对应的步骤。
 */
function loopSkillIds(): string[] {
  const { steps } = compileEffectiveWorkflowPlan('default', undefined, { track: 'backend' }).capabilities.skills
  const phases: readonly string[] = AFK_LOOP_PHASES
  const ids = [...new Set(steps.filter((step) => phases.includes(step.stepId)).flatMap((step) => step.requiredSkillIds))]
  if (ids.length === 0) throw new Error(`default 工作流 backend 分支在 ${phases.join('/')} 上没有声明任何技能，夹具无从安装`)
  return ids
}

/**
 * 给真实 CLI 子进程的隔离 HOME。AFK loop 接线核验（productionSkillContentRoots）按 `$HOME` 下的技能根定位 phase 声明的外部技能
 * （openspec-explore、brainstorming 等，只在正式安装包和开发机的技能目录里，源码仓 skills/ 没有）；继承宿主 HOME
 * 会让本测试只在装好技能的开发机上过、在干净的 CI 上失败。所以按真实安装的形状放占位技能：
 * `<home>/.agents/skills/<id>/SKILL.md`——skills CLI 的全局安装落点，Codex 与 Claude 两个 runner 档都读它，
 * 不绑死 loop 的 runner。定位器只认「根下有同名目录」，SKILL.md 带 name/description 是为了贴近真实形状。
 * 运行时根与身份不受 HOME 影响：TENON_RUNTIME_HOME / TENON_USER 由 vitest 隔离 setup 显式设置，
 * resolveProductPaths 里它们优先于从 HOME 派生的路径，下面 env 照旧继承。
 * docker CLI 的 context（本机 Docker Desktop / OrbStack 的 socket）记在 `$HOME/.docker`，HOME 换掉后会找不到 daemon，
 * 所以 DOCKER_CONFIG 钉回宿主的 docker 客户端配置（只含 docker 自己的配置，不涉及 Tenon / Claude / Codex 状态）。
 */
async function makeSkillHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'afk-run-home-'))
  for (const id of loopSkillIds()) {
    const dir = join(home, '.agents', 'skills', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: AFK 接线核验用的占位技能\n---\n\n占位内容，仅让技能定位器在隔离 HOME 里命中 ${id}。\n`)
  }
  return home
}

/** H14 digest 诚实门要求生产 run 必须来自真实 dist；不能再用源码内 buildProgram 冒充 bundle。 */
async function runBundle(cwd: string, args: readonly string[]): Promise<BundleRunResult> {
  const home = await makeSkillHome()
  try {
    const env = { ...process.env, HOME: home, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), '.docker') }
    const result = await execFileAsync(process.execPath, [bundlePath, ...args], { cwd, env })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? failed.message,
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

let hasImage = false

describe('afk run —— 真调 docker 执行接线（#29-wire 落地到 CLI）', () => {
  beforeAll(async () => {
    let hasDocker = false
    try {
      await execFileAsync('docker', ['info'])
      hasDocker = true
    } catch {
      console.warn('[HONEST SKIP] docker daemon 不可用 → afk run CLI e2e 跳过，绝不伪绿')
    }
    if (!hasDocker) return
    try {
      await access(bundlePath)
    } catch {
      console.warn('[HONEST SKIP] 缺 packages/cli/dist/tenon.mjs（先 npm run build）→ afk run CLI e2e 跳过')
      return
    }
    // docker build 对同 tag 天然幂等去重：若 dockerRunChange.integration.test.ts 已建过，这里秒过。
    await execFileAsync('docker', [
      'build', '-f', dockerfile, '-t', IMAGE,
      '--build-arg', 'WITH_CLAUDE_CODE=false',
      '--build-arg', 'TENON_TEST_ALLOW_DETERMINISTIC_FALLBACK=1',
      repoRoot,
    ]).catch(() => { /* 构建失败：下面 image inspect 会证实并 honest-skip */ })
    try {
      await execFileAsync('docker', ['image', 'inspect', IMAGE])
      hasImage = true
    } catch {
      console.warn('[HONEST SKIP] sandcastle:test 镜像构建失败 → afk run CLI e2e 跳过')
    }
  }, 300_000)

  let h: Harness
  beforeEach(async () => {
    if (!hasImage) return
    h = makeHarness(await mkdtemp(join(tmpdir(), 'afk-run-e2e-')))
    await git(h.cwd, ['init', '-q'])
    await git(h.cwd, ['config', 'user.email', 'test@pipeline.local'])
    await git(h.cwd, ['config', 'user.name', 'test'])
    await git(h.cwd, ['config', 'commit.gpgsign', 'false'])
  })
  afterEach(async () => {
    if (hasImage) await rm(h.cwd, { recursive: true, force: true })
  })

  /** H14 生产装配：冻结 AFK workflow 的命名分支经真实 Git verifier 后，L3 才允许 merge-back。 */
  it('L3 --image：真实 Git verifier 通过 → automation=merged，host base 与工作树均含产物', async (ctx) => {
    if (!hasImage) { ctx.skip(); return }
    await seedLoops(h.cwd)
    await h.run(['init', 'x', '--track', 'backend', '--preset', 'full', '--workflow', AFK_BUILD_WORKFLOW_ID])
    await git(h.cwd, ['add', '-A'])
    await git(h.cwd, ['commit', '-q', '-m', 'seed'])

    expect(await h.run(['afk', 'enqueue', 'x', '--loop', 'afkloop'])).toBe(0)
    const run = await runBundle(h.cwd, ['afk', 'run', '--level', 'L3', '--image', IMAGE])
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0)

    expect(await h.read('x')).toMatch(/^automation: merged$/m)
    expect(await h.read('x')).toMatch(/^automation_cause: ""$/m)
    let producedAtHead = false
    try {
      await execFileAsync('git', ['show', 'HEAD:.sandcastle-build/x.done'], { cwd: h.cwd })
      producedAtHead = true
    } catch {
      /* 断言会失败 */
    }
    expect(producedAtHead).toBe(true)
    let artifactExists = false
    try { await access(join(h.cwd, '.sandcastle-build', 'x.done')); artifactExists = true } catch { /* 断言会失败 */ }
    expect(artifactExists).toBe(true)
  }, 120_000)

  /**
   * H7+H10：custom workflow change 走真实 `tenon afk run` 全链（生产装配，非 SDK 直调）——
   * admission preparation 冻结 workflow/step/coordinate digest，Git verifier 必须把同一坐标签进
   * workflow-transition binding；只有该 binding 经 lifecycle 与 scheduler 双门复核后才可 merge。
   * 通过受支持的 `init --workflow` 原子绑定真实定义；运行中再用通用 field setter 把 default
   * Change 改成 custom 会破坏冻结的文档治理身份，因此必须 fail-closed。真正缺少 prepared
   * custom 坐标的反例由 dockerRunChange.integration.test.ts 保留。
   */
  it('custom workflow change + L3 --image：冻结坐标与 Git verifier binding 一致 → 真 merge，ledger 留完整 workflow-transition 证据', async (ctx) => {
    if (!hasImage) { ctx.skip(); return }
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'h7s3-custom-workflow.yaml'), CUSTOM_BUILD_WORKFLOW)
    expect(await h.run([
      'init', 'x2', '--track', 'backend', '--preset', 'full',
      '--workflow', 'h7s3-custom-workflow',
    ])).toBe(0)
    await seedLoops(h.cwd)
    await git(h.cwd, ['add', '-A'])
    await git(h.cwd, ['commit', '-q', '-m', 'seed'])

    expect(await h.run(['afk', 'enqueue', 'x2', '--loop', 'afkloop'])).toBe(0)
    const run = await runBundle(h.cwd, ['afk', 'run', '--level', 'L3', '--image', IMAGE])
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0)

    expect(await h.read('x2')).toMatch(/^automation: merged$/m)
    expect(await h.read('x2')).toMatch(/^automation_cause: ""$/m)
    const ledger = (await readFile(join(h.cwd, '.pipeline', 'loops', 'ledger.jsonl'), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const terminal = ledger.find((record) => record.kind === 'run' && record.change === 'x2')
    const verification = terminal?.verification as { binding?: Record<string, unknown> } | undefined
    expect(verification?.binding).toMatchObject({
      kind: 'workflow-transition', workflow: 'h7s3-custom-workflow', step: 'build', event: 'verify-pass',
    })
    expect(verification?.binding?.workflow_digest).toMatch(/^[0-9a-f]{64}$/)
    let producedAtHead = false
    try {
      await execFileAsync('git', ['show', 'HEAD:.sandcastle-build/x2.done'], { cwd: h.cwd })
      producedAtHead = true
    } catch {
      /* 断言会失败 */
    }
    expect(producedAtHead).toBe(true)
  }, 120_000)

  it('默认 L1 report-only：真容器跑成功但落 paused，不 merge', async (ctx) => {
    if (!hasImage) { ctx.skip(); return }
    await seedLoops(h.cwd)
    await h.run(['init', 'y', '--track', 'backend', '--preset', 'full', '--workflow', AFK_BUILD_WORKFLOW_ID])
    await git(h.cwd, ['add', '-A'])
    await git(h.cwd, ['commit', '-q', '-m', 'seed'])

    await h.run(['afk', 'enqueue', 'y', '--loop', 'afkloop'])
    const run = await runBundle(h.cwd, ['afk', 'run', '--image', IMAGE])
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0)

    const yaml = await h.read('y')
    expect(yaml).toMatch(/^automation: paused$/m)
    let leaked = false
    try { await access(join(h.cwd, '.sandcastle-build', 'y.done')); leaked = true } catch { /* 期望不存在 */ }
    expect(leaked).toBe(false)

    // Task 1 收尾缺口修复验证（.superpowers/sdd/task-1-report.md「Concerns」）：真 cmdAfk('run')
    // 全链（非 fake ports——这里是真 docker 容器 + 真 CLI argv 解析）应该把 automation_sandbox/
    // automation_worktree 真写回磁盘。此前 afk.ts 没把 deps.store 传进 createDockerRunChange，
    // ports.ts 的 setStateField 缺省 no-op，两个字段永远停在 init 时的 ""。
    expect(yaml).toMatch(/^automation_sandbox: sandcastle-/m)
    expect(yaml).not.toMatch(/^automation_worktree: ""$/m)
  }, 120_000)

  it('就绪队列为空 → 诚实报告，不起容器', async (ctx) => {
    if (!hasImage) { ctx.skip(); return }
    await h.run(['init', 'z', '--track', 'backend', '--preset', 'full']) // 相位仍 open，非 build → 不就绪
    expect(await h.run(['afk', 'run', '--image', IMAGE])).toBe(0)
    expect(h.out.join('\n')).toContain('就绪队列空')
  })
})

describe('afk run —— 无 docker 环境诚实降级（不依赖 IMAGE 探针，真跑 docker info）', () => {
  it('docker 不可用 → 报告就绪队列 + 明示不执行容器，exit 1', async (ctx) => {
    // 只有在这台机器确实没有 docker 时才有意义；有 docker 时这个分支在别的机器上验证，本地不強跑。
    try {
      await execFileAsync('docker', ['info'])
      ctx.skip() // 本机有 docker：诚实分支交给没有 docker 的机器验证，避免本用例假造缺失
      return
    } catch { /* 真无 docker，继续 */ }
    const h2 = makeHarness(await mkdtemp(join(tmpdir(), 'afk-run-nodocker-')))
    try {
      await seedLoops(h2.cwd)
      await h2.run(['init', 'c1', '--track', 'backend', '--preset', 'full', '--workflow', AFK_BUILD_WORKFLOW_ID])
      expect(await h2.run(['afk', 'enqueue', 'c1', '--loop', 'afkloop'])).toBe(0)
      expect(await h2.run(['afk', 'run'])).toBe(1)
      expect(h2.err.join('\n')).toMatch(/docker/i)
    } finally {
      await rm(h2.cwd, { recursive: true, force: true })
    }
  })
})
