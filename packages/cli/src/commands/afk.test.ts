/**
 * cmdAfk('run') · image 三段链路证据（T21 评审 major 缺口）——automation.json 的 image 真流进
 * dockerRunChange 的 docker run argv，而不是只停在 afk.ts:124 那行三元表达式里。
 *
 * 背景：`opts.image ?? readAutomationJson(deps.cwd).image ?? DEFAULT_SANDCASTLE_IMAGE` 是 UI
 * 沙箱镜像输入框真实生效的唯一接线。--image 显式段已有 afk-run.integration.test.ts 真容器覆盖，
 * 但 automation.json 段此前零覆盖——若 root 取错或键名漂移（同 Task 1「store 没接线」先例），
 * image 会静默回落默认、输入框变假而无测试抓红。
 *
 * 打桩口径同 dockerRunChange.test.ts 的 makeFakeExec（fake exec 只省掉真 docker/git 子进程，
 * 装配链路 createAutomation → runRound → createDockerRunChange → runChangeInSandbox 全真）：
 *   · vi.mock 动三点——dockerAvailable 恒 true（本测试不问 docker 探针，问的是 image 来源），
 *     createDockerRunChange 包一层注入 fake exec（opts 原样透传，image 由被测代码决定），
 *     createAutomation 包一层注入 test-only 的 preparation 兜底（见下方注释）；
 *   · readAutomationJson / runRound / runChangeInSandbox 全部走真实现；
 *   · deps.cwd 真临时 git 仓（currentBranch 真跑 `git branch --show-current`），
 *     .pipeline/automation.json 真落盘（readAutomationJson 真读文件，不 fake fs）。
 *
 * H10 §1/§5 + 二次任务（queued 卡死回归修复）交叉边界：下方 W_LOOPS_YAML 的 loop 现须携带
 * `skill_bundle_id: '_all'` 才能过 admission 的「unwired」硬闸（该闸与本文件测的 image/凭证
 * 链路无关，是更早的 H10 §1 既有行为）。但 `_all` 意味着 context 是「bundle 绑定」，按
 * sdk.ts::createDefaultExecutionPreparation 的诚实处置，真实生产 `tenon afk run` 此刻会对
 * 它 fail-loud（本包尚无真实 resolver/locator/coordinates 装配，H10 生产装配见任务7——cli/afk.ts
 * 的 cmdAfk 生产路径未变，仍会 fail-loud，这不是本文件绕过的对象）。本文件只关心「image/凭证是否
 * 真进 docker argv」这条与 skill bundle 完全正交的链路，故在 vi.mock 里为 createAutomation 包一层
 * test-only 直通 preparation（等价于「假装 skill bundle 已 prepare 成功」），隔离两个关注点——
 * 不改任何生产代码/生产默认行为，也不越权替本任务实现任务7。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCanonicalManifest, skillActionAuthorityContract } from '@tenon/automation'
import {
  compileEffectiveWorkflowPlan, createLoopLedgerStore, emptyFields, loadRegistry, workflowPlanSnapshot,
} from '@tenon/kernel'
import { publishInitialRunRevision } from '../../../kernel/src/state/run-revision-store.js'
import { makeDeps, mockAfkState, mockState } from '../test-support.js'
import { buildProgram, CliExit } from '../program.js'
import { cmdAfk, probeGitCommitAncestry } from './afk.js'

const execFileAsync = promisify(execFile)
const SHA = 'a'.repeat(40)

async function initializeCanonicalStepVisit(cwd: string, change = 'w'): Promise<void> {
  const fields = emptyFields()
  fields.phase = 'build'
  // Keep the on-disk canonical StepVisit aligned with mockAfkState's frozen WorkflowRun.
  // The production lifecycle binds evidence to both identities.
  fields.workflow = 'default'
  fields.track = 'backend'
  await publishInitialRunRevision(join(cwd, 'openspec', 'changes', change), {
    fields,
    runMetadata: { runId: 'mock-run', transitionSequence: 0, transitionHead: undefined },
    opaqueTail: '',
  }, '2026-08-04T00:00:00.000Z')
}

/**
 * Hermetic bundled content for legacy AFK argv fixtures. The production preparation and locator
 * remain real; only the temporary test plugin supplies the Skills default declares at `build` and
 * `ship`, which neither Linux CI nor this repository can assume are materialized on the host.
 */
