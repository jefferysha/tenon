/**
 * 观察模式（没有旧文档契约的新任务）端到端：Tenon 不预先规定每一步的输入输出文档，离开步骤时观察实际产出并标注来源技能，
 * 只把直接上游的文档产出交给下一步且必须读完，门禁只剩按路径的必须产出；升级前的带契约快照照旧走完。
 *
 * 零 mock：每个用例都在 harness 的临时项目里 `git init` 并做初次提交（观察基于 git），技能加载走真实的 PostToolUse hook
 * （`recordWorkflowPhaseSkill`——来源标注读的就是它写下的加载时间），测试与评审者证据沿用 harness 现有的满足方式
 * （`next` 里的 run-tests / run-agent / request-review 动作）。写文件的剧本（`afterSkill`）模拟技能按自己的 SKILL.md 写出东西，
 * Tenon 不告诉它写什么。
 */
import { existsSync } from 'node:fs'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { freshHarness, REPO_ROOT, rm, type Harness } from './integration-harness.js'
import { contractHandlers, contractSkillLoader, walkContract } from './integration-next-runner-contract-support.js'
import {
  NextRunner, RUNNER_PACKAGE_JSON, type ActionHandler,
} from './integration-next-runner-test-support.js'
import {
  actionNames, archivedChangeDir, driveStep, exitedVisit, expectOutput, finishNonOpenspecHandler, flatWorkflow, initGitProject,
  observedRunner, readLedger, readList, type DriveResult, type ObservedRunner, type ObservedStep, type StepScript,
} from './integration-observed-test-support.js'

const CHANGE = 'demo'
const PROPOSAL = `openspec/changes/${CHANGE}/proposal.md`
const DELTA = `openspec/changes/${CHANGE}/specs/demo/spec.md`
const DESIGN_DOC = `docs/superpowers/specs/2026-10-12-${CHANGE}-design.md`
const OLD_DESIGN = 'docs/superpowers/specs/2026-01-01-legacy-design.md'
const ADR = 'docs/adr/0001-demo.md'
const PLAN = `docs/superpowers/plans/${CHANGE}.md`
const REPORT = `docs/superpowers/reports/${CHANGE}-verify.md`
const OPEN_NOTE = 'docs/open-only-note.md'
const BUILD_NOTES = 'docs/notes/build-notes.md'
const SOURCE = 'src/feature.ts'

/** 会被 `openspec` 校验的 delta spec。 */
const DELTA_BODY = [
  '# demo', '', '## ADDED Requirements', '',
  '### Requirement: Observed outputs', 'The system SHALL record what each step actually produced.', '',
  '#### Scenario: a step is left', '- **WHEN** a step is left', '- **THEN** its outputs are recorded', '',
].join('\n')

const FORBIDDEN_ACTIONS = ['scaffold-document', 'record-document', 'register-field']

let h: Harness
let o: ObservedRunner
let runner: NextRunner

/** harness 临时项目 + git 初次提交（`files` 随初始提交入库，不算本任务的产出）+ 一个跟着 next 做事的运行器。 */
async function newProject(files: Readonly<Record<string, string>> = {}, handlers: Readonly<Record<string, ActionHandler>> = {}): Promise<void> {
  h = await freshHarness()
  await initGitProject(h, { 'package.json': RUNNER_PACKAGE_JSON, 'README.md': '# demo\n', ...files })
  o = observedRunner(h, CHANGE, { handlers })
  runner = o.runner
}

async function startTask(args: readonly string[]): Promise<void> {
  expect(await h.run(['init', CHANGE, ...args]), h.err.join('\n')).toBe(0)
  expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
}

/** 观察模式下 `next` 不再下发旧的文档动作。 */
function expectNoLegacyActions(drives: Record<string, DriveResult>): void {
  for (const [step, drive] of Object.entries(drives)) {
    expect(actionNames(drive.actions).filter((name) => FORBIDDEN_ACTIONS.includes(name)), step).toEqual([])
  }
}

