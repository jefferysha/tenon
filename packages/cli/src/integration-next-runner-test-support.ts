/**
 * 「只照 `tenon status <change> --json` 的 `step` 分块做事」的运行器——两种文档模式共用的那部分。
 *
 * 运行器没有任何本地知识：只认 `next` 里的动作名与动作自带的载荷（要用哪个 producer 登记、字段的枚举与推荐值、
 * 要跑哪条测试、走哪条出边），任何一条 `next` 发出去却执行不了的动作都会让用例当场红。动作名对应的命令：
 * `set-field` → `tenon set`、`run-test` → `tenon test run`、`run-agent` → `tenon agent prompt|record`、
 * `fix` → 做完阻塞项、`apply-spec` / `validate-spec` → `tenon spec apply [--dry-run]`、
 * `request-review` / `await-review` / `transition` / `choose-exit`、`commit` / `finish-change`。
 *
 * 两种文档模式不同的动作（技能怎么加载、读输入、契约模式的 scaffold / record / register）由调用方以 `handlers`
 * 注入：升级前带契约的任务见 `integration-next-runner-contract-support.ts`，新任务见
 * `observed-documents.integration.test.ts`。零 mock：真临时项目、真 kernel、真测试记录。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { FIXED_CLOCK, realDeps, rm, type Harness } from './integration-harness.js'
import { agentPromptResult, parseJsonRecord, recordOf } from './integration-harness-json.js'
import { performFlowAction } from './integration-test-flow-support.js'
import { putFile, runGit, type GitResult } from './test-git-fixture.js'

export interface StepAction {
  readonly action: string
  readonly [key: string]: unknown
}

export interface FinishCommit {
  readonly paths: readonly string[]
  readonly untrack: readonly string[]
  readonly message: string
}

export interface RunnerStep {
  readonly id: string
  readonly next: readonly StepAction[]
}

/** `step` 分块的键序（schema）：活跃与已完结的任务同一形态。 */
export const STEP_KEYS = [
  'schema', 'change', 'workflow', 'track', 'source', 'id', 'label', 'prompt', 'gate', 'mode', 'archived',
  'governed_openspec', 'candidate', 'skills', 'executors', 'reviewers', 'tests', 'documents', 'fields', 'review',
  'exits', 'rounds', 'next',
]

/** 交付与 simple 收尾的提交范围：整个工作区，去掉仓库根的本机门禁标记与旧版本地文件。 */
export const WORKSPACE_PATHS = [
  '.',
  ':(exclude).pipeline-pending-confirm',
  ':(exclude).pipeline-pending-review',
  ':(exclude).pipeline-pending-interaction',
  ':(exclude).pipeline-active',
  ':(exclude).pipeline-interaction-authority',
  // 交互标记按会话分文件（`.pipeline-pending-interaction.<session_id>`），同样只属于本机。
  ':(exclude,glob).pipeline-pending-interaction.*',
  // 任务期间为宿主生成的子代理文件本机生成、完结时回收，不随交付入库。
  ':(exclude,glob).claude/agents/tenon-*.md',
  ':(exclude,glob).codex/agents/tenon-*.toml',
  // 本机生成物同样不入库：所有权清单与测试输出目录（真机验收 F14）。
  ':(exclude).pipeline-owned.json',
  ':(exclude,glob)**/test-results/**',
  ':(exclude,glob)**/playwright-report/**',
  ':(exclude,glob)coverage/**',
]

/** 交付步最后一项任务：ship 的 next 必须先发带这条原文的 fix（运行器照做去勾它），而不是越过它去 apply-spec。 */
export const SHIP_TASK = 'update the usage docs'

/** 夹具项目的 package.json：`npm test` 是 node:test，tenon init 据此自动识别出 unit 套件。 */
export const RUNNER_PACKAGE_JSON = `${JSON.stringify({
  name: 'tenon-next-runner-fixture',
  private: true,
  version: '0.0.0',
  scripts: { test: 'node --test', typecheck: 'exit 0', 'test:integration': 'exit 0', bench: 'exit 0' },
}, null, 2)}\n`

/** 动作处理器：返回 true 表示这一步是终点；`undefined` = 不认识这条动作，交给通用处理。 */
export type ActionHandler = (step: RunnerStep, action: StepAction) => Promise<boolean | undefined>

