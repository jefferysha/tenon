/**
 * standard 通道验收：一个 3 文件缺陷修复从 init 走到完结，只照 `tenon status --json` 的 `step.next` 做。
 *
 * 计数口径（审计 §3 的「70–90 次 tenon 调用 / 6+ 次用户回复」同一口径）：
 *   · tenon 调用 = 助手自己执行的每一条 `tenon …` 命令，status 与 step run 都算；hook 在宿主里自己触发的内部回执
 *     （技能加载）不算助手的调用，另外报告；
 *   · 用户回复 = 用户必须亲自做的事：在自己的终端确认测试命令的信任（`tenon test trust`）、对评审门说「确认继续」。
 *
 * 零 mock：真临时项目 + 真仓库 + 真 kernel；风险探针 `tenon test diff-risk` 由测试进程 PATH 上的桩转交给
 * 真实 CLI（TENON_TEST_REAL_DIFF=1），读到的是夹具仓库里真实的改动。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'fix-add'
const GIT_ARGS = ['-c', 'user.name=runner', '-c', 'user.email=runner@example.com', '-c', 'commit.gpgsign=false']
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

/** 夹具提交要早于 harness 的固定时钟（任务创建时刻），任务起点才是这次提交而不是空树。 */
const FIXTURE_DATE = '2026-06-01T00:00:00Z'

function vcs(args: readonly string[]): { readonly status: number | null; readonly output: string } {
  const result = spawnSync('git', [...GIT_ARGS, ...args], {
    cwd: h.cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: FIXTURE_DATE, GIT_COMMITTER_DATE: FIXTURE_DATE },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

async function put(rel: string, body: string): Promise<void> {
  const abs = join(h.cwd, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body, 'utf8')
}

/** 夹具：一个 add 写成了减法的小库；sum 依赖它，已有的 sum 测试因此是红的。 */
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
  expect(await h.run(['internal-native-skill-receipt', CHANGE, skill, 'lane-session', `tool-${toolUseSeq}`, observedAt], NO_TRUST),
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

async function startLane(tally: Tally): Promise<void> {
  expect(await runStep(tally, ['init', CHANGE, '--workflow', 'standard', '--track', 'standard']), h.err.join('\n')).toBe(0)
  expect(await runStep(tally, ['session', 'activate', CHANGE, '--host-session', 'lane-session']), h.err.join('\n')).toBe(0)
  // 新建之后立即重新加载 tenon：新的步骤访问，第一轮读 next 就不会只是 load-tenon。
  await loadSkill(tally, 'tenon')
  expect(await runStep(tally, ['workflow', 'plan', CHANGE, '--json'])).toBe(0)
}

describe('standard 通道：3 文件缺陷修复', () => {
  test('从 init 走到完结：≤25 次 tenon 调用、≤2 次用户回复，代码真的修好并提交', async () => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLane(tally)
    const seen = await walkToFinish(tally)

    // 通道本身：四步走完，没有 explore / 访谈类技能，也没有 scope-expanded 被推荐。
    expect(seen.filter((entry) => entry.startsWith('open/') || entry.startsWith('build/') || entry.startsWith('verify/')))
      .toEqual([
        'open/transition:open-complete', 'build/load-skill', 'build/run-tests', 'build/run-test',
        'build/transition:build-complete', 'verify/load-skill', 'verify/run-tests', 'verify/run-agent',
        'verify/request-review:verify-pass', 'verify/transition:verify-pass',
      ])
    expect(seen.some((entry) => entry.includes('scope-expanded'))).toBe(false)

    // 验收：调用数与用户回复数（审计基线：70–90 次调用、6+ 次回复）。
    console.log(`standard-lane: ${tally.commands.length} 次 tenon 调用（hook 回执 ${tally.hookReceipts}），${tally.replies.length} 次用户回复：${tally.replies.join(' / ')}`)
    expect(tally.commands.length, tally.commands.join('\n')).toBeLessThanOrEqual(25)
    expect(tally.replies.length, tally.replies.join(' / ')).toBeLessThanOrEqual(2)

    // 结果：任务以验证通过收尾，代码修好了，整个工作区一次提交，工作区干净。
    const state = await readFile(join(changeDir(), '.pipeline.yaml'), 'utf8')
    expect(state).toContain('workflow: standard')
    expect(state).toMatch(/verify_result:\s*pass/u)
    expect(spawnSync('node', ['--test'], { cwd: h.cwd, encoding: 'utf8' }).status).toBe(0)
    expect(vcs(['log', '--format=%s', '-1']).output.trim()).toBe(`chore(tenon): finish ${CHANGE}`)
    expect(vcs(['status', '--porcelain']).output).toBe('')
    expect(await h.run(['status', CHANGE, '--json'])).toBe(0)
    expect(JSON.parse(h.out.join('\n')).step).toMatchObject({ archived: true, next: [{ action: 'stop', code: 'finished' }] })
  })

  test('security 只在鉴权 / 依赖 / 契约路径变化时挂载：这次改动没碰到，不进评审者集合，也不能被派发', async () => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLane(tally)
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

describe('standard 通道：风险升级', () => {
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
    await startLane(tally)
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

    // 越过 next 直接走前进边会被必需测试证据拒绝——探针不是建议，是闸。
    expect(await h.run(['transition', CHANGE, 'build-complete'], NO_TRUST)).toBe(1)
    // 放弃边不要求单测、评审者、文档证据：没做完的活不该拦着任务被放弃。
    expect(await runStep(tally, ['transition', CHANGE, 'scope-expanded']), h.err.join('\n')).toBe(0)
    expect(await readFile(join(changeDir(), '.pipeline.yaml'), 'utf8')).toMatch(/phase:\s*escalated/u)
    const after = await readStep(tally)
    expect(after.next[0]).toMatchObject({ action: 'stop', code: 'finished' })
    // 放弃不是交付：工作区里的改动原样留给接手的 default 任务，不替它提交。
    expect(vcs(['log', '--format=%s', '-1']).output.trim()).toBe('fixture')

    // 之后另起 default 任务并记下依赖。
    expect(await h.run(['init', 'follow-up', '--workflow', 'default', '--track', 'backend', '--preset', 'full'], NO_TRUST), h.err.join('\n')).toBe(0)
    expect(await h.run(['set', 'follow-up', 'depends_on', CHANGE], NO_TRUST), h.err.join('\n')).toBe(0)
  })

  test('没越线时 next 里没有 scope-expanded，也不会因它出现 choose-exit', async () => {
    const tally: Tally = { commands: [], replies: [], hookReceipts: 0 }
    await startLane(tally)
    const seen = await walkToFinish(tally)
    expect(seen.some((entry) => entry.includes('scope-expanded') || entry.includes('choose-exit'))).toBe(false)
  })
})