async function seedDefaultPhaseSkills(
  cwd: string,
  ids: readonly string[] = ['test-driven-development', 'finishing-a-development-branch'],
): Promise<string> {
  const pluginRoot = join(cwd, '.test-plugin')
  const registryRows: string[] = []
  for (const skill of ids) {
    const skillDir = join(pluginRoot, 'skills', skill)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `# hermetic ${skill} fixture\n`, 'utf8')
    const manifest = await buildCanonicalManifest(skill, skillDir)
    const digest = `sha256:${manifest.treeSha256}`
    registryRows.push(
      `  ${skill}: { tool: bundled, source: tenon, content_skill: ${skill}, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/${skill}, content_hash: ${digest}, coordinate: tenon:skills/${skill}@${digest} }`,
    )
  }
  await mkdir(join(pluginRoot, 'templates'), { recursive: true })
  await writeFile(join(pluginRoot, 'templates', 'skill-sources.yaml'), [
    'version: 3',
    'hash_algorithm: tree-sha256-v1',
    'skills:',
    ...registryRows,
    '',
  ].join('\n'), 'utf8')
  return pluginRoot
}

/** fake exec 的 argv 记录（vi.mock 工厂被 hoist，必须用 vi.hoisted 共享可变引用）。 */
const h = vi.hoisted(() => ({ calls: [] as string[][], executorCalls: 0, dockerAvailable: true }))

vi.mock('@tenon/automation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tenon/automation')>()
  // 同 dockerRunChange.test.ts::makeFakeExec：docker exec 回合法握手让全程真跑完，
  // git rev-list / rev-parse 借同一 SHA——不起任何真容器/真 git 子进程。
  const fakeExec: typeof actual.nodeExec = async (file, args) => {
    h.calls.push([file, ...args])
    if (file === 'docker' && args[0] === 'exec') {
      return { stdout: `<output>{"verify_result":"pass","build_sha":"${SHA}","phase_event":"build-complete"}</output>\n`, stderr: '', exitCode: 0 }
    }
    if (file === 'git' && args.includes('diff') && args.includes('--name-only')) {
      return { stdout: 'src/change.ts\n', stderr: '', exitCode: 0 }
    }
    return { stdout: `${SHA}\n`, stderr: '', exitCode: 0 }
  }
  return {
    ...actual,
    dockerAvailable: async () => h.dockerAvailable,
    createDockerRunChange: (opts: Parameters<typeof actual.createDockerRunChange>[0]) =>
      actual.createDockerRunChange({ ...opts, exec: fakeExec }),
    // test-only：见本文件头注「H10 §1/§5 + 二次任务交叉边界」——本文件与 skill bundle 内容无关，
    // 直通放行让 round 走到 runChange，不改 cli/afk.ts 生产路径本身（它仍会用 sdk.ts 的诚实缺省）。
    createAutomation: (deps: Parameters<typeof actual.createAutomation>[0]) =>
      actual.createAutomation({
        ...deps,
        preparation: deps.preparation ?? { prepare: async (ctx) => ({ ok: true, context: { ...ctx } }) },
      }),
  }
})

// H14：cmdAfk 必须走真实共享 executor；单测显式注入一个测试 bundle digest，避免把本测试源码
// 的 SHA 冒充镜像期望。其余 runtime 全走生产默认与上方 automation fake。
vi.mock('./afk-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./afk-executor.js')>()
  return {
    ...actual,
    runAfkRound: async (
      deps: Parameters<typeof actual.runAfkRound>[0],
      options: Parameters<typeof actual.runAfkRound>[1],
      runtime: Parameters<typeof actual.runAfkRound>[2] = {},
    ) => {
      h.executorCalls += 1
      return actual.runAfkRound(deps, options, {
        ...runtime,
        resolveCliDistSha256: async () => 'b'.repeat(64),
      })
    },
  }
})