export interface NextRunnerOptions {
  /** 宿主加载一个技能（`load-tenon` 与 `load-skill` 都走它）。 */
  readonly loadSkill: (skill: string) => Promise<void>
  /** 自由文本交付槽的取值（prd_path、产品轨道规格步给出的 plan 路径……）。 */
  readonly freeform?: Readonly<Record<string, string>>
  /** 两种文档模式各自的动作（read-documents / scaffold-document / record-document / register-field）。 */
  readonly handlers?: Readonly<Record<string, ActionHandler>>
  /** 运行器自己写了工作区文件之后（报告、勾任务、交付文件……）；观察模式的来源标注用它排时间。 */
  readonly onWrite?: () => void
}

export class NextRunner {
  /** 让这一个评审者在第一次给结论时打回一次（D6 的回退边验收）。 */
  failOnce: string | undefined
  /** 每个 agent 最近一次 `agent prompt` 给出的提示词（宿主交给子 agent 的全文）。 */
  readonly agentPrompts = new Map<string, string>()

  constructor(readonly h: Harness, readonly change: string, private readonly options: NextRunnerOptions) {}

  changeDir(name = this.change): string {
    return join(this.h.cwd, 'openspec', 'changes', name)
  }

  git(args: readonly string[]): GitResult {
    return runGit(this.h.cwd, args)
  }

  async put(rel: string, body: string): Promise<void> {
    await putFile(this.h.cwd, rel, body)
    this.options.onWrite?.()
  }

  loadSkill(skill: string): Promise<void> {
    return this.options.loadSkill(skill)
  }

  async run(args: readonly string[]): Promise<void> {
    const code = await this.h.run([...args])
    if (code !== 0) {
      throw new Error(`runner: tenon ${args.join(' ')} exit=${code}\n${this.h.err.join('\n')}\n${this.h.out.join('\n')}`)
    }
  }

  async readStep<Step extends RunnerStep>(): Promise<Step> {
    await this.run(['status', this.change, '--json'])
    const payload = parseJsonRecord(this.h.out.join('\n'), 'tenon status --json')
    if (typeof payload.step !== 'object' || payload.step === null) throw new Error(`runner: status 没有 step 分块\n${this.h.out.join('\n')}`)
    return payload.step as Step
  }

