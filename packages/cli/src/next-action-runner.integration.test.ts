/**
 * 验收锚：一个只照 `tenon status <change> --json` 的 `step` 分块做事的运行器，必须能把一个
 * `default` 任务从 `open` 一路做到 `list --finished`——中途还改过一份已经登记的文档。
 *
 * 这里的运行器没有任何本地知识：它只认 `next` 里的动作名与动作自带的载荷（要读哪些文档、要用哪个
 * producer 登记、字段的枚举与推荐值、要跑哪条测试、走哪条出边），路径到 kind 的对应关系也只从同
 * 一份 `step.documents` 里取。任何一条 `next` 发出去却执行不了的动作，都会让这个用例当场红：
 * 真机验收那一轮就是这样连撞五处（scaffold 不推进状态、过期文档只发 read、ship 要 scaffold 一份
 * 契约里没有的文档、build 提前要 build_sha、回退边不带人工确认）。
 *
 * 零 mock：真临时项目、真 kernel、真文档台账、真测试记录；Skill 回执落在 PostToolUse hook 最终
 * 调用的那条生产命令上（`internal-native-skill-receipt`），时间戳跟 harness 的固定 clock 走。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { FIXED_CLOCK, freshHarness, REPO_ROOT, rm, type Harness } from './integration-harness.js'

const CHANGE = 'nextrun'
const FIXTURE_PACKAGE_JSON = `${JSON.stringify({
  name: 'tenon-next-runner-fixture',
  private: true,
  version: '0.0.0',
  scripts: { test: 'exit 0', typecheck: 'exit 0', 'test:integration': 'exit 0', bench: 'exit 0' },
}, null, 2)}\n`

interface StepDocumentView {
  readonly kind: string
  readonly path: string | null
  readonly producers: readonly string[]
  readonly status: string
}

interface StepAction {
  readonly action: string
  readonly [key: string]: unknown
}

interface StepBlock {
  readonly id: string
  readonly documents: { readonly reads: readonly StepDocumentView[] }
  readonly next: readonly StepAction[]
}

/** 自由文本交付槽本来就没有枚举；pr_url 的真值由投影给出（无远端 → no-remote），这里只剩 prd_path。 */
const FREEFORM: Readonly<Record<string, string>> = {
  prd_path: `docs/${CHANGE}-prd.md`,
}

const SHIP_TASK = 'update the usage docs'

const DESIGN_DOC = [
  '# design', '', '```coverage', 'touches:',
  ...['L1_api', 'L2_data', 'L3_rules', 'L4_state', 'L5_errors', 'L6_security', 'L7_perf', 'L8_deps', 'L10_terms']
    .map((layer) => `${layer}: filled -> §1`),
  '```', '',
].join('\n')