// `spec apply` 要 PATH 上有 openspec（仓库 devDependency）。
let originalPath: string | undefined
beforeAll(() => {
  originalPath = process.env.PATH
  process.env.PATH = `${join(REPO_ROOT, 'node_modules', '.bin')}:${originalPath ?? ''}`
})
afterAll(() => {
  process.env.PATH = originalPath
})
afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

describe('观察模式 · 新后端任务从立项走到完结', { timeout: 300_000 }, () => {
  /** 各步的剧本：技能加载完成后写出该步的产出；调研步与规格步另有探针。 */
  function backendScripts(): Record<string, StepScript> {
    return {
      open: {
        afterSkill: {
          'openspec-propose': async () => {
            await o.put(PROPOSAL, '# Proposal\n\n## Why\n\nObserved outputs are recorded when a step is left.\n')
            await o.put(OPEN_NOTE, '# 立项备忘\n\n只在立项步写过，调研步没碰它。\n')
          },
        },
      },
      explore: {
        atStart: async () => {
          // 调研步还没写任何设计文档：项目里早就有的旧文件不算，出口点名必须产出。必须产出是离开条件（guard）：exit 2。
          expect(await h.run(['transition', CHANGE, 'explore-complete']), h.err.join('\n')).toBe(2)
          expect(h.err.join('\n')).toContain('要求产出匹配 docs/superpowers/specs/*.md 的文件')
        },
        afterSkill: {
          'openspec-explore': () => o.put(PROPOSAL, '# Proposal\n\n## Why\n\nObserved outputs are recorded when a step is left.\n\n调研后补的一段。\n'),
          brainstorming: () => o.put(DESIGN_DOC, '# Design\n\nThe ledger is written inside the transition lock.\n'),
          'domain-modeling': () => o.put(ADR, '# ADR 1\n\nObserve at the transition, not in a hook.\n'),
        },
      },
      spec: { atStart: specStartProbe },
      build: {
        afterSkill: {
          'test-driven-development': async () => {
            await o.put(SOURCE, 'export const feature = 1\n')
            await o.put('src/feature.test.ts', "import { feature } from './feature.js'\nvoid feature\n")
            await o.put(BUILD_NOTES, '# Build notes\n\nImplemented the feature.\n')
          },
        },
      },
      verify: {
        afterSkill: { 'verification-before-completion': () => o.put(REPORT, '# Verification\n\nAll gates green.\n') },
      },
      ship: {},
      archive: {},
    }
  }

  /**
   * 离开条件按「步骤自己的守卫 → 声明的技能 → 本步输入读完没有」的顺序判。规格步是一个没有照 next 先读输入就直接开工的宿主：
   * 技能加载完、两份必须产出都写出来了，调研步产出的文档却还没读——任何离开边都被拒（exit 1），点名「本步输入」与修复命令；
   * 计划被删掉时改为必须产出缺失（exit 2）。其后按 next 读输入、测试、评审。
   */
  async function specStartProbe(): Promise<void> {
    await runner.loadSkill('tenon')
    await runner.loadSkill('openspec-propose')
    await o.put(DELTA, DELTA_BODY)
    await runner.loadSkill('writing-plans')
    await o.put(PLAN, '# Plan\n\n1. Record outputs.\n')
    expect(await h.run(['transition', CHANGE, 'spec-complete']), h.err.join('\n')).toBe(1)
    expect(h.err.join('\n')).toContain('本步输入')
    expect(h.err.join('\n')).toContain('tenon document read')
    // 标题说的是「本步输入还没读完」，而不是旧契约的「OpenSpec 文档证据未通过」。
    expect(h.err.join('\n')).toContain('本步输入还没读完（step=spec）')
    expect(h.err.join('\n')).not.toContain('OpenSpec 文档证据')
    await rm(join(h.cwd, PLAN))
    expect(await h.run(['transition', CHANGE, 'spec-complete']), h.err.join('\n')).toBe(2)
    expect(h.err.join('\n')).toContain('要求产出匹配 docs/superpowers/plans/*.md 的文件')
    await o.put(PLAN, '# Plan\n\n1. Record outputs.\n')
  }

  test('新后端任务走完：产出、来源、直接上游交接、必须产出', async () => {
    // 调研步之前项目里就有一份别的任务留下的设计文档：它不能满足本任务调研步的必须产出。
    await newProject({ [OLD_DESIGN]: '# 旧设计\n' })
    await startTask(['--track', 'backend', '--preset', 'full'])
    const drives: Record<string, DriveResult> = {}
    for (const [stepId, script] of Object.entries(backendScripts())) drives[stepId] = await driveStep(runner, stepId, script)

    // 完结后任务目录连同账本搬进 archive/。
    const visits = await readLedger(await archivedChangeDir(h.cwd, CHANGE))
    // 每次离开都有离开记录，观察可用，产出里有本步写出的文件，来源是写入前加载的技能；没有任何状态文件。
    for (const step of ['open', 'explore', 'spec', 'build', 'verify', 'ship']) {
      expect(exitedVisit(visits, step).exit?.observation, step).toBe('observed')
    }
    expectOutput(exitedVisit(visits, 'open'), PROPOSAL, 'added', 'openspec-propose')
    expectOutput(exitedVisit(visits, 'open'), OPEN_NOTE, 'added', 'openspec-propose')
    expectOutput(exitedVisit(visits, 'explore'), PROPOSAL, 'modified', 'openspec-explore')
    expectOutput(exitedVisit(visits, 'explore'), DESIGN_DOC, 'added', 'brainstorming')
    expectOutput(exitedVisit(visits, 'explore'), ADR, 'added', 'domain-modeling')
    expectOutput(exitedVisit(visits, 'spec'), DELTA, 'added', 'openspec-propose')
    expectOutput(exitedVisit(visits, 'spec'), PLAN, 'added', 'writing-plans')
    expectOutput(exitedVisit(visits, 'build'), SOURCE, 'added', 'test-driven-development')
    expectOutput(exitedVisit(visits, 'build'), BUILD_NOTES, 'added', 'test-driven-development')
    expectOutput(exitedVisit(visits, 'verify'), REPORT, 'added', 'verification-before-completion')
    for (const visit of visits) {
      const paths = visit.outputs.map((output) => output.path)
      expect(paths.filter((path) => path.split('/').some((part) => part.startsWith('.pipeline'))), visit.step).toEqual([])
      expect(paths, visit.step).not.toContain(OLD_DESIGN)
    }

    // 规格步的 read-documents 只列直接上游（调研步）产出的文档；立项步写过、调研步没碰的备忘不在其中。
    const exploreDocs = exitedVisit(visits, 'explore').outputs
      .filter((output) => output.change !== 'deleted' && /\.(md|mdx|markdown)$/u.test(output.path)).map((output) => output.path)
    expect(readList(drives.spec!).sort()).toEqual([...exploreDocs].sort())
    expect(readList(drives.spec!)).toEqual(expect.arrayContaining([DESIGN_DOC, PROPOSAL, ADR]))
    expect(readList(drives.spec!)).not.toContain(OPEN_NOTE)
    // 代码文件不是交接输入：验证步只读构建步产出的 Markdown，不含 src/feature.ts。
    expect(readList(drives.verify!)).toContain(BUILD_NOTES)
    expect(readList(drives.verify!)).not.toContain(SOURCE)
    expect(readList(drives.verify!).every((path) => /\.md$/u.test(path))).toBe(true)

    expectNoLegacyActions(drives)
    // 走 OpenSpec 的任务：规格步下发 validate-spec（本步有指向 delta spec 的必须产出），交付步下发 apply-spec。
    expect(actionNames(drives.spec!.actions)).toContain('validate-spec')
    expect(actionNames(drives.ship!.actions)).toContain('apply-spec')
    // 这两条动作真的执行了（运行器遇到非 0 退出码会抛错）：规格步彩排过，交付步把 delta 应用进主规格并留下 apply 回执。
    expect(existsSync(join(h.cwd, 'openspec', 'specs', 'demo', 'spec.md'))).toBe(true)
    expect(JSON.parse(await readFile(join(await archivedChangeDir(h.cwd, CHANGE), '.pipeline-spec-apply.json'), 'utf8')))
      .toMatchObject({ mode: 'apply', result: 'pass', deltas: [{ path: DELTA }] })
    expect(existsSync(join(h.cwd, 'openspec', 'changes', 'archive'))).toBe(true)
  })

  /**
   * 观察模式的任务没有文档账本：delta spec 取自任务目录 `specs/` 下的 spec.md（kernel 统一来源），
   * `tenon spec apply` 彩排与应用、回执、`next` 的 validate-spec / apply-spec 判定读的是同一份。
   */
  test('观察模式任务的 tenon spec apply：彩排不改主规格，应用写出主规格与回执，全程没有文档账本', async () => {
    await newProject()
    await startTask(['--track', 'backend', '--preset', 'full'])
    await o.put(PROPOSAL, '# Proposal\n\n## Why\n\nThe change needs a durable capability.\n')
    await o.put(DELTA, DELTA_BODY)
    const receiptPath = join(runner.changeDir(), '.pipeline-spec-apply.json')
    const mainSpec = join(h.cwd, 'openspec', 'specs', 'demo', 'spec.md')

    expect(await h.run(['spec', 'apply', CHANGE, '--dry-run', '--json']), h.err.join('\n')).toBe(0)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ mode: 'dry-run', result: 'pass', deltas: [{ path: DELTA }] })
    expect(existsSync(mainSpec)).toBe(false)

    expect(await h.run(['spec', 'apply', CHANGE]), h.err.join('\n')).toBe(0)
    expect(existsSync(mainSpec)).toBe(true)
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ mode: 'apply', result: 'pass', deltas: [{ path: DELTA }] })
    expect(existsSync(join(runner.changeDir(), '.pipeline-documents.json'))).toBe(false)
  })

  test('观察模式任务的 specs/ 里有符号链接：tenon spec apply 拒绝（exit 1），不跟随也不当作没有 delta spec', async () => {
    await newProject()
    await startTask(['--track', 'backend', '--preset', 'full'])
    await o.put(PROPOSAL, '# Proposal\n\n## Why\n\nThe change needs a durable capability.\n')
    await o.put(DELTA, DELTA_BODY)
    await symlink(join(h.cwd, 'README.md'), join(runner.changeDir(), 'specs', 'demo', 'linked.md'))

    expect(await h.run(['spec', 'apply', CHANGE, '--dry-run']), h.err.join('\n')).toBe(1)
    expect(h.err.join('\n')).toContain('符号链接')
    expect(existsSync(join(runner.changeDir(), '.pipeline-spec-apply.json'))).toBe(false)
  })
})

