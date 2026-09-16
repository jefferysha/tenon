/**
 * 随插件发布的模板工作流：项目和全局都没有同名文件时，按打包的 YAML 源加载。
 *
 * `default` 一直如此（内建模板），`design-system`（设计体系）同样是模板而不是 TS 内建：它可编辑、
 * 可被项目文件覆盖，Dashboard 也能「恢复内建」。源文本来自生成文件，与 templates/workflows/*.yaml 逐字节一致。
 */
import { DEFAULT_WORKFLOW_SOURCE, DESIGN_SYSTEM_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { isTemplateWorkflowName, type TemplateWorkflowName } from './identifier.js'

const SOURCES: Readonly<Record<TemplateWorkflowName, string>> = {
  default: DEFAULT_WORKFLOW_SOURCE,
  'design-system': DESIGN_SYSTEM_WORKFLOW_SOURCE,
}

/** 模板 YAML 原文；不是模板名（或源为空）时 undefined。 */
export function templateWorkflowSource(name: string): string | undefined {
  if (!isTemplateWorkflowName(name)) return undefined
  const source = SOURCES[name]
  return source === '' ? undefined : source
}
