/**
 * `tenon test register|unregister|waive <change> …` —— 任务测试计划的登记入口（计划只经这里写入）。
 *   register --suite <id> [--scope full|changed|files|grep] [--pattern p] [--select-file path…]
 *   register --file <path>… [--suite <id>] [--kind <k>]         登记本任务新增 / 修改的测试文件
 *   register --case <covers> --test "<文件> › <用例名>"…         场景 / 任务 → 用例映射
 *   unregister --suite|--file|--case [--test]|--waiver <kind|covers>
 *   waive --kind <k> | --covers <covers>  --reason <原因>       豁免需要评审批准才生效
 * 写入在 Change 锁内读—改—写；计划被手改（tampered）时拒绝，先用 tenon test plan --seed 重新登记。
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PLAN_SCOPES, TEST_KINDS, isPlanScope, isRepoRelativePath, isTestKind, normalizeRepoPath, parseCaseRef, parseCovers,
  suitesOwningFile, updateTestPlan, emptyTestPlan,
  type PlanFile, type PlanSuite, type TestCatalog, type TestKind, type TestPlan, type TestPlanState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { loadPlanInputs } from '../test-system/plan-context.js'
import { withCase, withFiles, withSuite, withWaiver, withoutTarget } from '../test-system/plan-edit.js'
import { resolveTestCommand, type TestCommandContext } from './test-context.js'

export interface RegisterOptions {
  readonly suite?: string
  readonly scope?: string
  readonly pattern?: string
  readonly selectFile?: readonly string[]
  readonly file?: readonly string[]
  readonly kind?: string
  readonly case?: string
  readonly test?: readonly string[]
}

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

/** 读到的计划状态 → 可编辑的计划；不可信时给出拒绝原因。 */
function editable(state: TestPlanState, change: string): TestPlan | string {
  if (state.state === 'tampered') return `测试计划不可信：${state.reason}；执行 tenon test plan ${change} --seed 重新登记`
  return state.state === 'ok' ? state.plan : emptyTestPlan(change)
}

async function regularFile(deps: CliDeps, path: string): Promise<boolean> {
  try {
    return (await lstat(join(deps.cwd, path))).isFile()
  } catch {
    return false
  }
}

function catalogOf(deps: CliDeps, catalog: Awaited<ReturnType<typeof loadPlanInputs>>['catalog']): TestCatalog | undefined {
  if (catalog.state === 'ok') return catalog.catalog
  deps.io.err(`ERROR: ${catalog.state === 'missing' ? '还没有测试目录；先 tenon test discover --write' : 'catalog.yaml 无效；先 tenon test catalog validate'}`)
  return undefined
}

/** 计划写入统一经 kernel 的审计写入口：`op` 是触发写入的子命令，进 `test:plan-write` 审计行。 */
async function save(
  deps: CliDeps, context: TestCommandContext, change: string, op: 'register' | 'unregister' | 'waive', edit: (plan: TestPlan) => TestPlan,
): Promise<{ ok: true; digest: string } | { ok: false; message: string }> {
  const result = await updateTestPlan(context.dir, change, { actor: context.actor, recordedAt: deps.clock(), op }, (state) => {
    const plan = editable(state, change)
    return typeof plan === 'string' ? { reject: plan } : { plan: edit(plan) }
  })
  return 'rejected' in result ? { ok: false, message: result.rejected } : { ok: true, digest: result.digest }
}

async function registerSuite(deps: CliDeps, context: TestCommandContext, change: string, catalog: TestCatalog, opts: RegisterOptions): Promise<number> {
  const id = opts.suite ?? ''
  if (!catalog.suites.some((suite) => suite.id === id)) return fail(deps, `目录里没有套件 '${id}'（可选：${catalog.suites.map((suite) => suite.id).join(', ') || '无'}）`)
  const scope = opts.scope ?? 'full'
  if (!isPlanScope(scope)) return fail(deps, `--scope '${scope}' 不合法（可选：${PLAN_SCOPES.join('/')}）`)
  if (scope === 'grep' && opts.pattern === undefined) return fail(deps, '--scope grep 需要 --pattern')
  if (scope !== 'grep' && opts.pattern !== undefined) return fail(deps, '--pattern 只用于 --scope grep')
  const files = (opts.selectFile ?? []).map(normalizeRepoPath)
  if (scope === 'files' && files.length === 0) return fail(deps, '--scope files 需要至少一个 --select-file')
  if (scope !== 'files' && files.length > 0) return fail(deps, '--select-file 只用于 --scope files')
  for (const path of files) if (!isRepoRelativePath(path) || !(await regularFile(deps, path))) return fail(deps, `--select-file '${path}' 不是仓库内已存在的文件`)
  const item: PlanSuite = { suite: id, scope, ...(opts.pattern === undefined ? {} : { pattern: opts.pattern }), ...(files.length === 0 ? {} : { files }) }
  const saved = await save(deps, context, change, 'register', (plan) => withSuite(plan, item))
  if (!saved.ok) return fail(deps, saved.message)
  deps.io.out(`[TEST] 已登记套件 ${id}（scope=${scope}）`)
  return 0
}