describe('观察模式 · 新轻量任务走完', { timeout: 300_000 }, () => {
  test('open → build → verify → done：账本有三次离开记录，没有任何 read-documents 要求读代码文件', async () => {
    await newProject({}, { 'finish-change': finishNonOpenspecHandler(() => runner) })
    await startTask(['--track', 'lite', '--preset', 'tweak'])
    const scripts: Record<string, StepScript> = {
      open: {},
      build: { afterSkill: { 'test-driven-development': () => o.put('src/typo.ts', 'export const greeting = "hello"\n') } },
      verify: {},
      done: {},
    }
    const drives: Record<string, DriveResult> = {}
    for (const [stepId, script] of Object.entries(scripts)) drives[stepId] = await driveStep(runner, stepId, script)

    const visits = await readLedger(await archivedChangeDir(h.cwd, CHANGE))
    expect(visits.filter((visit) => visit.exit !== null).map((visit) => [visit.step, visit.exit?.event, visit.exit?.observation])).toEqual([
      ['open', 'open-complete', 'observed'],
      ['build', 'build-complete', 'observed'],
      ['verify', 'verify-pass', 'observed'],
    ])
    // 构建步写出的是代码：记为产出，但不是交接输入——验证步没有任何 read-documents。
    expectOutput(exitedVisit(visits, 'build'), 'src/typo.ts', 'added', 'test-driven-development')
    expect(actionNames(drives.verify!.actions)).not.toContain('read-documents')
    for (const drive of Object.values(drives)) expect(readList(drive).filter((path) => !/\.md$/u.test(path))).toEqual([])
    expectNoLegacyActions(drives)
  })
})