describe('probeGitCommitAncestry · git merge-base --is-ancestor 三态映射', () => {
  it('exit 0 → true（祖先关系已由真命令语义证明）', async () => {
    const calls: string[][] = []
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args])
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    await expect(probeGitCommitAncestry('/repo', 'MERGED_M', 'CURRENT_N', exec)).resolves.toBe(true)
    expect(calls).toEqual([['git', 'merge-base', '--is-ancestor', 'MERGED_M', 'CURRENT_N']])
  })

  it('exit 1 → false（Git 明确表示不是祖先）', async () => {
    const exec = async () => ({ stdout: '', stderr: '', exitCode: 1 })
    await expect(probeGitCommitAncestry('/repo', 'MERGED_M', 'DIVERGED_N', exec)).resolves.toBe(false)
  })

  it('exit 128 等命令错误 → throw，绝不伪装成 false', async () => {
    const exec = async () => ({ stdout: '', stderr: 'fatal: bad object MERGED_M', exitCode: 128 })
    await expect(probeGitCommitAncestry('/repo', 'MERGED_M', 'CURRENT_N', exec))
      .rejects.toThrow(/merge-base.*128.*bad object/i)
  })
})

/** 本轮 fake exec 记录里的 `docker run` argv（join 成串好做 contains 断言）。 */
const dockerRunArgv = (): string => {
  const call = h.calls.find((c) => c[0] === 'docker' && c[1] === 'run')
  expect(call, 'runRound 应真调到 docker run（fake exec 记录）').toBeDefined()
  return call!.join(' ')
}

async function runCli(deps: ReturnType<typeof makeDeps>, args: string[]): Promise<number> {
  try {
    await buildProgram(deps).parseAsync(args, { from: 'user' })
    return 0
  } catch (error) {
    if (error instanceof CliExit) return error.code
    throw error
  }
}

function withEnterAfkSkillAuthority(deps: ReturnType<typeof makeDeps>) {
  deps.resolveSkillActionAuthority = async (query) =>
    skillActionAuthorityContract(query, ['enter-afk'])
  return deps
}

/**
 * GOAL H · Stage C：run 路径现经 admission 权威闸门——change 必须归属到一个 active loop 才被 admit
 * （无 loop 语境 fail-closed，不再静默跑）。本 loops.yaml 让 change 'w'（change_prefix 'w' 命中）
 * 被 admit，从而 docker run 真发生、image/凭证断言仍成立（隔离 admission 变更对既有 image/cred 断言的影响）。
 *
 * H10 §1：`skill_bundle_id: _all` 是必填——缺省/null 会被 loop-admission.ts::reserveOnce 的
 * unwired 硬闸拒绝（fail-closed，pause-loop），change 永远到不了 claim/runChange，本文件的
 * image/凭证断言会全部落空（见本文件头注「H10 §1/§5 + 二次任务交叉边界」，vi.mock 里的
 * test-only preparation 兜底正是为此而设）。
 */
const W_LOOPS_YAML = `version: 1
loops:
  - id: wloop
    name: W Loop
    kind: orchestrator
    goal: keep w changes healthy over time
    cadence: 1h
    risk: low
    runner: claude-code
    change_prefix: w
    skill_bundle_id: _all
    phases:
      - build
      - ship
    human_gates:
      - ship
    allowlist:
      - src/**
    state: .superpowers/loops/progress.md
    design_doc: docs/loops/wloop.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 4
      on_exceed: skip
    kill_criteria:
      - no-change-3
`

