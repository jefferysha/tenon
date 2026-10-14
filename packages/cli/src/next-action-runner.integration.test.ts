/**
 * 验收锚：一个只照 `tenon status <change> --json` 的 `step` 分块做事的运行器，必须能把一个升级前创建、冻结着文档契约的
 * `default` 任务（契约模式）从 `open` 一路做到 `list --finished`——中途还改过一份已经登记的文档。新任务（观察模式）的同款
 * 验收在 observed-documents.integration.test.ts。
 *
 * 这里的运行器没有任何本地知识：它只认 `next` 里的动作名与动作自带的载荷（要读哪些文档、要用哪个
 * producer 登记、字段的枚举与推荐值、要跑哪条测试、走哪条出边），路径到 kind 的对应关系也只从同
 * 一份 `step.documents` 里取。任何一条 `next` 发出去却执行不了的动作，都会让这个用例当场红：
 * 真机验收那一轮就是这样连撞五处（scaffold 不推进状态、过期文档只发 read、ship 要 scaffold 一份
 * 契约里没有的文档、build 提前要 build_sha、回退边不带人工确认）。
 *
 * 零 mock：真临时项目、真 kernel、真文档台账、真测试记录；Skill 回执落在 PostToolUse hook 最终
 * 调用的那条生产命令上（`internal-native-skill-receipt`），时间戳跟 harness 的固定 clock 走。
 * 运行器本身（动作 → 命令）在 integration-next-runner-test-support.ts，契约模式的文档动作与整条链的
 * `walkContract` 在 integration-next-runner-contract-support.ts。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseWorkflow, serializeWorkflow, type WorkflowDef } from '@tenon/kernel'
import { legacyContractDefaultSource, simpleWorkflow } from '@tenon/kernel/workflow/test-support'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import {
  contractHandlers, contractSkillLoader, walkContract, type ContractStep, type WalkResult,
} from './integration-next-runner-contract-support.js'
import {
  NextRunner, RUNNER_PACKAGE_JSON, SHIP_TASK, STEP_KEYS, WORKSPACE_PATHS, type FinishCommit, type StepAction, type RunnerStep,
} from './integration-next-runner-test-support.js'

const CHANGE = 'nextrun'

/**
 * 项目自己的 default 工作流：在 backend 验证步骤多要一条必需的 npm 脚本测试 `integration`。内置默认不再要求它
 * （集成套件目录里有才跑），但项目仍可以这样声明；「脚本没配」（test-unconfigured）这条路径因此还在。
 * 基于升级前的 default 原文（带旧文档契约，任务冻结的就是它）。
 */
function projectDefaultWithIntegration(): WorkflowDef {
  const source = legacyContractDefaultSource()
  const backend = source.indexOf('\n  backend:\n')
  const verifyTests = source.indexOf('        tests:\n', source.indexOf('      - id: verify', backend))
  const at = verifyTests + '        tests:\n'.length
  return parseWorkflow(`${source.slice(0, at)}${[
    '          - id: integration', '            direction: integration', '            command: npm run test:integration',
    '            label: 集成', '            timeout_s: 1800', '            required: true',
  ].join('\n')}\n${source.slice(at)}`)
}

/**
 * 自由文本交付槽本来就没有枚举；pr_url 的真值由投影给出（无远端 → no-remote），这里是 prd_path，
 * 以及产品轨道（旧引擎里 plan 不走 artifact 登记）规格步给出的 plan 路径。
 */
const FREEFORM: Readonly<Record<string, string>> = {
  prd_path: `docs/${CHANGE}-prd.md`,
  plan: `docs/${CHANGE}-plan.md`,
}

let h: Harness
let runner: NextRunner

