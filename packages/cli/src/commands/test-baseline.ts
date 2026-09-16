/**
 * `tenon test baseline <change> <test-id> --run <run-id>` —— 用一次通过的运行的指标当作本用户的基线。
 * 旧值进 history（留痕），基线按用户维护：基准数值受机器影响，跨用户比较没有意义。
 */
import { join } from 'node:path'
import {
  nextBaseline, readTestBaseline, readTestRunRecord, testBaselinePath, testEvidencePaths, writeTestBaseline,
  TEST_RUN_ID_RE,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { locateTest, resolveTestCommand } from './test-context.js'

export async function cmdTestBaseline(
  deps: CliDeps,
  change: string,
  testId: string,
  opts: { readonly run: string },
): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  if (locateTest(context.plan, testId) === undefined) {
    deps.io.err(`ERROR: 未声明的测试 '${testId}'`)
    return 1
  }
  if (!TEST_RUN_ID_RE.test(opts.run)) {
    deps.io.err(`ERROR: run-id 非法: '${opts.run}'`)
    return 1
  }
  const paths = testEvidencePaths(deps.cwd, context.slug, change)
  const record = await readTestRunRecord(join(paths.runsDir, `${opts.run}.json`))
  if (record === undefined || record.test_id !== testId) {
    deps.io.err(`ERROR: 找不到当前用户的运行记录 '${opts.run}'`)
    return 1
  }
  if (record.result !== 'pass') {
    deps.io.err(`ERROR: run ${opts.run} 未通过，不能作为基线`)
    return 1
  }
  const metrics: Record<string, number> = {}
  for (const metric of record.metrics) {
    if (metric.value !== null) metrics[metric.name] = metric.value
  }
  if (Object.keys(metrics).length === 0) {
    deps.io.err(`ERROR: run ${opts.run} 没有指标，不能作为基线`)
    return 1
  }
  const path = testBaselinePath(deps.cwd, context.slug, testId)
  try {
    const baseline = nextBaseline(await readTestBaseline(path), {
      test_id: testId,
      command: record.command,
      cwd: record.cwd,
      metrics,
      source: { change, run_id: record.run_id },
      actor: context.actor,
      updated_at: deps.clock(),
    })
    await writeTestBaseline(path, paths.baselinesDir, baseline)
  } catch (e) {
    deps.io.err(`ERROR: 基线写入失败: ${errMsg(e)}`)
    return 1
  }
  deps.io.out(`[BASELINE] ${testId} ${Object.keys(metrics).length} 项指标 ← run ${record.run_id}`)
  return 0
}