describe("tenon afk run · H14 r1 P1-2 Docker 不可用退出码", () => {
  let cwd: string
  let pluginRoot: string

  beforeEach(async () => {
    h.calls.length = 0
    h.executorCalls = 0
    h.dockerAvailable = false
    cwd = await mkdtemp(join(tmpdir(), 'afk-docker-unavailable-'))
    await execFileAsync('git', ['init', '-q'], { cwd })
    await mkdir(join(cwd, 'openspec', 'changes', 'w'), { recursive: true })
    await initializeCanonicalStepVisit(cwd)
    pluginRoot = await seedDefaultPhaseSkills(cwd)
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'loops.yaml'), W_LOOPS_YAML)
  })

  afterEach(async () => {
    h.dockerAvailable = true
    await rm(cwd, { recursive: true, force: true })
  })

  const deps = () =>
    withEnterAfkSkillAuthority(makeDeps({
      cwd, doctor: { pluginRoot }, states: { w: mockAfkState({ phase: 'build', automation: 'queued' }) },
    }))

  it('文本模式真实 CLI 分派：ready 非空但 Docker 不可用 → exit 1，诚实文案不能伪装成功', async () => {
    const d = deps()

    expect(await runCli(d, ['afk', 'run'])).toBe(1)
    expect(d.errLines.join('\n')).toMatch(/docker daemon|不执行容器/i)
    expect(d.outLines.join('\n')).not.toContain('跑完一轮')
  })

  it('--json 真实 CLI 分派：同一失败仍 exit 1，并输出机器可判定的失败对象而非成功文案', async () => {
    const d = deps()

    expect(await runCli(d, ['afk', 'run', '--json'])).toBe(1)
    expect(d.errLines).toEqual([])
    expect(d.outLines).toHaveLength(1)
    expect(JSON.parse(d.outLines[0]!)).toMatchObject({
      ok: false,
      status: 'docker-unavailable',
      level: 'L1',
      image: 'sandcastle:local',
      ready: ['w'],
    })
  })

  it('真实 CLI 分派：确实没有 ready candidate 的 empty 才保持 exit 0', async () => {
    // `runAfkRound` validates active-loop wiring before scanning the queue. Keep this true-empty
    // fixture hermetic too: without the temporary plugin root, a host-installed phase Skill can
    // make local runs pass while a clean Linux runner fails closed before reaching the empty path.
    const d = withEnterAfkSkillAuthority(makeDeps({
      cwd,
      doctor: { pluginRoot },
      states: { w: mockState({ phase: 'open', automation: 'queued' }) },
    }))

    expect(await runCli(d, ['afk', 'run'])).toBe(0)
    expect(d.outLines.join('\n')).toContain('就绪队列空')
    expect(h.calls.some((call) => call[0] === 'docker')).toBe(false)
  })
})

describe("cmdAfk('run') · image 同源三段链路（--image > automation.json > 内置默认）", () => {
  let cwd: string
  let pluginRoot: string
  beforeEach(async () => {
    h.calls.length = 0
    h.executorCalls = 0
    cwd = await mkdtemp(join(tmpdir(), 'afk-image-src-'))
    // currentBranch 真跑 git branch --show-current（unborn 分支也返回分支名，无需 commit）
    await execFileAsync('git', ['init', '-q'], { cwd })
    // scanReadyFromFs 真 readdir openspec/changes/*；字段值由 makeDeps 的 mockStore 供给
    await mkdir(join(cwd, 'openspec', 'changes', 'w'), { recursive: true })
    await initializeCanonicalStepVisit(cwd)
    pluginRoot = await seedDefaultPhaseSkills(cwd)
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'loops.yaml'), W_LOOPS_YAML)
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const deps = () =>
    withEnterAfkSkillAuthority(makeDeps({
      cwd, doctor: { pluginRoot }, states: { w: mockAfkState({ phase: 'build', automation: 'queued' }) },
    }))

  it('第二段（评审缺口）：无 --image 时 .pipeline/automation.json 的 image 真进 docker run argv', async () => {
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'automation.json'), JSON.stringify({ image: 'sandcastle:from-file' }, null, 2))

    const d = deps()
    expect(await cmdAfk(d, 'run', undefined, {}), d.errLines.join('\n')).toBe(0)

    expect(h.executorCalls).toBe(1)
    expect(dockerRunArgv()).toContain('sandcastle:from-file')
    expect(d.outLines.join('\n')).toContain('image=sandcastle:from-file')
  })

  it('第一段优先级：--image 显式覆盖 automation.json 的 image', async () => {
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'automation.json'), JSON.stringify({ image: 'sandcastle:from-file' }, null, 2))

    const d = deps()
    expect(await cmdAfk(d, 'run', undefined, { image: 'sandcastle:explicit' })).toBe(0)

    const argv = dockerRunArgv()
    expect(argv).toContain('sandcastle:explicit')
    expect(argv).not.toContain('sandcastle:from-file')
  })

  it('第三段兜底：无 --image 且无 automation.json → 内置 sandcastle:local', async () => {
    const d = deps()
    expect(await cmdAfk(d, 'run', undefined, {})).toBe(0)
    expect(dockerRunArgv()).toContain('sandcastle:local')
  })

  it('文件 image 非法（值域被 readAutomationJson 丢弃）→ 回落内置默认，不把脏值灌进 docker', async () => {
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'automation.json'), JSON.stringify({ image: 'bad image with spaces' }))

    const d = deps()
    expect(await cmdAfk(d, 'run', undefined, {})).toBe(0)

    const argv = dockerRunArgv()
    expect(argv).toContain('sandcastle:local')
    expect(argv).not.toContain('bad image')
  })
})