beforeEach(async () => {
  h = await freshHarness()
  runner = new NextRunner(h, CHANGE, {
    loadSkill: contractSkillLoader(() => runner),
    freeform: FREEFORM,
    handlers: contractHandlers(() => runner),
  })
  // 夹具是一个真 git 仓：只提交过 package.json，change 目录从未被跟踪（真机第二轮的失败形态）。
  await writeFile(join(h.cwd, 'package.json'), RUNNER_PACKAGE_JSON, 'utf8')
  expect(runner.git(['init', '-q']).status).toBe(0)
  expect(runner.git(['add', 'package.json']).status).toBe(0)
  expect(runner.git(['commit', '-q', '-m', 'fixture']).status).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

interface WalkOptions {
  /** 项目级的 default 工作流定义（升级前的写法，立项时冻结进快照）。 */
  readonly projectWorkflow?: WorkflowDef
  readonly track?: string
  readonly editAt?: string
  /** 每条动作照做之前的观察点（用例在这里探测 CLI 对「越过 next 的写法」的拒绝）。 */
  readonly before?: (step: ContractStep, action: StepAction) => Promise<void>
}

/** 跑完整条链；返回每一轮所在的 step 与所有下发过的动作名。 */
function walk(options: WalkOptions = {}): Promise<WalkResult> {
  const track = options.track ?? 'backend'
  return walkContract(runner, {
    // 升级前最早的一批任务：快照记着 phase-manifest（build_mode / isolation 这些决定类字段、tasks 阻塞项的逐条原文都是它的口径）。
    // 契约模式的 step-graph 任务走同一条链见 observed-documents.integration.test.ts。
    init: () => h.initLegacyDefault(CHANGE, track, 'full',
      options.projectWorkflow === undefined ? undefined : { definition: options.projectWorkflow }),
    ...(options.editAt === undefined ? {} : { editAt: options.editAt }),
    ...(options.before === undefined ? {} : { before: options.before }),
    // 每条轨道的验证都声明了 code-size 测试；项目自己的 default 多要 backend 验证的 integration。
    extraVerifyTests: options.projectWorkflow !== undefined && track === 'backend' ? ['integration'] : [],
  })
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
    // 真机（第五轮）：build 的实现评审与 verify 的评审者口径不一。build 的实现技能与通过结论带上 verify
    // 声明的评审者、block_at 与关注点。
    const verifyBar = [
      { step: 'verify', agent: 'spec-consistency', required: true, block_at: 'medium' },
      { step: 'verify', agent: 'backend-quality', required: true, block_at: 'medium' },
      { step: 'verify', agent: 'security', required: true, block_at: 'medium' },
      { step: 'verify', agent: 'architecture', required: false, block_at: 'high' },
      { step: 'verify', agent: 'code-size', required: true, block_at: 'medium' },
    ]
    const barOf = (action: StepAction | undefined) =>
      (action?.review_bar as readonly Record<string, unknown>[] | undefined)?.map(({ focus: _focus, ...rest }) => rest)
    expect(barOf(actions[verdict]?.action)).toEqual(verifyBar)
    expect(String((actions[verdict]?.action.review_bar as readonly { focus: string }[])[1]?.focus)).toContain('后端质量')
    const buildSkills = actions.filter(({ step, action }) => step === 'build' && action.action === 'load-skill')
    expect(buildSkills.length).toBeGreaterThan(0)
    for (const { action } of buildSkills) expect(barOf(action)).toEqual(verifyBar)
    // verify 之后的 ship 没有评审者：verify 的动作不带。
    expect(actions.some(({ step, action }) => step === 'verify' && action.review_bar !== undefined)).toBe(false)
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
    // 测试体系（design §11）：init 已按 package.json 自动识别出目录（所以没有 test-discover 动作）；spec 依次 计划 → 映射；
    // 默认策略只强制目录里的 unit：build / verify 不再有缺的种类要登记，直接运行；verify 运行完把追溯矩阵写进验证报告。
    // 本用例的任务是升级前创建、冻结着旧 `test_policy` 的 default（initLegacyDefault），simplify-test-settings 的规格要求
    // 冻结的旧策略照旧求值（种类按名逐字匹配，只有 `files: registered` 改按认领），所以这里仍是旧口径：
    //   · spec 的 `kinds: [unit]`：计划里没有 unit 套件 → test-kind-missing → test-plan-map；
    //   · build 的 `run: [unit]`：unit 本阶段没运行过 → test-not-run → run-tests。
    // 现行 default 的档位语义（场景映射默认不要求、changed 档零运行即满足）由 test-levels.integration.test.ts 断言。
    // 每条都是运行器照做就推进的动作（夹具替作者做 T2 命令做的事）。
    const flowActions = ['test-discover', 'test-plan-seed', 'test-plan-map', 'test-register-files', 'run-tests', 'test-report']
    expect(actions.filter(({ action }) => flowActions.includes(action.action))
      .map(({ step, action }) => `${step}:${action.action}`)).toEqual([
      'spec:test-plan-seed', 'spec:test-plan-map',
      'build:run-tests',
      'verify:run-tests', 'verify:test-report',
    ])
    const at = (step: string, name: string, from = 0): number => actions.findIndex(({ step: id, action }, index) =>
      index >= from && id === step && action.action === name)
    // 排在本步文档之后、评审之前；测试排在评审者之前（执行者 → 技能 → 文档 → 测试 → 评审者）。
    expect(at('spec', 'test-plan-seed')).toBeGreaterThan(at('spec', 'record-document'))
    expect(at('spec', 'test-plan-map')).toBeLessThan(at('spec', 'request-review'))
    expect(at('verify', 'run-tests')).toBeLessThan(at('verify', 'run-test'))
    expect(at('verify', 'run-test')).toBeLessThan(at('verify', 'test-report'))
    expect(at('verify', 'test-report')).toBeLessThan(at('verify', 'run-agent'))
    // 报告写进验证报告后文档变过期，被重新登记；追溯矩阵引用了运行 id。
    expect(at('verify', 'record-document', at('verify', 'test-report'))).toBeGreaterThan(at('verify', 'test-report'))
    const report = actions.find(({ step, action }) => step === 'verify' && action.action === 'test-report')?.action
    expect(report).toMatchObject({ command: expect.stringMatching(/^tenon test report nextrun --write \S+$/u) })
    // 交付物在交付步由 next 点名提交，排在交付值 pr_url 之前（开 PR 要先有提交）。
    const deliver = actions.findIndex(({ step, action }) => step === 'ship' && action.action === 'commit')
    expect(deliver).toBeGreaterThan(-1)
    expect(deliver).toBeLessThan(actions.findIndex(({ action }) => action.action === 'set-field' && action.field === 'pr_url'))
    // 真机（第四轮）：勾选先于提交。交付物未提交时先 commit，再勾剩下的任务；之后应用进主规格的改动
    // 在交付值之前再提交一次。
    expect(deliver).toBeLessThan(shipFix)
    const lastDeliver = actions.map(({ action }) => action.action).lastIndexOf('commit')
    expect(lastDeliver).toBeGreaterThan(actions.findIndex(({ action }) => action.action === 'apply-spec'))
    // 真机（第五轮）：pr_url 的真值不需要先有提交（no-remote）时，它排在最后一次交付提交之前——
    // 写下的状态文件随这次提交入库，ship 暂停时工作区是干净的。
    expect(actions.findIndex(({ action }) => action.action === 'set-field' && action.field === 'pr_url'))
      .toBeLessThan(lastDeliver)
    // 两次交付提交标题可以区分：首次交付，之后是补交。
    expect(actions.filter(({ action }) => action.action === 'commit')
      .map(({ action }) => (action.commit as FinishCommit).message))
      .toEqual([`feat(${CHANGE}): deliver`, `chore(${CHANGE}): update deliverables`])
    // 交付提交带上了代码之外的交付物：已应用的主规格、测试记录与状态目录的 .gitignore。
    const delivered = runner.git(['log', '--name-only', '--format=', `--grep=^feat(${CHANGE}): deliver$`,
      `--grep=^chore(${CHANGE}): update deliverables$`]).output
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
    runner.failOnce = 'security'
    const { seen, actions } = await walk({ editAt: 'explore' })
    expect(runner.failOnce, '用例必须真的让一个评审者打回过').toBeUndefined()
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
  test('pm 轨：build 的通过结论要等必需评审者 spec-consistency 通过', async () => {
    let refusedBeforeReview = false
    const { seen, actions } = await walk({
      track: 'pm',
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
    expect(runner.agentPrompts.get('spec-consistency')).toContain('工作流必需测试的配置不算多做')
  })

  /**
   * 真机（第二轮）：项目没有 `test:integration` 脚本，backend verify 的必需测试只能被记成一次失败，
   * 模型加了一条与 npm test 相同的脚本凑数。现在 `tenon test run` 说「未配置」（不落记录）。
   * 真机（第三轮）：这条 fix 到 build 才出现，模型把「补测试」写回 spec 已登记的计划与设计，只能
   * requirements-changed 回到 spec（backend 两次）。现在计划步（spec，产出 plan）就把之后所有步骤的
   * 未配置测试提出来，排在本步任何文档写入之前，让它进计划；之后一路没有回退。
   */
  test('项目没有 test:integration：计划步（spec）就要求配置，先于本步文档；未配置时 test run 拒跑、不落记录', async () => {
    const pkg = JSON.parse(RUNNER_PACKAGE_JSON) as { scripts: Record<string, string> }
    delete pkg.scripts['test:integration']
    await writeFile(join(h.cwd, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    let probed = false
    const { actions } = await walk({
      projectWorkflow: projectDefaultWithIntegration(),
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
    // build 不再重提「未配置」（步骤测试策略的登记类阻塞是另一类 fix，不在此断言范围），全程没有回到 spec。
    expect(actions.some(({ step, action }) => step === 'build' && action.action === 'fix'
      && (action.blockers as readonly { code?: string }[] | undefined)?.some((item) => item.code === 'test-unconfigured'))).toBe(false)
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
      projectWorkflow: projectDefaultWithIntegration(),
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
 * 已完结的 simple 任务 status 还带着 `step.archived: false`。收尾的 next 是 finish-change：先执行
 * `tenon task finish`（不走 OpenSpec 的轨道由 Tenon 直接把目录移进 archive/），再照 `commit` 做一次成功的
 * 提交；之后 next 是 stop finished。真机（第三轮）：仓库根的门禁标记不能被这次提交带进去，只剩它时也不再发提交。
 */
describe('照着 next 做事的运行器：轻量的平铺工作流（原内建 simple 的定义）', { timeout: 120_000 }, () => {
  const SIMPLE = 'tiny'
  let simple: NextRunner
  beforeEach(() => {
    simple = new NextRunner(h, SIMPLE, { loadSkill: contractSkillLoader(() => simple) })
  })

  /** 已退役的内建 simple 的定义（change → verify → done / escalated），改名为项目自己的平铺工作流。 */
  const seedLightweight = (): Promise<void> =>
    runner.put('.pipeline/workflows/lightweight.yaml', serializeWorkflow({ ...simpleWorkflow(), name: 'lightweight' }))

  interface SimpleStep extends RunnerStep { readonly archived: boolean }

  test('verify-pass 完结后 next 给出一次成功的提交（不含门禁标记）；提交之后 stop finished', async () => {
    await seedLightweight()
    expect(await h.run(['init', SIMPLE, '--workflow', 'lightweight', '--preset', 'tweak'])).toBe(0)
    expect(await h.run(['session', 'activate', SIMPLE])).toBe(0)
    await runner.put('src/typo.txt', 'fixed the typo\n')
    await runner.put('.pipeline-pending-review', 'marker\n')
    const seen: string[] = []
    for (let round = 1; round <= 30; round++) {
      await simple.run(['status', SIMPLE, '--json'])
      const payload = JSON.parse(h.out.join('\n')) as {
        step?: SimpleStep
        finished_changes?: readonly { name: string }[]
      }
      expect(payload.step, '单个 change 的 status --json 恒带 step').toBeDefined()
      if (payload.step?.next[0]?.action === 'stop') {
        expect(payload.step.next).toEqual([expect.objectContaining({ action: 'stop', code: 'finished' })])
        expect(payload.step.archived).toBe(true)
        expect(payload.finished_changes?.map((row) => row.name)).toEqual([SIMPLE])
        expect(seen).toContain('finish-change')
        // 只剩本机门禁标记：它没被提交，也不会再让 next 发一次必定 nothing to commit 的提交。
        expect(simple.git(['status', '--porcelain']).output).toBe('?? .pipeline-pending-review\n')
        // 任务结束一律归档：不走 OpenSpec 的轨道目录也搬进 archive/，check / status 说「已完结（已归档）」。
        expect(existsSync(simple.changeDir()), '完结后目录搬进 archive/').toBe(false)
        await simple.run(['check', SIMPLE])
        expect(h.out.join('\n')).toBe(`change '${SIMPLE}' 已完结（已归档），无需检查`)
        await simple.run(['status', SIMPLE])
        expect(h.out).toContain('finished     已完结（已归档）')
        await simple.run(['list', '--finished'])
        expect(h.out.join('\n')).toContain('FINISHED_AT')
        expect(h.out.join('\n')).not.toContain('ARCHIVED_AT')
        return
      }
      if (payload.step === undefined) return
      for (const action of payload.step.next) {
        seen.push(action.action)
        switch (action.action) {
          case 'load-tenon':
            await simple.loadSkill('tenon')
            break
          case 'load-skill':
            await simple.loadSkill(String(action.skill))
            break
          case 'transition':
          case 'complete':
            await simple.run(['transition', SIMPLE, String(action.event)])
            break
          case 'choose-exit': {
            const exits = action.exits as readonly string[]
            await simple.run(['transition', SIMPLE, exits.includes('verify-pass') ? 'verify-pass' : exits.includes('change-complete') ? 'change-complete' : exits[0]!])
            break
          }
          case 'finish-change':
            expect(payload.step.archived, '已完结的 change：step.archived 为 true').toBe(true)
            expect(action).toEqual({
              action: 'finish-change',
              change: SIMPLE,
              command: `tenon task finish ${SIMPLE}`,
              commit: { paths: WORKSPACE_PATHS, untrack: [], message: `chore(tenon): finish ${SIMPLE}` },
            })
            await simple.run(['task', 'finish', SIMPLE])
            simple.commitAsInstructed(action.commit as FinishCommit)
            break
          default:
            throw new Error(`runner(simple): next 给了执行不了的动作 ${JSON.stringify(action)}`)
        }
      }
    }
    throw new Error(`runner(simple): 30 轮还没走到完结：${seen.join(' → ')}`)
  })

  test('scope-expanded 放弃：finish-change 只带命令、不带提交；执行之后 step 的 next 是 stop finished', async () => {
    await seedLightweight()
    expect(await h.run(['init', SIMPLE, '--workflow', 'lightweight', '--preset', 'tweak'])).toBe(0)
    expect(await h.run(['transition', SIMPLE, 'scope-expanded'])).toBe(0)
    await simple.run(['status', SIMPLE, '--json'])
    const before = JSON.parse(h.out.join('\n')) as { step?: { next: readonly StepAction[] } }
    expect(before.step?.next).toEqual([{
      action: 'finish-change', change: SIMPLE, command: `tenon task finish ${SIMPLE}`, commit: null,
    }])
    await simple.run(['task', 'finish', SIMPLE])
    await simple.run(['status', SIMPLE, '--json'])
    const payload = JSON.parse(h.out.join('\n')) as { step?: Record<string, unknown>; finished_changes?: readonly { name: string }[] }
    expect(Object.keys(payload.step ?? {})).toEqual(STEP_KEYS)
    expect(payload.step).toMatchObject({ archived: true, next: [{ action: 'stop', code: 'finished' }] })
    expect(JSON.stringify(payload.step?.next)).toContain('已升级')
    expect(payload.finished_changes?.map((row) => row.name)).toEqual([SIMPLE])
  })
})
