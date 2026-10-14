/**
 * 轻量轨道验收（`default` 的 `lite` 分支）：一个 3 文件缺陷修复从 init 走到完结，只照 `tenon status --json` 的 `step.next` 做。
 *
 * 计数口径（审计 §3 的「70–90 次 tenon 调用 / 6+ 次用户回复」同一口径）：
 *   · tenon 调用 = 助手自己执行的每一条 `tenon …` 命令，status 与 step run 都算；hook 在宿主里自己触发的内部回执
 *     （技能加载）不算助手的调用，另外报告；
 *   · 用户回复 = 用户必须亲自做的事：在自己的终端确认测试命令的信任（`tenon test trust`）、对评审门说「确认继续」。
 *
 * 零 mock：真临时项目 + 真仓库 + 真 kernel；风险探针 `tenon test diff-risk` 由测试进程 PATH 上的桩转交给
 * 真实 CLI（TENON_TEST_REAL_DIFF=1），读到的是夹具仓库里真实的改动。
 *
 * 由 standard-lane.integration.test.ts 迁移而来：断言不变，只是通道换成 `tenon init --workflow default --track lite`
 * （standard 工作流已并入 default 的轻量轨道）。
 *
 * 本文件也覆盖升级前创建的 standard 任务按冻结快照一路走到完结（standard 模板已删，只剩任务里冻结的计划）。
 */
import { existsSync } from 'node:fs'
import { appendFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, REPO_ROOT, rm, type Harness } from './integration-harness.js'
import { FIXTURE_DATE, putFile, runGit, type GitResult } from './test-git-fixture.js'

const CHANGE = 'fix-add'
/**
 * 关掉 harness 默认的「测试命令已信任」（信任要用户亲自给）；时钟逐次前进一秒，同一步骤里先后几次测试运行才分得出先后
 * （固定时钟下运行 id 的时间前缀相同，「最新一次」由随机后缀决定）。
 */
const NO_TRUST = { env: { TENON_TEST_TRUST: '', TENON_TEST_TICKING_CLOCK: '1' } }

interface StepAction { readonly action: string; readonly [key: string]: unknown }
interface StepBlock { readonly id: string; readonly archived: boolean; readonly next: readonly StepAction[] }
interface FinishCommit { readonly paths: readonly string[]; readonly untrack: readonly string[]; readonly message: string }

interface Tally {
  /** 助手执行的 tenon 命令（含 status）。 */
  readonly commands: string[]
  /** 用户必须亲自做的事。 */
  readonly replies: string[]
  /** hook 在宿主里自己触发的技能回执（不是助手的调用）。 */
  hookReceipts: number
}

let h: Harness
let realDiff: string | undefined

beforeAll(() => {
  realDiff = process.env.TENON_TEST_REAL_DIFF
  process.env.TENON_TEST_REAL_DIFF = '1'
})
afterAll(() => {
  if (realDiff === undefined) delete process.env.TENON_TEST_REAL_DIFF
  else process.env.TENON_TEST_REAL_DIFF = realDiff
})

const vcs = (args: readonly string[]): GitResult => runGit(h.cwd, args, FIXTURE_DATE)
const put = (rel: string, body: string): Promise<void> => putFile(h.cwd, rel, body)

/**
 * 夹具：一个 add 写成了减法的小库；sum 依赖它，已有的 sum 测试因此是红的。
 * 轻量轨道就是随插件发布的 default 模板里的 `lite` 分支，项目里不需要任何工作流文件。
 */
async function seedProject(): Promise<void> {
  await put('package.json', `${JSON.stringify({ name: 'adder', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`)
  await put('src/add.js', 'export function add(a, b) {\n  return a - b\n}\n')
  await put('src/sum.js', "import { add } from './add.js'\n\nexport function sum(xs) {\n  return xs.reduce(add, 0)\n}\n")
  await put('test/sum.test.js', [
    "import { test } from 'node:test'", "import assert from 'node:assert/strict'", "import { sum } from '../src/sum.js'", '',
    "test('sum adds the numbers', () => {", '  assert.equal(sum([1, 2, 3]), 6)', '})', '',
  ].join('\n'))
  expect(vcs(['init', '-q']).status).toBe(0)
  expect(vcs(['add', '-A']).status).toBe(0)
  expect(vcs(['commit', '-q', '-m', 'fixture']).status).toBe(0)
}