/**
 * v6 T2：cmdAfk('run') 凭证注入接线——机器级 secrets 文件(经 deps.readSecretsEnv)与宿主 env
 * 合并成 hostEnv 传给 createDockerRunChange。优先级:宿主 env 显式非空 > secrets 文件
 * (沿用 sdk「显式>文件」装配惯例;空串 env 视同缺席,不吃掉文件值)。fail-open:依赖未注入/
 * 读失败 → 行为与今天完全一致。env 用 vi.stubEnv 隔离(hermetic,不污染真机)。
 */
describe("cmdAfk('run') · 凭证注入(secrets 文件 × 宿主 env 合并)", () => {
  let cwd: string
  let pluginRoot: string
  beforeEach(async () => {
    h.calls.length = 0
    cwd = await mkdtemp(join(tmpdir(), 'afk-cred-'))
    await execFileAsync('git', ['init', '-q'], { cwd })
    await mkdir(join(cwd, 'openspec', 'changes', 'w'), { recursive: true })
    await initializeCanonicalStepVisit(cwd)
    pluginRoot = await seedDefaultPhaseSkills(cwd)
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'loops.yaml'), W_LOOPS_YAML)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(cwd, { recursive: true, force: true })
  })

  const deps = () =>
    withEnterAfkSkillAuthority(makeDeps({
      cwd, doctor: { pluginRoot }, states: { w: mockAfkState({ phase: 'build', automation: 'queued' }) },
    }))

  it('secrets 文件有 token 而宿主 env 无(空串) → 文件值补位,docker run 注入 -e', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
    const d = deps()
    d.readSecretsEnv = async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-from-file' })
    expect(await cmdAfk(d, 'run', undefined, {})).toBe(0)
    expect(dockerRunArgv()).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-from-file')
  })

  it('宿主 env 显式非空 → 覆盖 secrets 文件值(显式>文件)', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'tok-from-env')
    const d = deps()
    d.readSecretsEnv = async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-from-file' })
    expect(await cmdAfk(d, 'run', undefined, {})).toBe(0)
    const argv = dockerRunArgv()
    expect(argv).toContain('CLAUDE_CODE_OAUTH_TOKEN=tok-from-env')
    expect(argv).not.toContain('tok-from-file')
  })

  it('readSecretsEnv 未注入/读失败 → 行为与今天一致(无 token 不注入,run 正常跑完)', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
    const d = deps()
    expect(await cmdAfk(d, 'run', undefined, {})).toBe(0)
    expect(dockerRunArgv()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')

    h.calls.length = 0
    const d2 = deps()
    d2.readSecretsEnv = async () => { throw new Error('secrets 读失败') }
    expect(await cmdAfk(d2, 'run', undefined, {})).toBe(0)
    expect(dockerRunArgv()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })
})

/**
 * Stage B 返工 #2（阻断 B）：loops.yaml 真实 I/O 故障（此处真 EISDIR——路径被目录占据）经 strict loader
 * throw RegistryReadError → admission reserve fail-loud → scheduler 归 RoundReport.failures（registry-io）
 * → cmdAfk 返非零 + 报故障，**绝不**打印「跑完一轮」（此前被吞成 no-registry denial，round 假 ok=true）。
 */
