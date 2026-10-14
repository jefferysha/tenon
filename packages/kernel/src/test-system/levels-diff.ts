/**
 * 档位定义（目录顶层键 `levels`）改动前后的比较，给评审摘要用：档位决定「普通任务要过哪些门槛才能出口」，
 * 目录又是 agent 可编辑的受保护配置，用户批准目录改动时必须看得见门槛被放宽还是收紧。
 * 比较的是生效值（resolveLevel：目录没写的键取内建缺省），不是原文——显式写出与缺省相同的值不算改动，
 * 删掉整个 `levels` 等于回到缺省。纯函数。
 */
import { LEVEL_NAMES, resolveLevel, type CatalogLevels, type LevelName, type ResolvedLevel } from './levels.js'
import { COVERAGE_METRICS, type TestClass } from './vocabulary.js'

const NONE = '不设'
const STRICTNESS: Readonly<Record<ResolvedLevel['scenarios'], number>> = { off: 0, required: 1, passing: 2 }

function verdict(tighter: boolean): string {
  return tighter ? '收紧' : '放宽'
}

function yesNo(value: boolean): string {
  return value ? '是' : '否'
}

/** 类的集合比较：去掉的类是放宽，加上的类是收紧；去掉在前。 */
function classLines(head: string, label: string, before: readonly TestClass[], after: readonly TestClass[]): readonly string[] {
  const removed = before.filter((name) => !after.includes(name))
  const added = after.filter((name) => !before.includes(name))
  return [
    ...(removed.length === 0 ? [] : [`${head}${label}去掉 ${removed.join('、')}（放宽）`]),
    ...(added.length === 0 ? [] : [`${head}${label}加上 ${added.join('、')}（收紧）`]),
  ]
}

/** 数值门槛：undefined = 没有门槛（「不设」）。覆盖率越高越严，不稳定用例上限越高越松；没有门槛是最松的一端。 */
function numberLines(head: string, label: string, before: number | undefined, after: number | undefined, higherIsTighter: boolean): readonly string[] {
  if (before === after) return []
  const none = higherIsTighter ? -Infinity : Infinity
  const was = before ?? none
  const now = after ?? none
  return [`${head}${label} ${before ?? NONE} → ${after ?? NONE}（${verdict(higherIsTighter ? now > was : now < was)}）`]
}

function flagLines(head: string, label: string, before: boolean, after: boolean): readonly string[] {
  return before === after ? [] : [`${head}${label} ${yesNo(before)} → ${yesNo(after)}（${verdict(after)}）`]
}

function tierLines(name: LevelName, before: ResolvedLevel, after: ResolvedLevel): readonly string[] {
  const head = `档位 ${name}：`
  const lines: string[] = [
    ...classLines(head, '必需类', before.required, after.required),
    ...classLines(head, '碰到才跑的类', before.touched, after.touched),
  ]
  if (before.scenarios !== after.scenarios) {
    lines.push(`${head}场景映射 ${before.scenarios} → ${after.scenarios}（${verdict(STRICTNESS[after.scenarios] > STRICTNESS[before.scenarios])}）`)
  }
  for (const metric of COVERAGE_METRICS) {
    lines.push(...numberLines(head, `覆盖率 ${metric}`, before.coverage?.[metric], after.coverage?.[metric], true))
  }
  lines.push(
    ...numberLines(head, '不稳定用例上限', before.flaky?.max, after.flaky?.max, false),
    ...flagLines(head, '新失败的不稳定用例挡出口', before.flaky?.fail_on_new ?? false, after.flaky?.fail_on_new ?? false),
    ...flagLines(head, '缺基线挡出口', before.require_baseline, after.require_baseline),
  )
  return lines
}

/** 档位定义改动前后的生效值逐档逐键比较，返回给用户看的行（放宽 / 收紧）。生效值 = resolveLevel（目录没写的键取内建缺省）。 */
export function describeLevelChanges(before: CatalogLevels | undefined, after: CatalogLevels | undefined): readonly string[] {
  const resolve = (name: LevelName, levels: CatalogLevels | undefined): ResolvedLevel =>
    resolveLevel(name, levels === undefined ? undefined : { levels })
  return LEVEL_NAMES.flatMap((name) => tierLines(name, resolve(name, before), resolve(name, after)))
}