describe('升级前创建的带契约任务照旧走完', { timeout: 300_000 }, () => {
  test('冻结着文档契约的 step-graph 任务按旧动作（scaffold / record / 按 kind 的 read-documents）走到 finish，不写步骤产出账本', async () => {
    await newProject()
    const old: NextRunner = new NextRunner(h, 'old', {
      loadSkill: contractSkillLoader(() => old),
      freeform: { prd_path: 'docs/old-prd.md', plan: 'docs/old-plan.md' },
      handlers: contractHandlers(() => old),
    })
    const { actions } = await walkContract(old, { init: () => h.initLegacyContractDefault('old', 'backend') })
    const seen = new Set(actions.map(({ action }) => action.action))
    // 契约模式的 next 仍是旧动作：铺骨架、按 kind 读取、登记文档、登记 artifact 字段；规格校验 / 应用也照旧能执行。
    for (const legacy of [...FORBIDDEN_ACTIONS, 'read-documents', 'validate-spec', 'apply-spec']) expect(seen, legacy).toContain(legacy)
    expect(actions.filter(({ action }) => action.action === 'read-documents').every(({ action }) => Array.isArray(action.editable))).toBe(true)
    // 没有 .pipeline-step-outputs.json 被写出（任务目录已随完结搬进 archive/）。
    const archived = await archivedChangeDir(h.cwd, 'old')
    expect(existsSync(join(archived, '.pipeline-step-outputs.json'))).toBe(false)
    expect(existsSync(join(archived, '.pipeline-documents.json'))).toBe(true)
  })
})