/** 缺陷修复：改 add、给 sum 补空输入保护、补一个 add 的回归测试——三个文件。 */
async function fixTheBug(): Promise<void> {
  await put('src/add.js', 'export function add(a, b) {\n  return a + b\n}\n')
  await put('src/sum.js', "import { add } from './add.js'\n\nexport function sum(xs = []) {\n  return xs.reduce(add, 0)\n}\n")
  await put('test/add.test.js', [
    "import { test } from 'node:test'", "import assert from 'node:assert/strict'", "import { add } from '../src/add.js'", '',
    "test('add adds two numbers', () => {", '  assert.equal(add(2, 3), 5)', '})', '',
  ].join('\n'))
}

beforeEach(async () => {
  h = await freshHarness()
  await seedProject()
})
afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

const changeDir = (): string => join(h.cwd, 'openspec', 'changes', CHANGE)

async function runStep(tally: Tally, args: readonly string[], options: { readonly env?: Record<string, string> } = NO_TRUST): Promise<number> {
  tally.commands.push(`tenon ${args.join(' ')}`)
  return h.run([...args], options)
}

/** 历史里最后一条记录的时间 + 1 秒：宿主观察到技能加载的时刻晚于此前所有记录（时钟逐次前进）。 */
async function observedNow(): Promise<string> {
  const history = await readFile(join(changeDir(), '.pipeline-history.jsonl'), 'utf8').catch(() => '')
  let last = Date.parse(FIXED_CLOCK)
  for (const line of history.split('\n')) {
    if (line.trim() === '') continue
    const ts = Date.parse(String((JSON.parse(line) as { ts?: string }).ts ?? ''))
    if (Number.isFinite(ts)) last = Math.max(last, ts)
  }
  return new Date(last + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 宿主加载一个技能：PostToolUse 历史行 + 内部回执命令（hook 触发，不计入助手的调用）。 */
let toolUseSeq = 0
async function loadSkill(tally: Tally, skill: string): Promise<void> {
  toolUseSeq += 1
  const observedAt = await observedNow()
  await appendFile(join(changeDir(), '.pipeline-history.jsonl'),
    `${JSON.stringify({ ts: observedAt, kind: 'tool', raw: `Skill: ${skill}` })}\n`, 'utf8')
  expect(await h.run(['internal-native-skill-receipt', CHANGE, skill, 'lite-session', `tool-${toolUseSeq}`, observedAt], NO_TRUST),
    h.err.join('\n')).toBe(0)
  tally.hookReceipts += 1
}

/** 读当前步骤：`tenon step run --json` 先做完确定性的动作（测试计划初稿…），再给出最新的 step.next。 */
async function readStep(tally: Tally): Promise<StepBlock> {
  expect(await runStep(tally, ['step', 'run', CHANGE, '--json']), h.err.join('\n')).toBe(0)
  const payload = JSON.parse(h.out.join('\n')) as { step?: StepBlock; did?: unknown; stopped?: unknown }
  if (payload.step === undefined) throw new Error(`step run 没有 step 分块\n${h.out.join('\n')}`)
  return payload.step
}

/** 用户在自己的终端确认测试命令的信任（agent 不能替用户做）：一次用户回复。 */
async function userTrustsTestCommands(tally: Tally): Promise<void> {
  tally.replies.push('tenon test trust --yes（用户在自己的终端）')
  expect(await h.run(['test', 'trust', CHANGE, '--yes'], NO_TRUST), h.err.join('\n')).toBe(0)
}

/** 评审门上用户说「确认继续」：hook 写回执（不是助手的调用），一次用户回复。 */
async function userConfirmsReview(tally: Tally): Promise<void> {
  tally.replies.push('确认继续')
  expect(await h.run(['review', 'acknowledge', CHANGE]), h.err.join('\n')).toBe(0)
}

async function agentRun(tally: Tally, agent: string): Promise<void> {
  expect(await runStep(tally, ['agent', 'prompt', CHANGE, agent, '--json']), h.err.join('\n')).toBe(0)
  const prompted = JSON.parse(h.out.join('')) as { run_id: string; report_path: string }
  await put(prompted.report_path, `# ${agent}\n\n\`\`\`tenon-result\n{"findings":[]}\n\`\`\`\n`)
  expect(await runStep(tally, ['agent', 'record', CHANGE, prompted.run_id]), h.err.join('\n')).toBe(0)
}

/**
 * 跑一条测试命令。动作带 `trust` 时先请用户在自己的终端确认（一次用户回复），不带却撞上「还没信任」才是白跑一次。
 */
async function runTestCommand(tally: Tally, args: readonly string[], trust: unknown): Promise<void> {
  if (trust !== undefined) await userTrustsTestCommands(tally)
  const code = await runStep(tally, args)
  expect(code, h.err.join('\n')).toBe(0)
}

/**
 * 照 next 把任务走到完结，行为按 SKILL 的循环：新建 / 转换之后立即重新加载 tenon（新的步骤访问），请求评审之后
 * 结束本轮等用户，finish-change 是最后一件事。每个动作都是真命令。返回走过的 next 动作名。
 */
async function walkToFinish(tally: Tally): Promise<string[]> {
  const seen: string[] = []
  for (let round = 0; round < 40; round++) {
    const step = await readStep(tally)
    const first = step.next[0]
    if (first === undefined) throw new Error('next 为空')
    if (first.action === 'stop') {
      seen.push(`stop:${String(first.code)}`)
      return seen
    }
    wave: for (const action of step.next) {
      seen.push(`${step.id}/${action.action}${action.event === undefined ? '' : `:${String(action.event)}`}`)
      switch (action.action) {
        case 'load-tenon':
          await loadSkill(tally, 'tenon')
          break
        case 'load-skill':
          await loadSkill(tally, String(action.skill))
          // 加载 TDD 技能后助手开始改代码。
          if (action.skill === 'test-driven-development') await fixTheBug()
          break
        case 'test-register-files':
          for (const item of action.files as readonly { fix: string | null }[]) {
            expect(item.fix, JSON.stringify(item)).not.toBeNull()
            expect(await runStep(tally, (item.fix ?? '').replace(/^tenon /u, '').split(' ')), h.err.join('\n')).toBe(0)
          }
          break
        case 'run-tests':
          await runTestCommand(tally, ['test', 'run', CHANGE, '--stage'], action.trust)
          break
        case 'run-test':
          await runTestCommand(tally, ['test', 'run', CHANGE, String(action.test)], action.trust)
          break
        case 'run-agent':
          await agentRun(tally, String(action.agent))
          break
        case 'request-review':
          expect(await runStep(tally, ['review', 'request', CHANGE, '--event', String(action.event)]), h.err.join('\n')).toBe(0)
          // 结束本轮等用户；用户回「确认继续」之后下一轮从头读 next。
          await userConfirmsReview(tally)
          break wave
        case 'await-review':
          await userConfirmsReview(tally)
          break wave
        case 'transition':
        case 'complete':
          expect(await runStep(tally, ['transition', CHANGE, String(action.event)]), h.err.join('\n')).toBe(0)
          // 转换 = 新的步骤访问：不必先 status 一次才知道要重新加载 tenon。
          await loadSkill(tally, 'tenon')
          break wave
        case 'finish-change': {
          const commit = action.commit as FinishCommit
          // 归档由 Tenon 自己做（agent 不直接执行 openspec 命令），移动之后再照 commit 提交。
          expect(action.command).toBe(`tenon task finish ${CHANGE}`)
          expect(await runStep(tally, ['task', 'finish', CHANGE]), h.err.join('\n')).toBe(0)
          expect(vcs(['add', '-A', '--', ...commit.paths]).status).toBe(0)
          expect(vcs(['commit', '-q', '-m', commit.message]).status).toBe(0)
          seen.push('stop:finished')
          return seen
        }
        default:
          throw new Error(`runner: next 给了执行不了的动作 ${JSON.stringify(action)}`)
      }
    }
  }
  throw new Error(`40 轮还没走到完结：${seen.join(' → ')}`)
}

async function startLite(tally: Tally, extraInitArgs: readonly string[] = []): Promise<void> {
  expect(await runStep(tally, ['init', CHANGE, '--workflow', 'default', '--track', 'lite', '--preset', 'full', ...extraInitArgs]), h.err.join('\n')).toBe(0)
  expect(await runStep(tally, ['session', 'activate', CHANGE, '--host-session', 'lite-session']), h.err.join('\n')).toBe(0)
  // 新建之后立即重新加载 tenon：新的步骤访问，第一轮读 next 就不会只是 load-tenon。
  await loadSkill(tally, 'tenon')
  expect(await runStep(tally, ['workflow', 'plan', CHANGE, '--json'])).toBe(0)
}

describe('轻量轨道：3 文件缺陷修复', () => {
  test('从 init 走到完结：≤25 次 tenon 调用、≤2 次用户回复，代码真的修好并提交', async () => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLite(tally)
    const seen = await walkToFinish(tally)

    // 轨道本身：四步走完，没有 explore / 访谈类技能，也没有 scope-expanded 被推荐。
    expect(seen.filter((entry) => entry.startsWith('open/') || entry.startsWith('build/') || entry.startsWith('verify/')))
      .toEqual([
        'open/transition:open-complete', 'build/load-skill', 'build/run-tests', 'build/run-test',
        'build/transition:build-complete', 'verify/load-skill', 'verify/run-tests', 'verify/run-agent',
        'verify/request-review:verify-pass', 'verify/transition:verify-pass',
      ])
    expect(seen.some((entry) => entry.includes('scope-expanded'))).toBe(false)

    // 验收：调用数与用户回复数（审计基线：70–90 次调用、6+ 次回复）。
    console.log(`lite-track: ${tally.commands.length} 次 tenon 调用（hook 回执 ${tally.hookReceipts}），${tally.replies.length} 次用户回复：${tally.replies.join(' / ')}`)
    expect(tally.commands.length, tally.commands.join('\n')).toBeLessThanOrEqual(25)
    expect(tally.replies.length, tally.replies.join(' / ')).toBeLessThanOrEqual(2)

    // 结果：任务以验证通过收尾，代码修好了，整个工作区一次提交，工作区干净。
    // 完结后目录已被 `tenon task finish` 移进 archive/（task_result 写在任务状态里，随它一起搬走）。
    expect(existsSync(changeDir())).toBe(false)
    const archiveRoot = join(h.cwd, 'openspec', 'changes', 'archive')
    const archivedName = (await readdir(archiveRoot)).find((entry) => entry.endsWith(`-${CHANGE}`))
    expect(archivedName).toBeDefined()
    const state = await readFile(join(archiveRoot, archivedName as string, '.pipeline.yaml'), 'utf8')
    expect(state).toContain('workflow: default')
    expect(state).toMatch(/^track: lite$/mu)
    expect(state).toMatch(/verify_result:\s*pass/u)
    expect(state).toMatch(/^task_result: finished$/mu)
    expect(spawnSync('node', ['--test'], { cwd: h.cwd, encoding: 'utf8' }).status).toBe(0)
    expect(vcs(['log', '--format=%s', '-1']).output.trim()).toBe(`chore(tenon): finish ${CHANGE}`)
    expect(vcs(['status', '--porcelain']).output).toBe('')
    expect(await h.run(['status', CHANGE, '--json'])).toBe(0)
    expect(JSON.parse(h.out.join('\n')).step).toMatchObject({ archived: true, next: [{ action: 'stop', code: 'finished' }] })

    // 提交后的树能通过本仓库锁定的 OpenSpec（1.6.0）校验：它对 openspec/changes/ 下没有 delta 的任务目录一律判失败、
    // 只排除 archive/，所以不走 OpenSpec 的轻量任务必须搬进 archive/（check:openspec 的原始失败点）。
    const openspec = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'), 'validate', '--all', '--strict', '--no-interactive'],
      { cwd: h.cwd, encoding: 'utf8', env: { ...process.env, DO_NOT_TRACK: '1', OPENSPEC_TELEMETRY: '0' } },
    )
    expect(openspec.status, `${openspec.stdout}${openspec.stderr}`).toBe(0)
  })

  test('security 只在鉴权 / 依赖 / 契约路径变化时挂载：这次改动没碰到，不进评审者集合，也不能被派发', async () => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLite(tally)
    expect(await runStep(tally, ['transition', CHANGE, 'open-complete'])).toBe(0)
    await loadSkill(tally, 'tenon')
    await loadSkill(tally, 'test-driven-development')
    await fixTheBug()
    expect(await runStep(tally, ['transition', CHANGE, 'build-complete'])).toBe(1) // 必需测试没跑，被证据闸拒绝
    await userTrustsTestCommands(tally)
    for (const args of [['step', 'run', CHANGE], ['test', 'run', CHANGE, '--stage'], ['test', 'run', CHANGE, 'diff-risk']]) {
      expect(await runStep(tally, args), h.err.join('\n')).toBe(0)
    }
    expect(await runStep(tally, ['transition', CHANGE, 'build-complete']), h.err.join('\n')).toBe(0)
    await loadSkill(tally, 'tenon')
    await loadSkill(tally, 'verification-before-completion')
    const step = await readStep(tally)
    expect((step as unknown as { reviewers: { agent: string }[] }).reviewers.map((reviewer) => reviewer.agent)).toEqual(['code-review'])
    expect(await runStep(tally, ['agent', 'prompt', CHANGE, 'security', '--json'])).toBe(2)
    expect(h.err.join('\n')).toContain('只在 auth/dependency/contract 路径变化时挂载')
  })
})

