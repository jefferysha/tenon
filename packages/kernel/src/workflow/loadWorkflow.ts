import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkflow } from './parse.js'
import { validateWorkflow, validateWorkflowForStorage } from './validate.js'
import type { WorkflowDef } from './types.js'
import { builtinWorkflow } from './builtin-workflows.js'

/**
 * 加载并校验一个 workflow 定义文件（GOAL E5：保存时校验的第二个消费点——目前没有独立的
 * "保存 workflow" 命令/编辑器，`loadWorkflow` 是唯一真实存在的读入口，故校验必须钉在这里，
 * 否则 E5"拒绝非法 workflow 不等运行时报错"这条承诺就是空话：一个手写的、带循环依赖/
 * 悬空引用/走不出去的死路 step 的 workflow 文件此前会被静默接受，直到真跑 transition 才在
 * 运行时以更难懂的方式暴露出来）。校验失败 fail-loud 抛错，不返回"看似合法"的 WorkflowDef：
 * - `transition.ts`/`internalSkillGate.ts` 两个调用方各自的顶层 catch 已经能正确处理——前者
 *   转成清晰的 `ERROR: ...` + exit 1（同 WorkflowError 的既有语义），后者本就对任何异常
 *   fail-open（WARN + exit 0，绝不因为 workflow 文件本身写错就把 hook 判定挂死）。
 */
export function loadWorkflow(repoRoot: string, name: string): WorkflowDef | null {
  const builtin = builtinWorkflow(name)
  if (builtin) {
    const errors = validateWorkflow(builtin)
    if (errors.length > 0) {
      throw new Error(`ERROR: 内建 workflow '${name}' 校验失败：\n${errors.map((e) => `  - ${e}`).join('\n')}`)
    }
    return builtin
  }
  const p = join(repoRoot, '.pipeline', 'workflows', `${name}.yaml`)
  if (!existsSync(p)) return null
  const wf = parseWorkflow(readFileSync(p, 'utf8'))
  // 'default' 是显式的存储键：项目覆盖文件 `.pipeline/workflows/default.yaml` 必须按 default 契约
  // （七阶段 + effective-phase-skills artifact）校验，否则内建模板自身的声明会被 custom 契约拒绝。
  const errors = validateWorkflowForStorage(name, wf)
  if (errors.length > 0) {
    throw new Error(`ERROR: workflow '${name}' 校验失败（${p}）：\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  }
  return wf
}