describe('Spec Kit 风格的平铺工作流（spec: none）', { timeout: 300_000 }, () => {
  /** specify → plan → tasks → implement，必须产出是各命令必写的稳定产出。 */
  const SPECKIT = [
    { id: 'specify', required: ['specs/*/spec.md'], event: 'specify-complete', to: 'plan' },
    { id: 'plan', required: ['specs/*/plan.md'], event: 'plan-complete', to: 'tasks' },
    { id: 'tasks', required: ['specs/*/tasks.md'], event: 'tasks-complete', to: 'implement' },
    { id: 'implement', event: 'implement-complete', to: 'done' },
    { id: 'done' },
  ] as const

  test('specify 写 spec.md 离开后 plan 的 read-documents 正好列出它；plan 不写 plan.md 不能离开；只交直接上游', async () => {
    await newProject({}, { 'finish-change': finishNonOpenspecHandler(() => runner) })
    await o.put('.pipeline/workflows/speckit.yaml', flatWorkflow('speckit', SPECKIT))
    await startTask(['--workflow', 'speckit', '--preset', 'full'])
    const SPEC = 'specs/001-demo/spec.md'
    const PLAN_MD = 'specs/001-demo/plan.md'
    const TASKS_MD = 'specs/001-demo/tasks.md'
    const scripts: Record<string, StepScript> = {
      specify: { afterSkill: { tenon: () => o.put(SPEC, '# Spec\n\nUsers can demo.\n') } },
      plan: {
        atStart: async () => {
          // specify 的产出交接过来：read-documents 正好列出 spec.md（来自 specify），status 里它是未读输入。
          await runner.loadSkill('tenon')
          const pending = await runner.readStep<ObservedStep>()
          expect(pending.next).toEqual([expect.objectContaining({ action: 'read-documents', documents: [SPEC] })])
          expect(pending.documents.inputs).toEqual([expect.objectContaining({ path: SPEC, from_step: 'specify', status: 'unread' })])
          // 读完之后试着不写计划就离开——必须产出缺失（exit 2），点名模式。
          await runner.run(['document', 'read', CHANGE, 'all'])
          expect(await h.run(['transition', CHANGE, 'plan-complete']), h.err.join('\n')).toBe(2)
          expect(h.err.join('\n')).toContain('要求产出匹配 specs/*/plan.md 的文件')
          await o.put(PLAN_MD, '# Plan\n\nUse the ledger.\n')
        },
      },
      tasks: {
        atStart: async () => {
          // 任务清单已写出，但直接上游（plan.md）还没读：任何离开边被拒，点名「本步输入」。
          await runner.loadSkill('tenon')
          await o.put(TASKS_MD, '# Tasks\n\n- [ ] T1\n')
          expect(await h.run(['transition', CHANGE, 'tasks-complete']), h.err.join('\n')).toBe(1)
          expect(h.err.join('\n')).toContain('本步输入')
        },
      },
      implement: {},
      done: {},
    }
    const drives: Record<string, DriveResult> = {}
    for (const [stepId, script] of Object.entries(scripts)) drives[stepId] = await driveStep(runner, stepId, script)

    const visits = await readLedger(await archivedChangeDir(h.cwd, CHANGE))
    expectOutput(exitedVisit(visits, 'specify'), SPEC, 'added')
    expectOutput(exitedVisit(visits, 'plan'), PLAN_MD, 'added')
    // 交接只给直接上游：tasks 的输入只有 plan.md（spec.md 是更早一步的产出，不再交接）。
    expect(readList(drives.tasks!)).toEqual([PLAN_MD])
    expect(readList(drives.implement!)).toEqual([TASKS_MD])
    expectNoLegacyActions(drives)
  })
})

