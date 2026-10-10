/**
 * `tenon test plan <change> [--seed] [--json]` —— 查看任务测试计划，或生成计划初稿。
 * 计划由 CLI 独占写入（摘要记进 change 目录的台账）；手改文件会被判 test-plan-tampered，用 --seed 重新生成。
 * 初稿只增不减：diff 碰到的套件、策略要求种类的套件、diff 里未登记的测试文件；未映射的场景 / 任务只列出命令。
 */
import { emptyTestPlan, planCatalogProblems, shellQuote, updateTestPlan, type TestPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { loadPlanInputs, policiesOf, tryChangedFiles } from '../test-system/plan-context.js'
import { seedPlan, splitUnmapped, type SeedResult } from '../test-system/plan-edit.js'
import { resolveTestCommand } from './test-context.js'

const MAX_LISTED = 15

function describePlan(deps: CliDeps, plan: TestPlan): void {
  deps.io.out(`  套件（${plan.suites.length}）：${plan.suites.length === 0 ? '无' : ''}`)
  for (const item of plan.suites) {
    const extra = item.pattern !== undefined ? ` pattern=${item.pattern}` : item.files !== undefined ? ` files=${item.files.join(',')}` : ''
    deps.io.out(`    ${item.suite}  scope=${item.scope}${extra}`)
  }
  deps.io.out(`  测试文件（${plan.files.length}）：${plan.files.length === 0 ? '无' : ''}`)
  for (const item of plan.files) deps.io.out(`    ${item.path}${item.suite === undefined ? '' : `  suite=${item.suite}`}${item.kind === undefined ? '' : `  kind=${item.kind}`}`)
  deps.io.out(`  追溯映射（${plan.cases.length}）：${plan.cases.length === 0 ? '无' : ''}`)
  for (const item of plan.cases) deps.io.out(`    ${item.covers}  ←  ${item.tests.join(' | ')}`)
  deps.io.out(`  豁免（${plan.waivers.length}）：${plan.waivers.length === 0 ? '无' : ''}`)
  for (const item of plan.waivers) {
    const target = item.kind !== undefined ? `kind ${item.kind}` : item.test !== undefined ? `test ${item.test}` : item.covers
    deps.io.out(`    ${target}  ${item.approved_by === null ? '[未批准]' : `[已批准 ${item.approved_by}]`}  ${item.reason}`)
  }
}

export function printSeed(deps: CliDeps, change: string, seed: SeedResult): void {
  deps.io.out(`[TEST] plan ${change} 初稿：新增套件 ${seed.addedSuites.length} 个，测试文件 ${seed.addedFiles.length} 个`)
  for (const id of seed.addedSuites) deps.io.out(`  + 套件 ${id}`)
  for (const path of seed.addedFiles) deps.io.out(`  + 文件 ${path}`)
  for (const kind of seed.missingKinds) {
    deps.io.out(`  ! 策略要求 ${kind} 测试，但目录里没有该种类的套件：tenon test catalog add ... --kind ${kind}；本项目都不适用就 tenon test catalog not-applicable ${kind} --reason ${shellQuote('<原因>')}（经评审确认一次后对所有任务生效）；只有本任务不适用 tenon test waive ${change} --kind ${kind} --reason ${shellQuote('<原因>')}`)
  }
  for (const path of seed.orphans) deps.io.out(`  ! 测试文件 ${path} 没有套件认领：tenon test register ${change} --auto（把它并进对应套件的文件 glob 并登记）`)
  const { required, optional } = splitUnmapped(seed.unmapped)
  if (required.length > 0) {
    deps.io.out(`  待映射的场景 / 任务（${required.length}）：写好测试后逐条登记`)
    for (const item of required.slice(0, MAX_LISTED)) {
      deps.io.out(`    ${item.title}\n      tenon test register ${change} --case ${shellQuote(item.covers)} --test ${shellQuote('<文件> › <用例名>')}`)
    }
    if (required.length > MAX_LISTED) deps.io.out(`    … 另有 ${required.length - MAX_LISTED} 条`)
  }
  if (optional.length > 0) {
    deps.io.out(`  可选的任务（${optional.length}）：不在实现阶段小节，不要求映射用例，不挡出口；想追溯时同样用 tenon test register ${change} --case '<covers>' --test '<文件> › <用例名>'`)
    for (const item of optional.slice(0, MAX_LISTED)) deps.io.out(`    ${item.covers}  ${item.title}`)
    if (optional.length > MAX_LISTED) deps.io.out(`    … 另有 ${optional.length - MAX_LISTED} 条`)
  }
}

export async function cmdTestPlan(
  deps: CliDeps,
  change: string,
  opts: { readonly seed?: boolean; readonly json?: boolean } = {},
): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: opts.seed === true })
  if (typeof context === 'number') return context
  const inputs = await loadPlanInputs(deps, context)
  if (opts.seed === true) {
    if (inputs.catalog.state !== 'ok') {
      deps.io.err(`ERROR: ${inputs.catalog.state === 'missing' ? '还没有测试目录；先 tenon test discover --write' : 'catalog.yaml 无效；先 tenon test catalog validate'}`)
      return 1
    }
    const catalog = inputs.catalog.catalog
    const diff = await tryChangedFiles(deps, change)
    const seen: { result?: SeedResult; resetTampered?: boolean } = {}
    const written = await updateTestPlan(context.dir, change, { actor: context.actor, recordedAt: deps.clock(), op: 'seed' }, (state) => {
      seen.resetTampered = state.state === 'tampered'
      const seeded = seedPlan({
        catalog, plan: state.state === 'ok' ? state.plan : emptyTestPlan(change),
        changedFiles: diff.ok ? diff.files : undefined,
        policies: policiesOf(context), scenarios: inputs.scenarios, tasks: inputs.tasks,
      })
      seen.result = seeded
      return { plan: seeded.plan }
    })
    const result = seen.result
    if ('rejected' in written || result === undefined) {
      deps.io.err(`ERROR: ${'rejected' in written ? written.rejected : '计划初稿生成失败'}`)
      return 1
    }
    if (opts.json === true) {
      deps.io.out(JSON.stringify({ change, digest: written.digest, ...result, diff: diff.ok ? 'ok' : diff.reason }, null, 2))
      return 0
    }
    if (seen.resetTampered === true) deps.io.out('  注意：旧计划文件被手工改动过，已丢弃并重新生成')
    printSeed(deps, change, result)
    if (!diff.ok) deps.io.out(`  注意：读不到 diff（${diff.reason}），没有补测试文件；解决后重跑 tenon test plan ${change} --seed`)
    return 0
  }
  const state = inputs.planState
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change, state: state.state,
      ...(state.state === 'tampered' ? { reason: state.reason } : {}),
      ...(state.state === 'ok' ? { digest: state.digest, plan: state.plan } : {}),
    }, null, 2))
    return state.state === 'ok' ? 0 : 2
  }
  if (state.state === 'missing') {
    deps.io.out(`[TEST] plan ${change}：还没有登记；执行 tenon test plan ${change} --seed 生成初稿`)
    return 2
  }
  if (state.state === 'tampered') {
    deps.io.out(`[FAIL] plan ${change} 不可信：${state.reason}；执行 tenon test plan ${change} --seed 重新登记`)
    return 2
  }
  deps.io.out(`[TEST] plan ${change}  ${state.digest}  登记于 ${state.ledger.recorded_at}（${state.ledger.actor.name}）`)
  describePlan(deps, state.plan)
  if (inputs.catalog.state === 'ok') {
    for (const problem of planCatalogProblems(state.plan, inputs.catalog.catalog)) deps.io.out(`  [FAIL] ${problem.message}`)
  }
  const mapped = new Set(state.plan.cases.map((item) => item.covers))
  const requiredUnmapped = inputs.scenarios.filter((item) => !mapped.has(item.covers)).length + inputs.tasks.filter((item) => item.required && !mapped.has(item.covers)).length
  const optionalUnmapped = inputs.tasks.filter((item) => !item.required && !item.placeholder && !mapped.has(item.covers)).length
  if (requiredUnmapped > 0) deps.io.out(`  还有 ${requiredUnmapped} 个场景 / 任务条目没有映射用例`)
  if (optionalUnmapped > 0) deps.io.out(`  另有 ${optionalUnmapped} 个可选任务没有映射用例（不挡）`)
  return 0
}
