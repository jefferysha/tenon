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
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

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

/** 自由文本交付槽（pr_url / prd_path）本来就没有枚举；其余值一律只能来自投影自己。 */
const FREEFORM: Readonly<Record<string, string>> = {
  pr_url: 'https://example.invalid/pr/1',
  prd_path: `docs/${CHANGE}-prd.md`,
}

const DESIGN_DOC = [
  '# design', '', '```coverage', 'touches:',
  ...['L1_api', 'L2_data', 'L3_rules', 'L4_state', 'L5_errors', 'L6_security', 'L7_perf', 'L8_deps', 'L10_terms']
    .map((layer) => `${layer}: filled -> §1`),
  '```', '',
].join('\n')

let h: Harness
/** 让这一个评审者在第一次给结论时打回一次（D6 的回退边验收）。 */
let failOnce: string | undefined

function changeDir(): string {
  return join(h.cwd, 'openspec', 'changes', CHANGE)
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
async function loadSkill(skill: string): Promise<void> {
  toolUseSeq += 1
  await appendFile(
    join(changeDir(), '.pipeline-history.jsonl'),
    `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: `Skill: ${skill}` })}\n`,
    'utf8',
  )
  await run(['internal-native-skill-receipt', CHANGE, skill, 'runner-session', `tool-${toolUseSeq}`, FIXED_CLOCK])
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
      // 运行器替作者把活干完：骨架的 tasks.md 全是未勾选的框，而 open/spec 出口要求全勾。
      if (action.kind === 'tasks' || !existsSync(join(h.cwd, path))) {
        await put(path, action.kind === 'tasks'
          ? '- [x] scope\n- [x] implementation\n- [x] verification\n'
          : `# ${String(action.kind)}\n\nwritten by the runner\n`)
      }
      await loadSkill(producer!)
      await run(['document', 'record', CHANGE, String(action.kind), path, '--producer', producer!])
      return false
    }
    case 'set-field': {
      const value = (action.recommended as string | null)
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
    // 治理归档是 OpenSpec 自己的命令（动作自带整条命令），到这里状态机已经完结。
    case 'finish-change':
      return true
    default:
      throw new Error(`runner: next 给了执行不了的动作 ${JSON.stringify(action)}`)
  }
}

beforeEach(async () => {
  failOnce = undefined
  h = await freshHarness()
  await writeFile(join(h.cwd, 'package.json'), FIXTURE_PACKAGE_JSON, 'utf8')
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
  // Skill 回执绑定当前用户的活跃任务，真实宿主会话就是这样起头的。
  expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

/** 跑完整条链；返回每一轮所在的 step 与所有下发过的动作名。 */
async function walk(options: { readonly editAt?: string } = {}): Promise<{
  readonly seen: readonly string[]
  readonly actions: readonly { readonly step: string; readonly action: StepAction }[]
}> {
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
      done = (await perform(step, action)) || done
    }
    if (done) {
      expect(edited, '用例必须真的改过一份已登记的文档').toBe(true)
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

  /** D7：不存在的任务是产品层的一句话，不是一行 ENOENT。 */
  test('不存在的任务：status 给产品层文案', async () => {
    expect(await h.run(['status', 'no-such-change'])).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: change 不存在: no-such-change')
  })
})