describe('观察模式下旧命令被拒', () => {
  test('document record / scaffold / init / migrate-delta 退出码 2 并说明产出自动记录；artifact register 同一句话（退出码 1）', async () => {
    await newProject()
    await startTask(['--track', 'backend', '--preset', 'full'])
    await o.put(PROPOSAL, '# Proposal\n')
    const commands: readonly (readonly string[])[] = [
      ['document', 'record', CHANGE, 'proposal', PROPOSAL, '--producer', 'openspec-propose'],
      ['document', 'record', CHANGE, '--all'],
      ['document', 'scaffold', CHANGE, 'proposal'],
      ['document', 'init', CHANGE],
      ['document', 'migrate-delta', CHANGE, 'docs/legacy.md', DELTA],
    ]
    for (const command of commands) {
      expect(await h.run([...command]), command.join(' ')).toBe(2)
      expect(h.err.join('\n'), command.join(' ')).toContain('自动记录')
    }
    expect(await h.run(['artifact', 'register', CHANGE, 'design_doc', 'x.md', '--producer', 'brainstorming'])).toBe(1)
    expect(h.err.join('\n')).toContain('自动记录')
    // 被拒的命令一个字节都没写：没有文档账本，提案仍是工作区里的普通文件。
    expect(existsSync(join(runner.changeDir(), '.pipeline-documents.json'))).toBe(false)
    // 观察模式支持的命令照常：立项步的必须产出（proposal.md）已满足、没有输入 → status 退出码 0。
    expect(await h.run(['document', 'status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      change: CHANGE, mode: 'observed', observation: 'observed', inputs: [], required: [{ path: PROPOSAL, status: 'produced' }],
    })
  })
})

describe('观察模式的转换拒绝：标题说的是实际原因，不是「OpenSpec 文档证据」', () => {
  test('步骤产出账本损坏：exit 1，标题点明账本不可用，blockers 给出修复办法', async () => {
    await newProject({}, { 'finish-change': finishNonOpenspecHandler(() => runner) })
    await o.put('.pipeline/workflows/title-flow.yaml', flatWorkflow('title-flow', [
      { id: 'implement', event: 'implement-complete', to: 'done' },
      { id: 'done' },
    ]))
    await startTask(['--workflow', 'title-flow', '--preset', 'full'])
    await runner.loadSkill('tenon')
    await writeFile(join(runner.changeDir(), '.pipeline-step-outputs.json'), '{not json', 'utf8')

    expect(await h.run(['transition', CHANGE, 'implement-complete']), h.err.join('\n')).toBe(1)
    const stderr = h.err.join('\n')
    expect(stderr).toContain('步骤产出账本不可用（step=implement）')
    expect(stderr).toContain('步骤产出账本损坏')
    expect(stderr).not.toContain('OpenSpec 文档证据')
    expect(stderr).not.toContain('本步输入还没读完')
  })
})

describe('rebase 之后别人合并进来的 Markdown 不算本任务的产出', { timeout: 300_000 }, () => {
  const FLOW = [
    { id: 'implement', event: 'implement-complete', to: 'verify' },
    { id: 'verify', event: 'verify-complete', to: 'done' },
    { id: 'done' },
  ] as const

  test('实现步里 main 上多了一个上游提交、任务分支 rebase 过去：产出与验证步的 read-documents 都只含本任务自己的文档', async () => {
    await newProject({}, { 'finish-change': finishNonOpenspecHandler(() => runner) })
    const git = (...args: string[]): void => {
      const result = runner.git(args)
      expect(result.status, `git ${args.join(' ')}\n${result.output}`).toBe(0)
    }
    git('checkout', '-q', '-b', 'task')
    await o.put('.pipeline/workflows/rebase-flow.yaml', flatWorkflow('rebase-flow', FLOW))
    await startTask(['--workflow', 'rebase-flow', '--preset', 'full'])
    const scripts: Record<string, StepScript> = {
      implement: {
        afterSkill: {
          tenon: async () => {
            // 任务自己的提交。
            await o.put('docs/impl-notes.md', '# Impl notes\n')
            await o.put('src/impl.ts', 'export const impl = 1\n')
            git('add', 'docs/impl-notes.md', 'src/impl.ts')
            git('commit', '-q', '-m', 'task: implement')
            // 别人合并进 main 的改动（改了 README.md，新增 docs/upstream.md），origin/HEAD 指到 main。
            git('checkout', '-q', 'main')
            await o.put('README.md', '# demo\n\n上游改过。\n')
            await o.put('docs/upstream.md', '# upstream\n')
            git('add', 'README.md', 'docs/upstream.md')
            git('commit', '-q', '-m', 'upstream: docs')
            git('update-ref', 'refs/remotes/origin/main', 'main')
            git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
            git('checkout', '-q', 'task')
            git('rebase', '-q', 'main')
          },
        },
      },
      verify: {},
      done: {},
    }
    const drives: Record<string, DriveResult> = {}
    for (const [stepId, script] of Object.entries(scripts)) drives[stepId] = await driveStep(runner, stepId, script)

    const visits = await readLedger(await archivedChangeDir(h.cwd, CHANGE))
    const outputs = exitedVisit(visits, 'implement').outputs.map((output) => output.path)
    expect(outputs).toEqual(expect.arrayContaining(['docs/impl-notes.md', 'src/impl.ts']))
    expect(outputs).not.toContain('README.md')
    expect(outputs).not.toContain('docs/upstream.md')
    expect(readList(drives.verify!)).toEqual(['docs/impl-notes.md'])
  })
})