async function registerFiles(deps: CliDeps, context: TestCommandContext, change: string, catalog: TestCatalog, opts: RegisterOptions): Promise<number> {
  if (opts.kind !== undefined && !isTestKind(opts.kind)) return fail(deps, `--kind '${opts.kind}' 不合法（可选：${TEST_KINDS.join('/')}）`)
  const kind: TestKind | undefined = opts.kind !== undefined && isTestKind(opts.kind) ? opts.kind : undefined
  const entries: PlanFile[] = []
  const neededSuites = new Set<string>()
  for (const raw of opts.file ?? []) {
    const path = normalizeRepoPath(raw)
    if (!isRepoRelativePath(path) || path === '.') return fail(deps, `文件 '${raw}' 必须是仓库内的相对路径`)
    if (!(await regularFile(deps, path))) return fail(deps, `文件 '${path}' 不存在；已删除的测试不用登记`)
    const owners = suitesOwningFile(catalog, path)
    const suiteId = opts.suite ?? (owners.length === 1 ? owners[0] : undefined)
    if (opts.suite === undefined && owners.length > 1) return fail(deps, `文件 '${path}' 被多个套件认领（${owners.join(', ')}），用 --suite 指定`)
    if (suiteId === undefined) {
      if (kind === undefined) return fail(deps, `文件 '${path}' 没有套件认领：先在目录里加套件（tenon test discover --write），或用 --kind 登记不执行的测试资源（如视觉快照）`)
      entries.push({ path, kind })
      continue
    }
    const suite = catalog.suites.find((item) => item.id === suiteId)
    if (suite === undefined) return fail(deps, `目录里没有套件 '${suiteId}'`)
    if (kind !== undefined && kind !== suite.kind) return fail(deps, `--kind ${kind} 与套件 ${suite.id} 的种类 ${suite.kind} 不一致`)
    neededSuites.add(suite.id)
    entries.push({ path, suite: suite.id, kind: suite.kind })
  }
  const saved = await save(deps, context, change, 'register', (plan) => {
    const withRuns = [...neededSuites].reduce((current, id) => (current.suites.some((item) => item.suite === id) ? current : withSuite(current, { suite: id, scope: 'changed' })), plan)
    return withFiles(withRuns, entries)
  })
  if (!saved.ok) return fail(deps, saved.message)
  for (const entry of entries) deps.io.out(`[TEST] 已登记测试文件 ${entry.path}${entry.suite === undefined ? '' : `（套件 ${entry.suite}）`}`)
  if (neededSuites.size > 0) deps.io.out(`  套件 ${[...neededSuites].join(', ')} 已在计划里（不在的已按 scope=changed 补上）`)
  return 0
}

async function registerCase(deps: CliDeps, context: TestCommandContext, change: string, opts: RegisterOptions): Promise<number> {
  const covers = opts.case ?? ''
  if (parseCovers(covers) === undefined) return fail(deps, `--case '${covers}' 非法（spec:<capability>/<Scenario 标题> 或 task:<编号>）`)
  const tests = opts.test ?? []
  if (tests.length === 0) return fail(deps, '--case 需要至少一个 --test "<文件> › <用例名>"')
  for (const test of tests) if (parseCaseRef(test) === undefined) return fail(deps, `--test '${test}' 非法（<文件> › <用例名>，分隔符是 ' › '）`)
  const inputs = await loadPlanInputs(deps, context)
  const known = [...inputs.scenarios.map((item) => item.covers), ...inputs.tasks.map((item) => item.covers)]
  if (known.length > 0 && !known.includes(covers)) {
    return fail(deps, `${covers} 不是当前 delta spec / tasks.md 里的场景或条目；可选：\n${known.slice(0, 12).map((item) => `  ${item}`).join('\n')}`)
  }
  const saved = await save(deps, context, change, 'register', (plan) => withCase(plan, covers, tests))
  if (!saved.ok) return fail(deps, saved.message)
  deps.io.out(`[TEST] 已映射 ${covers} ← ${tests.join(' | ')}`)
  return 0
}