describe('升级前创建的 standard 任务', () => {
  /** 这几类报错一出现，就说明执行在找已删除的 standard 模板 / 轨道，而不是按任务里冻结的快照走。 */
  const TEMPLATE_GONE = /未找到|已退役|没有轨道|未注册的 track/u

  test('按冻结快照从 open 走到完结：模板与项目里都没有 standard.yaml，每一步照快照执行、不报模板缺失', async () => {
    // 前提：升级后 standard 模板已删，夹具项目里也没有它——能走通只可能靠任务里冻结的快照。
    expect(existsSync(join(REPO_ROOT, 'templates', 'workflows', 'standard.yaml'))).toBe(false)
    expect(existsSync(join(h.cwd, '.pipeline', 'workflows', 'standard.yaml'))).toBe(false)

    // 整个过程的 stderr 都收下来（h.err 每条命令清一次）。
    const stderr: string[] = []
    const run = h.run
    h.run = async (args, options) => {
      const code = await run(args, options)
      stderr.push(...h.err)
      return code
    }

    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    expect(await h.initLegacyStandard(CHANGE), h.err.join('\n')).toBe(0)
    stderr.push(...h.err)
    expect(await runStep(tally, ['session', 'activate', CHANGE, '--host-session', 'lite-session']), h.err.join('\n')).toBe(0)
    await loadSkill(tally, 'tenon')

    // 计划来自冻结快照：工作流是 standard，执行模型是升级前的 step-graph。
    expect(await runStep(tally, ['workflow', 'plan', CHANGE, '--json']), h.err.join('\n')).toBe(0)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      source: 'frozen-snapshot', current_step: 'open', plan: { id: 'standard', executionModel: 'step-graph' },
    })

    const seen = await walkToFinish(tally)

    // open → build（TDD 技能、本阶段测试、快照里的 diff-risk 探针）→ verify（评审门）→ done 依次走过，最后是完结；
    // 没有越出 standard 的步骤（没有 escalated，也没有轻量轨道的步骤）。
    expect(seen).toEqual([
      'open/transition:open-complete', 'build/load-skill', 'build/run-tests', 'build/run-test',
      'build/transition:build-complete', 'verify/load-skill', 'verify/run-tests', 'verify/run-agent',
      'verify/request-review:verify-pass', 'verify/transition:verify-pass', 'done/finish-change', 'stop:finished',
    ])

    // 结果：目录已被 `tenon task finish` 移进 archive/，状态里仍是 standard / finished，代码修好了。
    expect(existsSync(changeDir())).toBe(false)
    const archiveRoot = join(h.cwd, 'openspec', 'changes', 'archive')
    const archivedName = (await readdir(archiveRoot)).find((entry) => entry.endsWith(`-${CHANGE}`))
    expect(archivedName).toBeDefined()
    const state = await readFile(join(archiveRoot, archivedName as string, '.pipeline.yaml'), 'utf8')
    expect(state).toMatch(/^workflow: standard$/mu)
    expect(state).toMatch(/^track: standard$/mu)
    expect(state).toMatch(/^task_result: finished$/mu)
    expect(await readFile(join(h.cwd, 'src', 'add.js'), 'utf8')).toBe('export function add(a, b) {\n  return a + b\n}\n')

    // 全程没有一条报错说模板 / 轨道缺失。
    expect(stderr.filter((line) => TEMPLATE_GONE.test(line)), stderr.join('\n')).toEqual([])
  })
})