  /** 完结动作的提交：照动作给的 paths / untrack / message 原样执行，每条命令都必须一次成功。 */
  commitAsInstructed(commit: FinishCommit): void {
    const add = this.git(['add', '-A', '--', ...commit.paths])
    expect(add.status, `git add -A -- ${commit.paths.join(' ')}\n${add.output}`).toBe(0)
    if (commit.untrack.length > 0) {
      const untrack = this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...commit.untrack])
      expect(untrack.status, untrack.output).toBe(0)
    }
    const done = this.git(['commit', '-q', '-m', commit.message])
    expect(done.status, `git commit\n${done.output}`).toBe(0)
  }

  /** 一条 `next` 动作 → 真实命令。返回 true 表示这一步是终点。 */
  async perform(step: RunnerStep, action: StepAction): Promise<boolean> {
    const custom = await this.options.handlers?.[action.action]?.(step, action)
    if (custom !== undefined) return custom
    const { change, h } = this
    switch (action.action) {
      case 'load-tenon':
        await this.options.loadSkill('tenon')
        return false
      case 'load-skill':
        await this.options.loadSkill(String(action.skill))
        return false
      case 'set-field': {
        const freeform = this.options.freeform ?? {}
        const value = (action.recommended as string | null)
          ?? (action.required as readonly string[] | null)?.[0]
          ?? (action.allowed as readonly string[] | null)?.[0]
          ?? freeform[String(action.field)]
        if (value === undefined) throw new Error(`set-field 必须给出可填的值：${JSON.stringify(action)}`)
        const path = freeform[String(action.field)]
        if (path !== undefined && (action.field === 'prd_path' || action.field === 'plan')) await this.put(path, '# PRD\n')
        await this.run(['set', change, String(action.field), value])
        return false
      }
      case 'run-test':
        await this.run(['test', 'run', change, String(action.test)])
        return false
      case 'run-agent':
        await this.runAgent(action)
        return false
      case 'fix':
        await this.fix(action)
        return false
      case 'apply-spec':
        await this.run(['spec', 'apply', change])
        return false
      case 'validate-spec':
        await this.run(['spec', 'apply', change, '--dry-run'])
        return false
      case 'request-review':
        await this.run(['review', 'request', change, '--event', String(action.event)])
        return false
      case 'await-review':
        await this.run(['review', 'acknowledge', change])
        return false
      case 'transition':
      case 'complete':
        // 真机（第五轮）：ship 暂停时 `set pr_url` 写下的状态文件还没入库。交付步最后一个动作之后、
        // 走出口之前，工作区必须是干净的（被忽略的本机文件不算）。
        if (step.id === 'ship') expect(this.git(['status', '--porcelain']).output, 'ship 出口前工作区必须干净').toBe('')
        await this.run(['transition', change, String(action.event)])
        return false
      case 'choose-exit':
        await this.run(['transition', change, String((action.exits as readonly string[])[0])])
        return false
      case 'commit':
        await this.commit(action)
        return false
      case 'finish-change':
        await this.finishChange(action)
        return true
      default:
        // 测试体系的登记 / 运行 / 报告动作：夹具替作者经 kernel 写入口做同样的事（真命令是另一批）。
        if (await performFlowAction(
          { deps: realDeps(h.cwd, [], []), cwd: h.cwd, change, stepId: step.id, recordedAt: FIXED_CLOCK },
          action,
        )) return false
        throw new Error(`runner: next 给了执行不了的动作 ${JSON.stringify(action)}`)
    }
  }

  private async runAgent(action: StepAction): Promise<void> {
    // 带 run_id 的是已经在跑的那次：不重开，写报告后登记它。
    let row: { run_id: string; report_path: string; role: string }
    if (typeof action.run_id === 'string') {
      row = { run_id: action.run_id, report_path: String(action.report_path), role: String(action.role) }
    } else {
      await this.run(['agent', 'prompt', this.change, String(action.agent), '--json'])
      const prompted = agentPromptResult(this.h.out.join(''))
      if (prompted === null) throw new Error(`runner: agent prompt --json 输出形状非法\n${this.h.out.join('')}`)
      this.agentPrompts.set(String(action.agent), prompted.prompt)
      row = prompted
    }
    const blocking = this.failOnce === action.agent
    if (blocking) this.failOnce = undefined
    const findings = blocking
      ? '[{"severity":"high","location":"src/x.ts:1","message":"blocking finding"}]'
      : '[]'
    const body = row.role === 'executor'
      ? `{"result":"done","findings":${findings}}`
      : `{"findings":${findings}}`
    await this.put(row.report_path, `# ${String(action.agent)}\n\n\`\`\`tenon-result\n${body}\n\`\`\`\n`)
    await this.run(['agent', 'record', this.change, row.run_id])
  }

  /** 阻塞项里能照做的两类：必需测试未配置（补 package.json 脚本）与未勾任务（逐条勾上）。 */
  private async fix(action: StepAction): Promise<void> {
    const blockers = action.blockers as readonly { source: string; code: string; message: string; items?: readonly string[] }[]
    // 必需测试未配置：运行器就是配置它的作者——按提示把真正运行这类测试的脚本加进 package.json。
    const unconfigured = blockers.filter((item) => item.code === 'test-unconfigured')
    if (unconfigured.length > 0) {
      for (const item of unconfigured) {
        const script = /npm 脚本 '([^']+)'/u.exec(item.message)?.[1]
        if (script === undefined) throw new Error(`test-unconfigured 必须点名要配置的脚本：${item.message}`)
        const pkg = parseJsonRecord(await readFile(join(this.h.cwd, 'package.json'), 'utf8'), 'package.json')
        const scripts = recordOf(pkg.scripts, 'package.json scripts')
        await writeFile(
          join(this.h.cwd, 'package.json'),
          `${JSON.stringify({ ...pkg, scripts: { ...scripts, [script]: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
          'utf8',
        )
      }
      return
    }
    // 策略判定的登记类 / 运行类阻塞各有专门动作（test-discover … run-tests），不该以 fix 下发；
    // 走到这里的策略阻塞是「已经运行却不满足策略」，本运行器的夹具运行都会通过，所以不该出现。
    // 旧步骤测试的阻塞以「测试 <名>」开头，由 run-test 动作处理。
    expect(blockers.filter((item) => item.source === 'test' && !item.message.startsWith('测试 ')),
      `策略阻塞必须有专门动作：${JSON.stringify(action)}`).toEqual([])
    const items = blockers.filter((item) => item.source === 'tasks').flatMap((item) => item.items ?? [])
    const tasksPath = join(this.changeDir(), 'tasks.md')
    let text = await readFile(tasksPath, 'utf8')
    if (items.length > 0) {
      for (const item of items) text = text.replace(`- [ ] ${item}`, `- [x] ${item}`)
    } else {
      // step-graph 引擎的 tasks-through-step 是一条普通守卫：阻塞项只有一句话（点名 tasks.md 与未勾数量），没有逐条原文。
      // 运行器就是做完任务的作者——把清单里没勾的都勾上。
      const guard = blockers.filter((item) => item.source === 'guard' && item.message.includes('tasks.md'))
      expect(guard.length, `fix 必须是能照做的未勾任务（带原文，或点名 tasks.md 的守卫）：${JSON.stringify(action)}`).toBeGreaterThan(0)
      text = text.replaceAll('- [ ] ', '- [x] ')
    }
    await writeFile(tasksPath, text, 'utf8')
    this.options.onWrite?.()
  }

  /** 交付步点名的提交：照原样执行（运行器从不自己决定提交什么）。门禁标记不能被带进去。 */
  private async commit(action: StepAction): Promise<void> {
    const { change } = this
    const commit = action.commit as FinishCommit
    // 真机（第五轮）：两次交付提交标题相同。首次是交付，之后的是补交（应用进主规格、交付值…）。
    const deliveredBefore = this.git(['log', '--format=%s']).output.split('\n').includes(`feat(${change}): deliver`)
    expect(commit).toEqual({
      paths: WORKSPACE_PATHS,
      untrack: [],
      message: deliveredBefore ? `chore(${change}): update deliverables` : `feat(${change}): deliver`,
    })
    // 宿主的门禁标记此刻就在仓库根上（hook 写的）：照做的提交不能把它带进去。
    await this.put('.pipeline-pending-interaction', 'brainstorming\n')
    await this.put('.pipeline-pending-interaction.session-runner-0001', 'brainstorming\n')
    this.commitAsInstructed(commit)
    expect(this.git(['ls-files', '--', '.pipeline-pending-interaction', '.pipeline-pending-interaction.*']).output).toBe('')
    await rm(join(this.h.cwd, '.pipeline-pending-interaction'), { force: true })
    await rm(join(this.h.cwd, '.pipeline-pending-interaction.session-runner-0001'), { force: true })
    // 提交之后整个工作区干净（change 目录随这次提交入库）。
    expect(this.git(['status', '--porcelain']).output).toBe('')
  }

  /**
   * 归档是 `tenon task finish`（动作自带整条命令；走 OpenSpec 的轨道由它调用 openspec，agent 不直接执行），
   * 到这里状态机已经完结。运行器照原样跑它，再照动作给的 paths 提交这次搬移——change 目录从未被 git
   * 跟踪时，paths 不能点名它（搬走之后 `git add` 会以 pathspec did not match 整条失败）。
   */
  private async finishChange(action: StepAction): Promise<void> {
    const { change } = this
    const commit = action.commit as FinishCommit
    // 原目录已随交付提交入库，列出（-A 据索引项暂存搬走后的删除）；其后 archive/ 与存在且未被忽略的
    // 状态目录 .gitignore。
    expect(commit).toEqual({
      paths: [`openspec/changes/${change}`, 'openspec/changes/archive',
        ...['.pipeline/.gitignore', '.tenon/.gitignore', 'openspec/.gitignore']
          .filter((path) => existsSync(join(this.h.cwd, path)))],
      untrack: [],
      message: `chore(openspec): archive ${change}`,
    })
    expect(action.command).toBe(`tenon task finish ${change}`)
    expect(await this.h.run(['task', 'finish', change]), this.h.err.join('\n')).toBe(0)
    expect(existsSync(this.changeDir()), 'tenon task finish 必须真的把 change 目录搬走').toBe(false)
    this.commitAsInstructed(commit)
    // 收尾之后整个工作区干净：交付物（代码、主规格、测试记录、.gitignore）由交付步的 commit
    // 提交，搬移由这里提交；运行器从不自己提交。
    expect(this.git(['status', '--porcelain', '--untracked-files=all']).output).toBe('')
  }
}
