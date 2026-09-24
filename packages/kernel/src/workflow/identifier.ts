/** Canonical workflow identity predicates shared by definition validation and observability codecs. */
const WORKFLOW_NAME_RE = /^[\p{L}\p{N}\p{M}_-]+$/u

export function isValidWorkflowName(value: string): boolean {
  return WORKFLOW_NAME_RE.test(value)
}

export function isDefaultWorkflowName(value: string): boolean {
  return value === 'default'
}

/**
 * 随插件发布的模板工作流名。它们可编辑、可被项目文件覆盖，Dashboard 的「恢复内建」按这张表判断；
 * 源文本在 template-workflows.ts（那边 import 生成文件，本文件刻意不 import——Dashboard 只要名字）。
 */
export const TEMPLATE_WORKFLOW_NAMES = ['default', 'design-system'] as const
export type TemplateWorkflowName = (typeof TEMPLATE_WORKFLOW_NAMES)[number]

export function isTemplateWorkflowName(value: string): value is TemplateWorkflowName {
  return (TEMPLATE_WORKFLOW_NAMES as readonly string[]).includes(value)
}

/**
 * 插件自有、版本化的只读工作流名（项目文件不能覆盖）。定义正文在 builtin-workflows.ts；名字放在这里，
 * Dashboard 列出与判定只读时不必拉进定义本身。
 */
export const BUILTIN_WORKFLOW_IDS = ['simple'] as const
export type BuiltinWorkflowId = (typeof BUILTIN_WORKFLOW_IDS)[number]

export function isBuiltinWorkflowName(value: string): value is BuiltinWorkflowId {
  return (BUILTIN_WORKFLOW_IDS as readonly string[]).includes(value)
}
