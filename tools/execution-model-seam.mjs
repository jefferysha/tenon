// 执行模型（'phase-manifest' / 'step-graph'）的判断只许出现在接缝里：新任务按 YAML 的步骤图执行，
// 快照里记着旧模型的任务走旧引擎，选哪个适配器由 kernel 的 selectExecution 与 CLI 的 execution-cli-seam
// 两处决定。其余生产代码拿到计划后只调接缝，不自己拿字面量比较——否则旧引擎下个版本删除时，
// 散在各处的判断会一并留下，成为永远不会走到的死分支。
//
// 规则看「比较」：`=== / !== / == / !=` 与 `case` 标签。类型联合、对象属性值、函数实参、默认值与数组字面量
// 只是在命名模型，不是分支判断，不算。字面量被赋给变量再比较这类间接写法没有全程数据流就看不出来，
// 与 check-architecture 里的 workflow 身份规则同一口径：靠评审补位。
//
// 计划里的技能策略（`skills.source` / `skillPolicy`，取值 'manifest-overlay' / 'step-declared'）是执行模型的
// 投影：它和 `execution.model` 在 planFromIr 里出自同一个入参，旧模型恒为 'manifest-overlay'、新模型恒为
// 'step-declared'。比较它的字面量等于换个写法判断执行模型，所以一并纳入。

const MODEL = String.raw`['"](?:phase-manifest|step-graph|manifest-overlay|step-declared)['"]`
const OPERATOR = String.raw`(?:===|!==|==|!=)`
const COMPARISON = new RegExp(
  String.raw`${OPERATOR}\s*${MODEL}|${MODEL}\s*${OPERATOR}|\bcase\s+${MODEL}\s*:`,
  'gu',
)

// 扫描范围：能调用 kernel 接缝的后端包。dashboard-app 是浏览器端，读的是服务端投影出来的 executionModel 字段，
// 不能也不该 import 内核接缝。
const SCANNED_PREFIXES = [
  'packages/kernel/src/',
  'packages/cli/src/',
  'packages/server/src/',
  'packages/automation/src/',
]

export const EXECUTION_MODEL_SEAM_FILES = new Map([
  ['packages/kernel/src/workflow/execution-seam.ts',
    'kernel 接缝：按计划里记着的执行模型选适配器，转换规划、就绪判定、出口报告都经它'],
  ['packages/cli/src/commands/execution-cli-seam.ts',
    'CLI 接缝：命令里凡要区分新旧执行模型的地方都调它，不自己判断'],
  ['packages/kernel/src/workflow/implicit-completion.ts',
    'isForwardEdge 在运行时依赖图里处于接缝之下（compile.ts → step-rounds.ts → 本文件），调用方只传模型名、没有计划对象，不能反向引用接缝'],
  ['packages/kernel/src/workflow/effective-plan-build.ts',
    '构造计划：按正在构造的模型决定技能策略、步骤标签来源与旧轨道策略位，模型是被构造的数据，不是调用方的分支'],
  ['packages/kernel/src/workflow/effective-plan-snapshot-compat.ts',
    '旧快照重建：按快照记着的模型还原当时的技能策略'],
  ['packages/kernel/src/workflow/effective-plan.ts',
    '冻结快照解码：校验快照里记着的模型名属于闭集'],
  ['packages/kernel/src/state/workflow-plan-snapshot.ts',
    '持久化快照解码：校验落盘的模型名属于闭集'],
])

export const EXECUTION_MODEL_SEAM_DIRS = new Map([
  ['packages/kernel/src/workflow/legacy-phase-manifest/',
    '旧引擎整目录，只服务快照里记着旧模型的在途任务，下个版本整体删除'],
])

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
}

/** 代码里每处执行模型字面量比较所在的行号（1 起，注释不算）。 */
export function executionModelComparisonLines(text) {
  const lines = []
  for (const [index, line] of withoutComments(text).split(/\r?\n/).entries()) {
    COMPARISON.lastIndex = 0
    for (const _comparison of line.matchAll(COMPARISON)) lines.push(index + 1)
  }
  return lines
}

function isAllowedSite(rel) {
  return EXECUTION_MODEL_SEAM_FILES.has(rel)
    || [...EXECUTION_MODEL_SEAM_DIRS.keys()].some((dir) => rel.startsWith(dir))
}

/** `rel` 是仓库相对路径、`text` 是该生产文件的源码；返回这个文件里每处越界比较的一条失败说明。 */
export function executionModelSeamFailures(rel, text) {
  if (!SCANNED_PREFIXES.some((prefix) => rel.startsWith(prefix)) || isAllowedSite(rel)) return []
  return executionModelComparisonLines(text).map((line) =>
    `${rel}:${line}: execution model must be chosen by the execution seam (selectExecution / execution-cli-seam), not compared with a model literal`)
}
