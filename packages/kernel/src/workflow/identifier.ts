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