describe('轻量轨道：风险升级', () => {
  /** 做完活之后，探针按各自的越线方式红掉；每一种都该让 next 只剩 scope-expanded。 */
  const OVERSTEPS: readonly (readonly [string, () => Promise<void>, RegExp])[] = [
    ['改动文件超过阈值', async () => {
      for (let index = 0; index < 9; index++) await put(`src/extra${index}.js`, `export const extra${index} = ${index}\n`)
    }, /files_changed/u],
    ['动了依赖清单', async () => {
      await put('package.json', `${JSON.stringify({ name: 'adder', private: true, type: 'module', scripts: { test: 'node --test' }, dependencies: { leftpad: '1.0.0' } }, null, 2)}\n`)
    }, /dependency_files/u],
    ['碰了鉴权路径', async () => { await put('src/auth/login.js', 'export const login = () => true\n') }, /auth_files/u],
    ['碰了接口契约', async () => { await put('api/openapi.yaml', 'openapi: 3.0.0\n') }, /contract_files/u],
    ['碰了迁移', async () => { await put('db/migrations/001_init.sql', 'select 1;\n') }, /migration_files/u],
    ['删了测试', async () => { expect(vcs(['rm', '-q', 'test/sum.test.js']).status).toBe(0) }, /deleted_tests/u],
  ]

  test.each(OVERSTEPS)('%s → 探针红，next 只剩 scope-expanded；放弃边不要求其余证据，转入 escalated，之后能另起 default 任务', async (_name, overstep, reason) => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLite(tally)
    expect(await runStep(tally, ['transition', CHANGE, 'open-complete'])).toBe(0)
    await loadSkill(tally, 'tenon')
    await loadSkill(tally, 'test-driven-development')
    await fixTheBug()
    await overstep()

    // 探针（内联步骤测试）红：只跑它，单测一次都没跑。
    expect(await h.run(['test', 'run', CHANGE, 'diff-risk'], { env: { TENON_TEST_TRUST: '1', TENON_TEST_TICKING_CLOCK: '1' } })).toBe(2)
    const step = await readStep(tally)
    expect(step.next).toHaveLength(1)
    expect(step.next[0]).toMatchObject({ action: 'transition', event: 'scope-expanded' })
    const escalate = step.next[0]?.escalate as { reasons: string[]; then: string }
    expect(escalate.reasons.join('；')).toMatch(reason)
    expect(escalate.then).toContain('--workflow default')
    // 创建时没有记领域：列出除轻量之外的全部分支，请用户选。
    expect(escalate.then).toContain('--track <pm|frontend|backend>')
    expect(escalate.then).toContain('请用户选领域')

    // 越过 next 直接走前进边会被必需测试证据拒绝——探针不是建议，是闸。
    expect(await h.run(['transition', CHANGE, 'build-complete'], NO_TRUST)).toBe(1)
    // 放弃边不要求单测、评审者、文档证据：没做完的活不该拦着任务被放弃。
    expect(await runStep(tally, ['transition', CHANGE, 'scope-expanded']), h.err.join('\n')).toBe(0)
    expect(await readFile(join(changeDir(), '.pipeline.yaml'), 'utf8')).toMatch(/phase:\s*escalated/u)
    const after = await readStep(tally)
    // 已升级：只剩归档命令，不带提交。
    expect(after.next).toEqual([{
      action: 'finish-change', change: CHANGE, command: `tenon task finish ${CHANGE}`, commit: null, cleanup: null,
    }])
    expect(await runStep(tally, ['task', 'finish', CHANGE]), h.err.join('\n')).toBe(0)
    expect(await h.run(['status', CHANGE, '--json'])).toBe(0)
    expect((JSON.parse(h.out.join('\n')) as { step: StepBlock }).step.next[0]).toMatchObject({ action: 'stop', code: 'finished' })
    // 放弃不是交付：工作区里的改动原样留给接手的 default 任务，不替它提交。
    expect(vcs(['log', '--format=%s', '-1']).output.trim()).toBe('fixture')

    // 之后另起 default 任务并记下依赖。
    expect(await h.run(['init', 'follow-up', '--workflow', 'default', '--track', 'backend', '--preset', 'full'], NO_TRUST), h.err.join('\n')).toBe(0)
    expect(await h.run(['set', 'follow-up', 'depends_on', CHANGE], NO_TRUST), h.err.join('\n')).toBe(0)
  })

  test('创建时记了 --domain frontend：escalate.then 直接给出 --track frontend，不再让用户选', async () => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLite(tally, ['--domain', 'frontend'])
    expect(await runStep(tally, ['get', CHANGE, 'domain'])).toBe(0)
    expect(h.out.join('\n')).toBe('frontend')
    expect(await runStep(tally, ['transition', CHANGE, 'open-complete'])).toBe(0)
    await loadSkill(tally, 'tenon')
    await loadSkill(tally, 'test-driven-development')
    await fixTheBug()
    for (let index = 0; index < 9; index++) await put(`src/extra${index}.js`, `export const extra${index} = ${index}\n`)
    expect(await h.run(['test', 'run', CHANGE, 'diff-risk'], { env: { TENON_TEST_TRUST: '1', TENON_TEST_TICKING_CLOCK: '1' } })).toBe(2)

    const step = await readStep(tally)
    expect(step.next[0]).toMatchObject({ action: 'transition', event: 'scope-expanded' })
    const escalate = step.next[0]?.escalate as { reasons: string[]; then: string }
    expect(escalate.then).toContain('tenon init <新任务> --workflow default --track frontend --preset full')
    expect(escalate.then).toContain('tenon set <新任务> depends_on <本任务>')
    expect(escalate.then).not.toContain('选领域')
    expect(escalate.then).not.toContain('<pm|frontend|backend>')
  })

  test('没越线时 next 里没有 scope-expanded，也不会因它出现 choose-exit', async () => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLite(tally)
    const seen = await walkToFinish(tally)
    expect(seen.some((entry) => entry.includes('scope-expanded') || entry.includes('choose-exit'))).toBe(false)
  })
})
