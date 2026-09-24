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

/** `step` 分块的键序（schema）：活跃与已完结的任务同一形态。 */
const STEP_KEYS = [
  'schema', 'change', 'workflow', 'track', 'source', 'id', 'label', 'prompt', 'gate', 'mode', 'archived',
  'governed_openspec', 'candidate', 'skills', 'executors', 'reviewers', 'tests', 'documents', 'fields', 'review',
  'exits', 'next',
]

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

interface FinishCommit {
  readonly paths: readonly string[]
  readonly untrack: readonly string[]
  readonly message: string
}

/** 交付与 simple 收尾的提交范围：整个工作区，去掉仓库根的本机门禁标记与旧版本地文件。 */
const WORKSPACE_PATHS = [
  '.',
  ':(exclude).pipeline-pending-confirm',
  ':(exclude).pipeline-pending-review',
  ':(exclude).pipeline-pending-interaction',
  ':(exclude).pipeline-active',
  ':(exclude).pipeline-interaction-authority',
]

/** 完结动作的提交：照动作给的 paths / untrack / message 原样执行，每条命令都必须一次成功。 */
function commitAsInstructed(commit: FinishCommit): void {
  const add = git(['add', '-A', '--', ...commit.paths])
  expect(add.status, `git add -A -- ${commit.paths.join(' ')}\n${add.output}`).toBe(0)
  if (commit.untrack.length > 0) {
    const untrack = git(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...commit.untrack])
    expect(untrack.status, untrack.output).toBe(0)
  }
  const done = git(['commit', '-q', '-m', commit.message])
  expect(done.status, `git commit\n${done.output}`).toBe(0)
}
/** 让这一个评审者在第一次给结论时打回一次（D6 的回退边验收）。 */
let failOnce: string | undefined
/** 每个 agent 最近一次 `agent prompt` 给出的提示词（宿主交给子 agent 的全文）。 */
const agentPrompts = new Map<string, string>()

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
        const prompted = JSON.parse(h.out.join('')) as { run_id: string; report_path: string; role: string; prompt: string }
        agentPrompts.set(String(action.agent), prompted.prompt)
        row = prompted
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
      const blockers = action.blockers as readonly { source: string; code: string; message: string; items?: readonly string[] }[]
      // 必需测试未配置：运行器就是配置它的作者——按提示把真正运行这类测试的脚本加进 package.json。
      const unconfigured = blockers.filter((item) => item.code === 'test-unconfigured')
      if (unconfigured.length > 0) {
        for (const item of unconfigured) {
          const script = /npm 脚本 '([^']+)'/u.exec(item.message)?.[1]
          expect(script, `test-unconfigured 必须点名要配置的脚本：${item.message}`).toBeDefined()
          const pkg = JSON.parse(await readFile(join(h.cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
          pkg.scripts[script!] = 'node -e "process.exit(0)"'
          await writeFile(join(h.cwd, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
        }
        return false
      }
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
    // 交付步点名的提交：照原样执行（运行器从不自己决定提交什么）。门禁标记不能被带进去。
    case 'commit': {
      const commit = action.commit as FinishCommit
      expect(commit).toEqual({ paths: WORKSPACE_PATHS, untrack: [], message: `feat(${CHANGE}): deliver` })
      // 宿主的门禁标记此刻就在仓库根上（hook 写的）：照做的提交不能把它带进去。
      await put('.pipeline-pending-interaction', 'brainstorming\n')
      commitAsInstructed(commit)
      expect(git(['ls-files', '--', '.pipeline-pending-interaction']).output).toBe('')
      await rm(join(h.cwd, '.pipeline-pending-interaction'), { force: true })
      // 提交之后交付物干净（change 目录之后的改动由完结的 finish-change 负责）。
      expect(git(['status', '--porcelain', '--', '.', `:(exclude)openspec/changes/${CHANGE}`]).output).toBe('')
      return false
    }
    // 治理归档是 OpenSpec 自己的命令（动作自带整条命令），到这里状态机已经完结。运行器照原样跑它，
    // 再照动作给的 paths 提交这次搬移——change 目录从未被 git 跟踪，paths 不能点名它（搬走之后
    // `git add` 会以 pathspec did not match 整条失败）。
    case 'finish-change': {
      const commit = action.commit as FinishCommit
      // 原目录已随交付提交入库，列出（-A 据索引项暂存搬走后的删除）；其后 archive/ 与存在且未被忽略的
      // 状态目录 .gitignore。
      expect(commit).toEqual({
        paths: [`openspec/changes/${CHANGE}`, 'openspec/changes/archive',
          ...['.pipeline/.gitignore', '.tenon/.gitignore', 'openspec/.gitignore']
            .filter((path) => existsSync(join(h.cwd, path)))],
        untrack: [],
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
      // 收尾之后整个工作区干净：交付物（代码、主规格、测试记录、.gitignore）由交付步的 commit
      // 提交，搬移由这里提交；运行器从不自己提交。
      expect(git(['status', '--porcelain', '--untracked-files=all']).output).toBe('')
      return true
    }
    default:
      throw new Error(`runner: next 给了执行不了的动作 ${JSON.stringify(action)}`)
  }
}

beforeEach(async () => {
  failOnce = undefined
  agentPrompts.clear()
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
    expect(Object.keys(step)).toEqual(STEP_KEYS)
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
      // 搬进 archive/ 之后没有可做的事了：step 照样在（结构与活跃任务一致），next 是 stop finished；
      // 任务在 finished_changes（与 simple 收尾后同一形态）。
      await run(['status', CHANGE, '--json'])
      const after = JSON.parse(h.out.join('\n')) as { step?: Record<string, unknown>; finished_changes?: readonly { name: string }[] }
      expect(Object.keys(after.step ?? {})).toEqual(STEP_KEYS)
      expect(after.step).toMatchObject({ archived: true, next: [{ action: 'stop', code: 'finished' }] })
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

// 整条流程真起 CLI 子进程：单跑约 16 s，全量并发时会越过默认 30 s。
describe('照着 next 做事的运行器：open → 完结', { timeout: 120_000 }, () => {
  test('中途改掉一份已登记的文档，仍然能一路做到 list --finished', async () => {
    const { seen, actions } = await walk({ editAt: 'explore' })
    expect(new Set(seen)).toEqual(new Set(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']))
    // D1：过期的 proposal 在 explore 被重新登记（producer 是 explore 认的那个），而不是再读一次。
    expect(actions.some(({ step, action }) => step === 'explore'
      && action.action === 'record-document'
      && action.kind === 'proposal'
      && (action.producers as readonly string[]).includes('tenon'))).toBe(true)
    // 真机（第四轮）：读输入时说清哪些本步能改。explore 的契约让 proposal 可改（role update），
    // build 的输入里只有 tasks 可动（勾选），计划与设计只读。
    const readsAt = (id: string) => actions.filter(({ step, action }) => step === id && action.action === 'read-documents')
      .map(({ action }) => action)
    expect(readsAt('explore').some((action) => (action.editable as readonly string[]).includes('proposal'))).toBe(true)
    expect(readsAt('build').length).toBeGreaterThan(0)
    for (const action of readsAt('build')) {
      // build 只能勾 tasks；计划、设计、proposal 都只读。
      expect(action.editable).toEqual(['tasks'])
      expect(String(action.note)).toContain('requirements-changed')
    }
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
    // Purpose 段与下一个标题之间有空行（上游归档重排时吃掉了它）。
    expect(mainSpec).toContain('## Purpose\nThe runner flow needs a durable capability.\n\n## Requirements')
    // 交付物在交付步由 next 点名提交，排在交付值 pr_url 之前（开 PR 要先有提交）。
    const deliver = actions.findIndex(({ step, action }) => step === 'ship' && action.action === 'commit')
    expect(deliver).toBeGreaterThan(-1)
    expect(deliver).toBeLessThan(actions.findIndex(({ action }) => action.action === 'set-field' && action.field === 'pr_url'))
    // 真机（第四轮）：勾选先于提交。交付物未提交时先 commit，再勾剩下的任务；之后应用进主规格的改动
    // 在交付值之前再提交一次。
    expect(deliver).toBeLessThan(shipFix)
    const lastDeliver = actions.map(({ action }) => action.action).lastIndexOf('commit')
    expect(lastDeliver).toBeGreaterThan(actions.findIndex(({ action }) => action.action === 'apply-spec'))
    // 交付提交带上了代码之外的交付物：已应用的主规格、测试记录与状态目录的 .gitignore。
    const delivered = git(['log', '--name-only', '--format=', `--grep=^feat(${CHANGE}): deliver$`]).output
    expect(delivered).toContain('openspec/specs/capability/spec.md')
    expect(delivered).toMatch(/^\.tenon\/users\/[^/]+\/tests\/.+\.json$/mu)
    expect(delivered).toContain('.tenon/.gitignore')
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
    // 真机（第四轮）：为满足必需测试补的脚本被规格一致性评审判成「多做」medium 阻断。评审者说明里
    // 写明它不算规格偏差。
    expect(agentPrompts.get('spec-consistency')).toContain('工作流必需测试的配置不算多做')
  })

  /**
   * 真机（第二轮）：项目没有 `test:integration` 脚本，backend verify 的必需测试只能被记成一次失败，
   * 模型加了一条与 npm test 相同的脚本凑数。现在 `tenon test run` 说「未配置」（不落记录）。
   * 真机（第三轮）：这条 fix 到 build 才出现，模型把「补测试」写回 spec 已登记的计划与设计，只能
   * requirements-changed 回到 spec（backend 两次）。现在计划步（spec，产出 plan）就把之后所有步骤的
   * 未配置测试提出来，排在本步任何文档写入之前，让它进计划；之后一路没有回退。
   */
  test('项目没有 test:integration：计划步（spec）就要求配置，先于本步文档；未配置时 test run 拒跑、不落记录', async () => {
    const pkg = JSON.parse(FIXTURE_PACKAGE_JSON) as { scripts: Record<string, string> }
    delete pkg.scripts['test:integration']
    await writeFile(join(h.cwd, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    let probed = false
    const { actions } = await walk({
      before: async (step, action) => {
        if (probed || action.action !== 'fix') return
        probed = true
        expect(step.id).toBe('spec')
        expect(await h.run(['test', 'run', CHANGE, 'integration'])).toBe(1)
        expect(h.err.join('\n')).toContain("测试 'integration' 未配置（test-unconfigured，不是失败）")
        expect(await h.run(['test', 'status', CHANGE, '--step', 'verify', '--json'])).toBe(2)
        const status = JSON.parse(h.out.join('\n')) as { items: readonly { id: string; run?: unknown }[] }
        expect(status.items.find((item) => item.id === 'integration')?.run, '未配置不落记录').toBeUndefined()
      },
    })
    expect(probed, 'spec 必须先发 test-unconfigured 的 fix').toBe(true)
    const specStart = actions.findIndex(({ step }) => step === 'spec')
    const fix = actions.findIndex(({ step, action }) => step === 'spec' && action.action === 'fix')
    expect(actions[fix]?.action).toMatchObject({
      blockers: [expect.objectContaining({ source: 'test', code: 'test-unconfigured' })],
    })
    const planningMessage = String((actions[fix]?.action.blockers as readonly { message: string }[])[0]?.message)
    expect(planningMessage).toContain("后续步骤 'verify' 的必需测试")
    // 真机（第四轮）：只进计划不够——proposal 没列、design 还写着「不改 package.json」，verify 的规格
    // 一致性评审据此阻断。计划步的提示点名同步 proposal 与 design，并去掉相矛盾的表述。
    expect(planningMessage).toContain('proposal 的 What Changes / Impact 与 design')
    expect(planningMessage).toContain('删掉与之相矛盾的表述')
    // 先于 spec 的任何技能与文档写入（tasks / plan 登记之前）。
    const firstWrite = actions.findIndex(({ step, action }, index) => index > specStart && step === 'spec'
      && ['load-skill', 'scaffold-document', 'record-document'].includes(action.action))
    expect(fix).toBeLessThan(firstWrite)
    // build 不再重提，全程没有回到 spec。
    expect(actions.some(({ step, action }) => step === 'build' && action.action === 'fix')).toBe(false)
    expect(actions.some(({ action }) => action.event === 'requirements-changed'
      || (action.exits as readonly string[] | undefined)?.includes('requirements-changed'))).toBe(false)
    // 配好之后的 verify 真跑了这条测试并通过。
    expect(actions.some(({ step, action }) => step === 'verify'
      && action.action === 'run-test' && action.test === 'integration')).toBe(true)
  })

  /**
   * build 才发现（例如脚本在计划之后被删了）：先拍板 build_mode / isolation，再配置；提示明确只需补
   * package.json 的脚本、不改已登记的规格文档。只改 package.json 不会让已登记的文档失效——文档台账
   * 按各自文件的 sha256 判定——所以照做之后一路做到完结，没有 requirements-changed。
   */
  test('build 才发现未配置：决定字段在前，fix 只要求补脚本；只改 package.json 不回退 spec', async () => {
    let removed = false
    const { actions } = await walk({
      before: async (step) => {
        if (removed || step.id !== 'build') return
        removed = true
        const pkg = JSON.parse(await readFile(join(h.cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
        delete pkg.scripts['test:integration']
        await writeFile(join(h.cwd, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
      },
    })
    expect(removed).toBe(true)
    const fix = actions.findIndex(({ step, action }) => step === 'build' && action.action === 'fix')
    expect(fix).toBeGreaterThan(-1)
    const message = String((actions[fix]?.action.blockers as readonly { message: string }[])[0]?.message)
    expect(message).toContain('不需要修改已登记的规格文档')
    for (const decision of ['build_mode', 'isolation']) {
      const at = actions.findIndex(({ step, action }) =>
        step === 'build' && action.action === 'set-field' && action.field === decision)
      expect(at, `${decision} 必须先于 build 的 test-unconfigured fix`).toBeLessThan(fix)
    }
    expect(actions.some(({ action }) => action.event === 'requirements-changed'
      || (action.exits as readonly string[] | undefined)?.includes('requirements-changed'))).toBe(false)
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
 * finish-change（没有归档命令），照做一次成功；提交之后 next 是 stop finished，与 default 搬进 archive/
 * 后同一形态。真机（第三轮）：仓库根的门禁标记不能被这次提交带进去，只剩它时也不再发提交。
 */
describe('照着 next 做事的运行器：simple 工作流', { timeout: 120_000 }, () => {
  const SIMPLE = 'tiny'

  test('verify-pass 完结后 next 给出一次成功的提交（不含门禁标记）；提交之后 stop finished', async () => {
    expect(await h.run(['init', SIMPLE, '--track', 'simple', '--preset', 'tweak'])).toBe(0)
    expect(await h.run(['session', 'activate', SIMPLE])).toBe(0)
    await put('src/typo.txt', 'fixed the typo\n')
    await put('.pipeline-pending-review', 'marker\n')
    const seen: string[] = []
    for (let round = 1; round <= 30; round++) {
      await run(['status', SIMPLE, '--json'])
      const payload = JSON.parse(h.out.join('\n')) as {
        step?: { id: string; archived: boolean; next: readonly StepAction[] }
        finished_changes?: readonly { name: string }[]
      }
      expect(payload.step, '单个 change 的 status --json 恒带 step').toBeDefined()
      if (payload.step?.next[0]?.action === 'stop') {
        expect(payload.step.next).toEqual([expect.objectContaining({ action: 'stop', code: 'finished' })])
        expect(payload.step.archived).toBe(true)
        expect(payload.finished_changes?.map((row) => row.name)).toEqual([SIMPLE])
        expect(seen).toContain('finish-change')
        // 只剩本机门禁标记：它没被提交，也不会再让 next 发一次必定 nothing to commit 的提交。
        expect(git(['status', '--porcelain']).output).toBe('?? .pipeline-pending-review\n')
        return
      }
      if (payload.step === undefined) return
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
              commit: { paths: WORKSPACE_PATHS, untrack: [], message: `chore(tenon): finish ${SIMPLE}` },
            })
            commitAsInstructed(action.commit as FinishCommit)
            break
          default:
            throw new Error(`runner(simple): next 给了执行不了的动作 ${JSON.stringify(action)}`)
        }
      }
    }
    throw new Error(`runner(simple): 30 轮还没走到完结：${seen.join(' → ')}`)
  })

  test('scope-expanded 放弃：不发提交，step 的 next 是 stop finished', async () => {
    expect(await h.run(['init', SIMPLE, '--track', 'simple', '--preset', 'tweak'])).toBe(0)
    expect(await h.run(['transition', SIMPLE, 'scope-expanded'])).toBe(0)
    await run(['status', SIMPLE, '--json'])
    const payload = JSON.parse(h.out.join('\n')) as { step?: Record<string, unknown>; finished_changes?: readonly { name: string }[] }
    expect(Object.keys(payload.step ?? {})).toEqual(STEP_KEYS)
    expect(payload.step).toMatchObject({ archived: true, next: [{ action: 'stop', code: 'finished' }] })
    expect(payload.finished_changes?.map((row) => row.name)).toEqual([SIMPLE])
  })
})