describe("cmdAfk('run') · registry 真实 I/O 故障 → round failure（非零、不打印跑完一轮）", () => {
  let cwd: string
  beforeEach(async () => {
    h.calls.length = 0
    cwd = await mkdtemp(join(tmpdir(), 'afk-regio-'))
    await execFileAsync('git', ['init', '-q'], { cwd })
    await mkdir(join(cwd, 'openspec', 'changes', 'w'), { recursive: true })
    // loops.yaml 是**目录**（真 EISDIR）：strict loader readFileSync 抛 → RegistryReadError，非 ENOENT no-registry。
    await mkdir(join(cwd, '.pipeline', 'loops.yaml'), { recursive: true })
  })
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

  const deps = () => withEnterAfkSkillAuthority(makeDeps({ cwd, states: { w: mockAfkState({ phase: 'build', automation: 'queued' }) } }))

  it('loops.yaml 是目录（EISDIR）→ exit 1、stderr 报 registry-io 故障、stdout 不含「跑完一轮」', async () => {
    const d = deps()
    const code = await cmdAfk(d, 'run', undefined, {})
    expect(code).toBe(1) // round failure 使 CLI 非零（不再吞成 denial + 假 ok=true）
    expect(d.errLines.join('\n')).toMatch(/失败|故障|registry|loops\.yaml/i)
    expect(d.outLines.join('\n')).not.toContain('跑完一轮')
  })
})

/**
 * H10 §8任务7：cmdAfk('run') 真实全依赖 preparation 装配（isSkillProfileKnown + createExecutionPreparation
 * 真接线）—— 证明 vi.mock 顶部的 test-only 直通 preparation 兜底（本文件头注「H10 §1/§5 + 二次任务交叉
 * 边界」）此刻确实不再是唯一路径：afk.ts 生产代码永远传一个非 undefined 的真 preparation，故 mock 的
 * `deps.preparation ?? fallback` 三元恒取左侧——以下用例专测这条真链路本身（具名 profile 而非
 * `_all`）。它显式构造带 `tenon-build` 的 frozen default capability，并把插件根指向本仓，
 * 证明 phase slot 会进入快照；其他本文件 fixture 仍保留旧空 snapshot 以覆盖历史快照不迁移。
 */