export async function cmdTestRegister(deps: CliDeps, change: string, opts: RegisterOptions): Promise<number> {
  const modes = [opts.file !== undefined, opts.case !== undefined].filter(Boolean).length
  if (modes > 1 || (opts.file === undefined && opts.case === undefined && opts.suite === undefined)) {
    return fail(deps, 'register 三选一：--suite <id>、--file <path>、--case <covers> --test <ref>')
  }
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  if (opts.case !== undefined) return registerCase(deps, context, change, opts)
  const catalog = catalogOf(deps, (await loadPlanInputs(deps, context)).catalog)
  if (catalog === undefined) return 1
  return opts.file !== undefined
    ? registerFiles(deps, context, change, catalog, opts)
    : registerSuite(deps, context, change, catalog, opts)
}

export interface UnregisterOptions {
  readonly suite?: string
  readonly file?: string
  readonly case?: string
  readonly test?: string
  /** 撤销豁免：测试种类（按种类的豁免）或 spec:/task: 引用（按场景 / 任务的豁免）。 */
  readonly waiver?: string
}

export async function cmdTestUnregister(deps: CliDeps, change: string, opts: UnregisterOptions): Promise<number> {
  if (opts.suite === undefined && opts.file === undefined && opts.case === undefined && opts.waiver === undefined) {
    return fail(deps, 'unregister 需要 --suite / --file / --case [--test] / --waiver 之一')
  }
  if (opts.test !== undefined && opts.case === undefined) return fail(deps, '--test 要和 --case 一起用')
  const waiverKind = opts.waiver !== undefined && isTestKind(opts.waiver) ? opts.waiver : undefined
  const waiverCovers = opts.waiver !== undefined && waiverKind === undefined && parseCovers(opts.waiver) !== undefined ? opts.waiver : undefined
  if (opts.waiver !== undefined && waiverKind === undefined && waiverCovers === undefined) {
    return fail(deps, `--waiver '${opts.waiver}' 不是测试种类（${TEST_KINDS.join('/')}），也不是 spec:<capability>/<Scenario 标题> 或 task:<编号>`)
  }
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  let removed = 0
  const saved = await save(deps, context, change, 'unregister', (plan) => {
    const result = withoutTarget(plan, {
      ...(opts.suite === undefined ? {} : { suite: opts.suite }),
      ...(opts.file === undefined ? {} : { file: normalizeRepoPath(opts.file) }),
      ...(opts.case === undefined ? {} : { covers: opts.case }),
      ...(opts.test === undefined ? {} : { test: opts.test }),
      ...(waiverKind === undefined ? {} : { waiverKind }),
      ...(waiverCovers === undefined ? {} : { waiverCovers }),
    })
    removed = result.removed
    return result.plan
  })
  if (!saved.ok) return fail(deps, saved.message)
  if (removed === 0) return fail(deps, '计划里没有匹配的条目')
  deps.io.out(`[TEST] 已取消登记 ${removed} 项`)
  return 0
}

export async function cmdTestWaive(
  deps: CliDeps, change: string, opts: { readonly kind?: string; readonly covers?: string; readonly reason?: string },
): Promise<number> {
  if ((opts.kind === undefined) === (opts.covers === undefined)) return fail(deps, 'waive 需要恰好一个：--kind <k> 或 --covers <covers>')
  const reason = (opts.reason ?? '').trim()
  if (reason === '' || Buffer.byteLength(reason) > 1000) return fail(deps, '--reason 必填，且不超过 1000 字节')
  if (opts.kind !== undefined && !isTestKind(opts.kind)) return fail(deps, `--kind '${opts.kind}' 不合法（可选：${TEST_KINDS.join('/')}）`)
  if (opts.covers !== undefined && parseCovers(opts.covers) === undefined) return fail(deps, `--covers '${opts.covers}' 非法（spec:<capability>/<Scenario 标题> 或 task:<编号>）`)
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  const kind = opts.kind !== undefined && isTestKind(opts.kind) ? opts.kind : undefined
  const saved = await save(deps, context, change, 'waive', (plan) => withWaiver(plan, kind !== undefined
    ? { kind, reason, approved_by: null }
    : { covers: opts.covers ?? '', reason, approved_by: null }))
  if (!saved.ok) return fail(deps, saved.message)
  deps.io.out(`[TEST] 已登记豁免 ${kind !== undefined ? `kind ${kind}` : opts.covers}（未批准：豁免要在评审确认里批准后才解除阻塞）`)
  return 0
}
