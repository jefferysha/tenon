/**
 * `tenon test baseline <change> --suite <id> --run <run-id>` —— 用一次通过的运行的基准指标当作该机器画像下的基线。
 * 基线存 `.tenon/tests/baselines/<套件>/<画像>.json`（进 git，团队共享），旧值压进历史（≤20）；不同画像互不比较。
 * 只认当前记录链上的运行（链断的记录视为未运行），且该套件在那次运行里必须通过并带有指标。更新动作追加进用户的 audit.jsonl。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  SUITE_ID_RE, TEST_RUN_ID_RE, baselineV2Path, nextBaselineV2, readRecordChain, readTestBaselineV2, userProjectPaths,
  writeTestBaselineV2, type BaselineMetricV2,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { resolveTestCommand } from './test-context.js'

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

export async function cmdTestBaselineSuite(
  deps: CliDeps,
  change: string,
  opts: { readonly suite: string; readonly run: string },
): Promise<number> {
  if (!SUITE_ID_RE.test(opts.suite)) return fail(deps, `--suite '${opts.suite}' 不是合法的套件 id`)
  if (!TEST_RUN_ID_RE.test(opts.run)) return fail(deps, `run-id 非法: '${opts.run}'`)
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  const chain = await readRecordChain(deps.cwd, context.slug, change)
  if (chain.state === 'broken') return fail(deps, `测试记录被改动（${chain.reason}）；先重跑 tenon test run ${change} --stage 另起新链`)
  const record = chain.state === 'intact' ? chain.active.find((entry) => entry.run_id === opts.run) : undefined
  if (record === undefined) return fail(deps, `当前用户的记录链上找不到运行 '${opts.run}'`)
  const run = record.suites.find((entry) => entry.suite === opts.suite)
  if (run === undefined) return fail(deps, `运行 ${opts.run} 里没有套件 '${opts.suite}'`)
  if (run.result !== 'pass') return fail(deps, `运行 ${opts.run} 里套件 ${opts.suite} 没有通过，不能作为基线`)
  if (run.metrics.length === 0) return fail(deps, `运行 ${opts.run} 里套件 ${opts.suite} 没有基准指标，不能作为基线`)
  const metrics: Record<string, BaselineMetricV2> = {}
  for (const metric of run.metrics) {
    metrics[metric.name] = {
      median: metric.median, p95: metric.p95, mad: metric.mad, samples: metric.samples.length, better: metric.better,
      ...(metric.unit === undefined ? {} : { unit: metric.unit }),
    }
  }
  try {
    const path = baselineV2Path(deps.cwd, opts.suite, record.machine_profile)
    const previous = await readTestBaselineV2(path)
    if (previous.state === 'corrupt') return fail(deps, `现有基线文件已损坏：${path}；先删除或修复再更新`)
    const updatedAt = deps.clock()
    const baseline = nextBaselineV2(previous.state === 'ok' ? previous.baseline : undefined, {
      suite: opts.suite, profile: record.machine_profile, profile_label: record.machine_label, metrics,
      source: { change, run_id: record.run_id, commit: record.git_head }, actor: context.actor, updated_at: updatedAt,
    })
    await writeTestBaselineV2(path, baseline)
    const audit = userProjectPaths(deps.cwd, context.slug).audit
    await mkdir(dirname(audit), { recursive: true })
    await appendFile(audit, `${JSON.stringify({
      action: 'test-baseline', at: updatedAt, actor: context.actor, change, suite: opts.suite,
      profile: record.machine_profile, run_id: record.run_id,
    })}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    return fail(deps, `基线写入失败: ${errMsg(error)}`)
  }
  deps.io.out(`[BASELINE] ${opts.suite} @ ${record.machine_label}：${Object.keys(metrics).length} 项指标 ← run ${record.run_id}`)
  return 0
}