/** 骨架占位符的记号（与 kernel 模板渲染器同一份：`[待填写…]`、`: 待填写` 等）。 */
const PLACEHOLDER = /\[待填写|: 待填写$|\*\* 待填写$|- \[ \] 待填写$/mu

/** 作者写成的文档内容。delta spec 要过 OpenSpec strict 校验，所以写成一条真需求。 */
function authored(kind: string): string {
  // ship 段留一项未勾：ship 的 next 必须先发带这条原文的 fix（运行器照做去勾它），而不是
  // 越过它去 apply-spec。
  if (kind === 'tasks') {
    return '## Open\n- [x] scope\n## Build\n- [x] implementation\n## Verify\n- [x] verification\n'
      + `## Ship\n- [ ] ${SHIP_TASK}\n`
  }
  // 新 capability 主规格的 Purpose 取自 proposal（spec apply 不再留上游 TBD 占位）。
  if (kind === 'proposal') return '# proposal\n\n## Why\n\nThe runner flow needs a durable capability.\n'
  if (kind === 'delta-spec') {
    return [
      '# capability', '', '## ADDED Requirements', '',
      '### Requirement: Runner capability', 'The system SHALL complete the runner flow.', '',
      '#### Scenario: runner completes', '- **WHEN** the runner follows next', '- **THEN** the change finishes', '',
    ].join('\n')
  }
  return `# ${kind}\n\nwritten by the runner\n`
}

let h: Harness

/** 夹具是一个真 git 仓：只提交过 package.json，change 目录从未被跟踪（真机第二轮的失败形态）。 */
const GIT_IDENTITY = ['-c', 'user.name=runner', '-c', 'user.email=runner@example.com', '-c', 'commit.gpgsign=false']
function git(args: readonly string[]): { readonly status: number | null; readonly output: string } {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd: h.cwd, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** 完结动作的提交：照动作给的 paths 与 message 原样执行，两条命令都必须一次成功。 */
function commitAsInstructed(commit: { readonly paths: readonly string[]; readonly message: string }): void {
  const add = git(['add', '-A', '--', ...commit.paths])
  expect(add.status, `git add -A -- ${commit.paths.join(' ')}\n${add.output}`).toBe(0)
  const done = git(['commit', '-q', '-m', commit.message])
  expect(done.status, `git commit\n${done.output}`).toBe(0)
}
/** 让这一个评审者在第一次给结论时打回一次（D6 的回退边验收）。 */
let failOnce: string | undefined

function changeDir(name = CHANGE): string {
  return join(h.cwd, 'openspec', 'changes', name)
}

async function put(rel: string, body: string): Promise<void> {
  const abs = join(h.cwd, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body, 'utf8')
}

async function run(args: readonly string[]): Promise<void> {
  const code = await h.run([...args])
  if (code !== 0) {
    throw new Error(`runner: tenon ${args.join(' ')} exit=${code}\n${h.err.join('\n')}\n${h.out.join('\n')}`)
  }
}

/**
 * 宿主加载一个 Skill：落一行 PostToolUse 历史，再经生产命令把它绑定到 canonical StepVisit 上
 * （hooks/skill-tracker.sh 最终调用的就是这条）。时间戳跟 harness 的固定 clock 走，与文档登记
 * 时刻同一口径。
 */
let toolUseSeq = 0
async function loadSkill(skill: string, name = CHANGE): Promise<void> {
  toolUseSeq += 1
  await appendFile(
    join(changeDir(name), '.pipeline-history.jsonl'),
    `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: `Skill: ${skill}` })}\n`,
    'utf8',
  )
  await run(['internal-native-skill-receipt', name, skill, 'runner-session', `tool-${toolUseSeq}`, FIXED_CLOCK])
}

async function readStep(): Promise<StepBlock> {
  await run(['status', CHANGE, '--json'])
  const payload = JSON.parse(h.out.join('\n')) as { step?: StepBlock }
  if (payload.step === undefined) throw new Error(`runner: status 没有 step 分块\n${h.out.join('\n')}`)
  return payload.step
}

/** 一条 `next` 动作 → 真实命令。返回 true 表示这一步是终点。 */
async function perform(step: StepBlock, action: StepAction): Promise<boolean> {
  switch (action.action) {
    case 'load-tenon':
      await loadSkill('tenon')
      return false
    case 'load-skill':
      await loadSkill(String(action.skill))
      return false
    case 'read-documents': {
      // 动作给的是路径，命令吃的是 kind；两者出自同一份 step 分块，所以就在那里对应，
      // 不从外部知识补。两个 kind 共用一条路径时（superpower-plan 与 plan）都要读到。
      const kinds = new Set<string>()
      for (const path of action.documents as readonly string[]) {
        for (const doc of step.documents.reads) if (doc.path === path) kinds.add(doc.kind)
      }
      expect(kinds.size, `read-documents 的路径在 step.documents.reads 里必须找得到 kind：${JSON.stringify(action)}`)
        .toBeGreaterThan(0)
      for (const kind of kinds) await run(['document', 'read', CHANGE, kind])
      return false
    }
    case 'scaffold-document': {
      const args = ['document', 'scaffold', CHANGE, String(action.kind)]
      // path=null 时 path_template 说缺哪个变量；capability 由作者拍板，运行器就是那个作者。
      if (action.path === null) args.push('--capability', 'capability')
      await run(args)
      return false
    }
    case 'record-document': {
      const producer = (action.producers as readonly string[])[0]
      expect(producer, `record-document 必须带当前步认的 producer：${JSON.stringify(action)}`).toBeDefined()
      const path = (action.path as string | null) ?? `openspec/changes/${CHANGE}/specs/capability/spec.md`
      // 运行器替作者把活干完：骨架里满是占位符（登记闸拒收，D7），tasks.md 全是未勾选的框（而 open/spec
      // 出口要求全勾）。作者要做的就是把骨架写成真内容。
      const abs = join(h.cwd, path)
      // tasks 的骨架行（「将本阶段目标拆成可验证任务」）不带占位记号，按「还没写成作者的清单」判；
      // 写成之后（含运行器勾过的项）不再覆盖。
      const current = existsSync(abs) ? await readFile(abs, 'utf8') : null
      if (current === null || PLACEHOLDER.test(current) || (action.kind === 'tasks' && !current.includes(SHIP_TASK))) {
        await put(path, authored(String(action.kind)))
      }
      await loadSkill(producer!)
      await run(['document', 'record', CHANGE, String(action.kind), path, '--producer', producer!])
      return false
    }
    case 'set-field': {
      const value = (action.recommended as string | null)
        ?? (action.required as readonly string[] | null)?.[0]
        ?? (action.allowed as readonly string[] | null)?.[0]
        ?? FREEFORM[String(action.field)]
      expect(value, `set-field 必须给出可填的值：${JSON.stringify(action)}`).toBeDefined()
      if (action.field === 'prd_path') await put(FREEFORM.prd_path!, '# PRD\n')
      await run(['set', CHANGE, String(action.field), value!])
      return false
    }
    case 'register-field': {
      const producer = (action.producers as readonly string[])[0]
      expect(producer, `register-field 必须带合法 producer：${JSON.stringify(action)}`).toBeDefined()
      const path = `docs/${CHANGE}-${String(action.field)}.md`
      await put(path, action.field === 'design_doc' ? DESIGN_DOC : `# ${String(action.field)}\n`)
      await loadSkill(producer!)
      await run(['artifact', 'register', CHANGE, String(action.field), path, '--producer', producer!])
      return false
    }
    case 'run-test':
      await run(['test', 'run', CHANGE, String(action.test)])
      return false
    case 'run-agent': {
      // 带 run_id 的是已经在跑的那次：不重开，写报告后登记它。
      let row: { run_id: string; report_path: string; role: string }
      if (typeof action.run_id === 'string') {
        row = { run_id: action.run_id, report_path: String(action.report_path), role: String(action.role) }
      } else {
        await run(['agent', 'prompt', CHANGE, String(action.agent), '--json'])
        row = JSON.parse(h.out.join('')) as { run_id: string; report_path: string; role: string }
      }
      const blocking = failOnce === action.agent
      if (blocking) failOnce = undefined
      const findings = blocking
        ? '[{"severity":"high","location":"src/x.ts:1","message":"blocking finding"}]'
        : '[]'
      const body = row.role === 'executor'
        ? `{"result":"done","findings":${findings}}`
        : `{"findings":${findings}}`
      await put(row.report_path, `# ${String(action.agent)}\n\n\`\`\`tenon-result\n${body}\n\`\`\`\n`)
      await run(['agent', 'record', CHANGE, row.run_id])
      return false
    }
    // 未勾任务：动作自带未勾项原文，运行器就是做完它们的作者——逐条勾上。
    case 'fix': {
      const blockers = action.blockers as readonly { source: string; items?: readonly string[] }[]
      const items = blockers.filter((item) => item.source === 'tasks').flatMap((item) => item.items ?? [])
      expect(items.length, `fix 必须是能照做的未勾任务（带原文）：${JSON.stringify(action)}`).toBeGreaterThan(0)
      const tasksPath = join(changeDir(), 'tasks.md')
      let text = await readFile(tasksPath, 'utf8')
      for (const item of items) text = text.replace(`- [ ] ${item}`, `- [x] ${item}`)
      await writeFile(tasksPath, text, 'utf8')
      return false
    }
    case 'apply-spec':
      await run(['spec', 'apply', CHANGE])
      return false
    case 'validate-spec':
      await run(['spec', 'apply', CHANGE, '--dry-run'])
      return false
    case 'request-review':
      await run(['review', 'request', CHANGE, '--event', String(action.event)])
      return false
    case 'await-review':
      await run(['review', 'acknowledge', CHANGE])
      return false
    case 'transition':
    case 'complete':
      await run(['transition', CHANGE, String(action.event)])
      return false
    case 'choose-exit':
      await run(['transition', CHANGE, String((action.exits as readonly string[])[0])])
      return false
    // 治理归档是 OpenSpec 自己的命令（动作自带整条命令），到这里状态机已经完结。运行器照原样跑它，
    // 再照动作给的 paths 提交这次搬移——change 目录从未被 git 跟踪，paths 不能点名它（搬走之后
    // `git add` 会以 pathspec did not match 整条失败）。
    case 'finish-change': {
      const commit = action.commit as { paths: readonly string[]; message: string }
      expect(commit).toEqual({
        paths: ['openspec/changes/archive'],
        message: `chore(openspec): archive ${CHANGE}`,
      })
      const [bin, ...args] = String(action.command).split(' ')
      execFileSync(bin!, args, {
        cwd: h.cwd,
        env: { ...process.env, PATH: `${join(REPO_ROOT, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` },
        stdio: 'ignore',
      })
      expect(existsSync(changeDir()), 'openspec archive 必须真的把 change 目录搬走').toBe(false)
      commitAsInstructed(commit)
      expect(git(['status', '--porcelain', '--', 'openspec/changes']).output).toBe('')
      return true
    }
    default:
      throw new Error(`runner: next 给了执行不了的动作 ${JSON.stringify(action)}`)
  }
}

beforeEach(async () => {
  failOnce = undefined
  h = await freshHarness()
  await writeFile(join(h.cwd, 'package.json'), FIXTURE_PACKAGE_JSON, 'utf8')
  expect(git(['init', '-q']).status).toBe(0)
  expect(git(['add', 'package.json']).status).toBe(0)
  expect(git(['commit', '-q', '-m', 'fixture']).status).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

interface WalkOptions {
  readonly track?: string
  readonly editAt?: string
  /** 每条动作照做之前的观察点（用例在这里探测 CLI 对「越过 next 的写法」的拒绝）。 */
  readonly before?: (step: StepBlock, action: StepAction) => Promise<void>
}

/** 跑完整条链；返回每一轮所在的 step 与所有下发过的动作名。 */
async function walk(options: WalkOptions = {}): Promise<{
  readonly seen: readonly string[]
  readonly actions: readonly { readonly step: string; readonly action: StepAction }[]
}> {
  const track = options.track ?? 'backend'
  expect(await h.run(['init', CHANGE, '--track', track, '--preset', 'full'])).toBe(0)
  // Skill 回执绑定当前用户的活跃任务，真实宿主会话就是这样起头的。
  expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
  const proposal = join(changeDir(), 'proposal.md')
  const seen: string[] = []
  const actions: { step: string; action: StepAction }[] = []
  let edited = options.editAt === undefined
  for (let round = 1; round <= 160; round++) {
    const step = await readStep()
    seen.push(step.id)
    // 已登记的文档在相位中途被改：它的状态变 stale，读不动了。
    if (!edited && step.id === options.editAt) {
      edited = true
      await writeFile(proposal, `${await readFile(proposal, 'utf8')}\n调研后补的一段。\n`, 'utf8')
      continue
    }
    expect(step.next.length, `phase=${step.id} 的 next 不能是空的`).toBeGreaterThan(0)
    let done = false
    for (const action of step.next) {
      actions.push({ step: step.id, action })
      await options.before?.(step, action)
      done = (await perform(step, action)) || done
    }
    if (done) {
      expect(edited, '用例必须真的改过一份已登记的文档').toBe(true)
      // 搬进 archive/ 之后没有可做的事了：step 省略，任务在 finished_changes（与 simple 收尾后同一形态）。
      await run(['status', CHANGE, '--json'])
      const after = JSON.parse(h.out.join('\n')) as { step?: unknown; finished_changes?: readonly { name: string }[] }
      expect(after.step).toBeUndefined()
      expect(after.finished_changes?.map((row) => row.name)).toEqual([CHANGE])
      // 已完结的 test status 不再是空 items：按步骤给出每项测试的最后记录，并点名完整报告。
      await run(['test', 'status', CHANGE, '--json'])
      const tests = JSON.parse(h.out.join('\n')) as {
        finished: boolean; report: string; items: readonly { step: string; id: string; run?: { result: string } }[]
      }
      expect(tests.finished).toBe(true)
      expect(tests.report).toBe(`tenon test report ${CHANGE}`)
      expect(tests.items.map((item) => [item.step, item.id, item.run?.result]))
        .toEqual(track === 'backend' ? [['build', 'unit', 'pass'], ['verify', 'integration', 'pass']] : [])
      await run(['list', '--finished', '--json'])
      const finished = JSON.parse(h.out.join('\n')) as { finished: readonly { name: string; archived: string }[] }
      expect(finished.finished).toEqual([expect.objectContaining({ name: CHANGE, archived: 'true' })])
      return { seen, actions }
    }
  }
  throw new Error(`runner: 160 轮还没走到完结，最后停在 ${seen[seen.length - 1]}`)
}

describe('照着 next 做事的运行器：open → 完结', () => {
  test('中途改掉一份已登记的文档，仍然能一路做到 list --finished', async () => {
    const { seen, actions } = await walk({ editAt: 'explore' })
    expect(new Set(seen)).toEqual(new Set(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']))
    // D1：过期的 proposal 在 explore 被重新登记（producer 是 explore 认的那个），而不是再读一次。
    expect(actions.some(({ step, action }) => step === 'explore'
      && action.action === 'record-document'
      && action.kind === 'proposal'
      && (action.producers as readonly string[]).includes('tenon'))).toBe(true)
    // 技能与产物绑定：brainstorming 调用之后，next 给的是它本步的文档，而不是再调用一次。
    expect(actions.some(({ step, action }) => step === 'explore'
      && action.action === 'record-document' && action.skill === 'brainstorming'
      && action.kind === 'superpower-design')).toBe(true)
    expect(actions.filter(({ step, action }) => step === 'explore'
      && action.action === 'load-skill' && action.skill === 'brainstorming')).toHaveLength(1)
    // D4：build 从头到尾没被要求手填 build_sha——它由 build 出口的转换冻结。
    expect(actions.filter(({ action }) => action.action === 'set-field' && action.field === 'build_sha')).toEqual([])
    // D8：夹具项目没有远端——pr_url 的真值是 no-remote，由 next 直接给出，不靠编造 URL。
    expect(actions.filter(({ action }) => action.action === 'set-field' && action.field === 'pr_url')
      .map(({ action }) => action.recommended)).toEqual(['no-remote'])
    // D16：采纳推荐的 build_mode 之后不再要求风险豁免 direct_override。
    expect(actions.filter(({ action }) => action.action === 'set-field' && action.field === 'direct_override')).toEqual([])
    // 结论字段没有推荐值，只给出口要的值；它排在本步必需测试之后（写入时 CLI 核对这份证据）。
    const verdict = actions.findIndex(({ action }) =>
      action.action === 'set-field' && action.field === 'pre_verify_review_result')
    expect(actions[verdict]?.action).toMatchObject({ recommended: null, required: ['pass'] })
    expect(actions.findIndex(({ step, action }) => step === 'build' && action.action === 'run-test'))
      .toBeLessThan(verdict)
    // 决定类字段在动手之前：build 的 build_mode / isolation 先于本步第一次加载技能。
    const buildStart = actions.findIndex(({ step }) => step === 'build')
    const firstBuildSkill = actions.findIndex(({ step, action }, index) =>
      index > buildStart && step === 'build' && action.action === 'load-skill')
    for (const decision of ['build_mode', 'isolation']) {
      const at = actions.findIndex(({ step, action }) =>
        step === 'build' && action.action === 'set-field' && action.field === decision)
      expect(at, `${decision} 必须在 build 下发`).toBeGreaterThan(-1)
      expect(at, `${decision} 必须先于 build 的第一次 load-skill`).toBeLessThan(firstBuildSkill)
    }
    // ship 的未勾任务：带原文的 fix 先于 apply-spec。
    const shipFix = actions.findIndex(({ step, action }) => step === 'ship' && action.action === 'fix')
    expect(actions[shipFix]?.action).toMatchObject({
      blockers: [expect.objectContaining({ source: 'tasks', items: [SHIP_TASK] })],
    })
    expect(shipFix).toBeLessThan(actions.findIndex(({ action }) => action.action === 'apply-spec'))
    // 新 capability 的主规格带真实 Purpose（出自 proposal 的 ## Why），不是上游 archive 的 TBD 占位。
    const mainSpec = await readFile(join(h.cwd, 'openspec', 'specs', 'capability', 'spec.md'), 'utf8')
    expect(mainSpec).not.toContain('TBD')
    expect(mainSpec).toContain('The runner flow needs a durable capability.')
  })

  /**
   * D6：评审门上的回退边同样要人工确认。评审者打回之后，`next` 必须自己发
   * request-review → await-review → transition，而不是直接让人去跑一条会被
   * 「尚未取得人工确认」拒掉的 transition。
   */
  test('评审者打回一次：走完回退边的人工确认链，再一路做到完结', async () => {
    failOnce = 'security'
    const { seen, actions } = await walk({ editAt: 'explore' })
    expect(failOnce, '用例必须真的让一个评审者打回过').toBeUndefined()
    // verify → build → verify：build 出现过两次。
    expect(seen.filter((id, index) => id === 'build' && seen[index - 1] === 'verify')).toHaveLength(1)
    const failRequest = actions.findIndex(({ step, action }) => step === 'verify'
      && action.action === 'request-review' && action.event === 'verify-fail')
    expect(failRequest).toBeGreaterThan(-1)
    // D2：评审者打回的那次访问里，next 不要结果字段——回退边之前一条 set-field 都没有。
    const firstVerify = actions.findIndex(({ step }) => step === 'verify')
    expect(actions.slice(firstVerify, failRequest)
      .filter(({ action }) => action.action === 'set-field')).toEqual([])
    expect(actions.some(({ step, action }) => step === 'verify'
      && action.action === 'await-review' && action.event === 'verify-fail')).toBe(true)
    // 第二次进入 verify：上一次访问登记的 verification-report 不算，next 让它的 producer 在本次访问
    // 重新登记——台账上那份仍是 recorded，按台账状态派的写入分支一条都不会发。
    expect(actions.filter(({ step, action }) => step === 'verify'
      && action.action === 'record-document' && action.kind === 'verification-report'
      && action.skill === 'verification-before-completion')).toHaveLength(2)
  })

  /**
   * 真机（第二轮）：free / pm / chat 的 build 不声明测试或评审者，`pre_verify_review_result pass`
   * 没有可核对的证据，模型直接 set 通过。现在这些轨道的 build 声明必需评审者 spec-consistency：
   * next 先让它跑，评审通过之前 `tenon set … pass` 被拒。
   */
  test('free 轨：build 的通过结论要等必需评审者 spec-consistency 通过', async () => {
    let refusedBeforeReview = false
    const { seen, actions } = await walk({
      track: 'free',
      before: async (step, action) => {
        if (step.id !== 'build' || action.action !== 'run-agent' || refusedBeforeReview) return
        expect(await h.run(['set', CHANGE, 'pre_verify_review_result', 'pass'])).toBe(1)
        expect(h.err.join('\n')).toContain('必需评审者 spec-consistency 未通过')
        refusedBeforeReview = true
      },
    })
    expect(new Set(seen)).toEqual(new Set(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']))
    expect(refusedBeforeReview, 'build 里必须先出现评审者，且越过它的自批被拒').toBe(true)
    const review = actions.findIndex(({ step, action }) => step === 'build'
      && action.action === 'run-agent' && action.agent === 'spec-consistency' && action.role === 'reviewer')
    const verdict = actions.findIndex(({ step, action }) => step === 'build'
      && action.action === 'set-field' && action.field === 'pre_verify_review_result')
    expect(review).toBeGreaterThan(-1)
    expect(review).toBeLessThan(verdict)
  })

  /** D7：不存在的任务是产品层的一句话，不是一行 ENOENT。 */
  test('不存在的任务：status 给产品层文案', async () => {
    expect(await h.run(['status', 'no-such-change'])).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: change 不存在: no-such-change')
  })
})

/**
 * 真机（第二轮）：simple 工作流 verify-pass 后直接完结，功能代码与任务状态文件全留在工作区未提交；
 * 已完结的 simple 任务 status 还带着 `step.archived: false`。收尾的 next 是只带提交的
 * finish-change（没有归档命令），照做一次成功；提交之后 step 省略，与 default 搬进 archive/ 后同一形态。
 */
describe('照着 next 做事的运行器：simple 工作流', () => {
  const SIMPLE = 'tiny'

  test('verify-pass 完结后 next 给出一次成功的提交；提交之后 step 省略', async () => {
    expect(await h.run(['init', SIMPLE, '--track', 'simple', '--preset', 'tweak'])).toBe(0)
    expect(await h.run(['session', 'activate', SIMPLE])).toBe(0)
    await put('src/typo.txt', 'fixed the typo\n')
    const seen: string[] = []
    for (let round = 1; round <= 30; round++) {
      await run(['status', SIMPLE, '--json'])
      const payload = JSON.parse(h.out.join('\n')) as {
        step?: { id: string; archived: boolean; next: readonly StepAction[] }
        finished_changes?: readonly { name: string }[]
      }
      if (payload.step === undefined) {
        expect(payload.finished_changes?.map((row) => row.name)).toEqual([SIMPLE])
        expect(seen).toContain('finish-change')
        expect(git(['status', '--porcelain']).output).toBe('')
        return
      }
      for (const action of payload.step.next) {
        seen.push(action.action)
        switch (action.action) {
          case 'load-tenon':
            await loadSkill('tenon', SIMPLE)
            break
          case 'load-skill':
            await loadSkill(String(action.skill), SIMPLE)
            break
          case 'transition':
          case 'complete':
            await run(['transition', SIMPLE, String(action.event)])
            break
          case 'choose-exit': {
            const exits = action.exits as readonly string[]
            await run(['transition', SIMPLE, exits.includes('verify-pass') ? 'verify-pass' : exits.includes('change-complete') ? 'change-complete' : exits[0]!])
            break
          }
          case 'finish-change':
            expect(payload.step.archived, '已完结的 change：step.archived 为 true').toBe(true)
            expect(action).toEqual({
              action: 'finish-change',
              change: SIMPLE,
              command: null,
              commit: { paths: ['.'], message: `chore(tenon): finish ${SIMPLE}` },
            })
            commitAsInstructed(action.commit as { paths: readonly string[]; message: string })
            break
          default:
            throw new Error(`runner(simple): next 给了执行不了的动作 ${JSON.stringify(action)}`)
        }
      }
    }
    throw new Error(`runner(simple): 30 轮还没走到完结：${seen.join(' → ')}`)
  })

  test('scope-expanded 放弃：不发提交，step 省略', async () => {
    expect(await h.run(['init', SIMPLE, '--track', 'simple', '--preset', 'tweak'])).toBe(0)
    expect(await h.run(['transition', SIMPLE, 'scope-expanded'])).toBe(0)
    await run(['status', SIMPLE, '--json'])
    const payload = JSON.parse(h.out.join('\n')) as { step?: unknown; finished_changes?: readonly { name: string }[] }
    expect(payload.step).toBeUndefined()
    expect(payload.finished_changes?.map((row) => row.name)).toEqual([SIMPLE])
  })
})
