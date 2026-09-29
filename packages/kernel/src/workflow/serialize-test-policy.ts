/**
 * `test_policy:` 块的写回（parse-test-policy.ts 的反向），恒写块形态。键序固定
 * `plan, kinds, run, run_if_registered, scope, files, scenarios, coverage, flaky, benchmark, browsers`；
 * 缺省键不写，coverage / flaky / benchmark 写单行 `{ k: v }`。
 */
import type { StepTestPolicyDef } from './types.js'

function inlineMap(value: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `${key}: ${String(item)}`)
  return `{ ${entries.join(', ')} }`
}

export function serializeStepTestPolicy(policy: StepTestPolicyDef | undefined): string[] {
  if (policy === undefined) return []
  const pad = '      '
  const lines = ['    test_policy:']
  if (policy.plan !== undefined) lines.push(`${pad}plan: ${policy.plan}`)
  for (const key of ['kinds', 'run', 'run_if_registered'] as const) {
    const list = policy[key]
    if (list !== undefined) lines.push(`${pad}${key}: [${list.join(', ')}]`)
  }
  if (policy.scope !== undefined) lines.push(`${pad}scope: ${policy.scope}`)
  if (policy.files !== undefined) lines.push(`${pad}files: ${policy.files}`)
  if (policy.scenarios !== undefined) lines.push(`${pad}scenarios: ${policy.scenarios}`)
  if (policy.coverage !== undefined) lines.push(`${pad}coverage: ${inlineMap(policy.coverage)}`)
  if (policy.flaky !== undefined) lines.push(`${pad}flaky: ${inlineMap(policy.flaky)}`)
  if (policy.benchmark !== undefined) lines.push(`${pad}benchmark: ${inlineMap(policy.benchmark)}`)
  if (policy.browsers !== undefined) lines.push(`${pad}browsers: [${policy.browsers.join(', ')}]`)
  return lines
}