describe("cmdAfk('run') · H10 §8任务7 真实 preparation 装配（isSkillProfileKnown + createExecutionPreparation）", () => {
  let cwd: string
  const V_LOOPS_YAML = `version: 1
loops:
  - id: vloop
    name: V Loop
    kind: orchestrator
    goal: exercise named skill_bundle_id wiring
    cadence: 1h
    risk: low
    runner: claude-code
    change_prefix: v
    skill_bundle_id: backend
    phases:
      - build
      - ship
    human_gates:
      - ship
    allowlist:
      - src/**
    state: .superpowers/loops/progress.md
    design_doc: docs/loops/vloop.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 4
      on_exceed: skip
    kill_criteria:
      - no-change-3
`
  beforeEach(async () => {
    h.calls.length = 0
    cwd = await mkdtemp(join(tmpdir(), 'afk-skillbundle-'))
    await execFileAsync('git', ['init', '-q'], { cwd })
    await mkdir(join(cwd, 'openspec', 'changes', 'v'), { recursive: true })
    await initializeCanonicalStepVisit(cwd, 'v')
    await mkdir(join(cwd, '.pipeline'), { recursive: true })
    await writeFile(join(cwd, '.pipeline', 'loops.yaml'), V_LOOPS_YAML)
  })
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

  const deps = () => withEnterAfkSkillAuthority(makeDeps({ cwd, states: { v: mockAfkState({ phase: 'build', automation: 'queued' }) } }))

  it('具名 profile 已知（isSkillProfileKnown 命中）→ 真 prepare 成功：docker 真跑 + ledger 落 skill-bundle-snapshot 事件', async () => {
    // This case models a newly initialized default AFK run: its frozen snapshot contains the
    // Workflow-owned phase slot. Other legacy fixture cases intentionally retain an empty frozen
    // snapshot to keep historical-snapshot/no-migration coverage isolated.
    const phasePlan = compileEffectiveWorkflowPlan('default', {
      name: 'default',
      interaction: { version: 'v1', mode: 'afk' },
      steps: [{
        id: 'build', label: 'Build', gate: null,
        skills: [{ id: 'tenon' }], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    })
    const phaseState = mockAfkState({ phase: 'build', automation: 'queued' })
    phaseState.runMetadata = {
      ...phaseState.runMetadata!,
      workflowPlanFingerprint: phasePlan.workflowFingerprint,
      workflowPlanSnapshot: workflowPlanSnapshot(phasePlan),
    }
    const d = withEnterAfkSkillAuthority(makeDeps({
      cwd,
      states: { v: phaseState },
      doctor: { pluginRoot: await seedDefaultPhaseSkills(cwd, ['tenon', 'test-driven-development', 'finishing-a-development-branch']) },
    }))
    d.isSkillProfileKnown = (id: string) => id === 'backend'
    expect(await cmdAfk(d, 'run', undefined, {}), d.errLines.join('|')).toBe(0)
    expect(dockerRunArgv()).toBeTruthy() // 真跑到 docker run（未被 profile 校验挡在 admission）

    const { records } = await createLoopLedgerStore().read(cwd)
    const snapshots = records.filter((r) => r.kind === 'skill-bundle-snapshot')
    expect(snapshots.length).toBe(1) // 真 createExecutionPreparation 落的账本事实，test-only fallback 不会产生此事件
    expect(snapshots[0]).toMatchObject({
      skill_bundle_id: 'backend',
      resolution_source: 'default',
      slots: [expect.objectContaining({ token: 'tenon', concrete_skill_id: 'tenon' })],
    })
  })

  it('frozen phase Skill 内容缺失 → preparation fail-closed：无 snapshot、无 sandbox/收费', async () => {
    const missingSkill = 'phase-skill-missing-for-test'
    const phasePlan = compileEffectiveWorkflowPlan('default', {
      name: 'default',
      interaction: { version: 'v1', mode: 'afk' },
      steps: [{
        id: 'build', label: 'Build', gate: null,
        skills: [{ id: missingSkill }], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    })
    const phaseState = mockAfkState({ phase: 'build', automation: 'queued' })
    phaseState.runMetadata = {
      ...phaseState.runMetadata!,
      workflowPlanFingerprint: phasePlan.workflowFingerprint,
      workflowPlanSnapshot: workflowPlanSnapshot(phasePlan),
    }
    const d = withEnterAfkSkillAuthority(makeDeps({
      cwd,
      states: { v: phaseState },
      doctor: { pluginRoot: await seedDefaultPhaseSkills(cwd) },
    }))
    d.isSkillProfileKnown = (id: string) => id === 'backend'
    // The round itself remains healthy: preparation failure is a settled, non-charged entry
    // (`paused`), not a CLI-level registry/runtime failure.
    expect(await cmdAfk(d, 'run', undefined, {}), d.errLines.join('|')).toBe(0)
    expect(h.calls.find((c) => c[0] === 'docker' && c[1] === 'run')).toBeUndefined()
    const { records } = await createLoopLedgerStore().read(cwd)
    expect(records.some((r) => r.kind === 'skill-bundle-snapshot')).toBe(false)
    const terminal = records.find((r) => r.kind === 'run')
    expect(terminal).toMatchObject({ result: 'paused', reason: 'skill-bundle-skill-not-found' })
  })

  it('具名 profile 不存在（isSkillProfileKnown 判 false）→ H11 fresh wiring guard 非零阻断 + 暂停 loop，零 docker、零 prepare', async () => {
    const d = deps()
    d.isSkillProfileKnown = () => false
    expect(await cmdAfk(d, 'run', undefined, {})).toBe(1)
    expect(d.errLines.join('\n')).toMatch(/skill-bundle.*invalid|profile.*backend/i)
    expect(h.calls.find((c) => c[0] === 'docker' && c[1] === 'run')).toBeUndefined()

    const { data } = loadRegistry(cwd)
    expect(data?.loops.find((l) => l.id === 'vloop')?.status).toBe('paused') // pause-loop 治理动作真落盘
  })

  it('isSkillProfileKnown 未装配（undefined）→ fail-closed round failure（非零、不误判成 profile-not-found）', async () => {
    const d = deps()
    // 未覆写 d.isSkillProfileKnown：makeDeps() 缺省不装配（不同于生产 main.ts 恒装配）。
    const code = await cmdAfk(d, 'run', undefined, {})
    expect(code).toBe(1) // SkillProfileValidatorUnconfiguredError 归 kind=config round failure
    expect(d.errLines.join('\n')).toMatch(/故障|config|未装配/i)
    expect(h.calls.find((c) => c[0] === 'docker' && c[1] === 'run')).toBeUndefined()
  })
})
