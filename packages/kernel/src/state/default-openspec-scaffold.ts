/**
 * Default-workflow OpenSpec initial files.
 *
 * The renderer is deliberately pure. WorkflowRunRepository passes these files to StateStore.init,
 * which prepares them beside canonical state in a private Change candidate and publishes the
 * complete directory once. No post-init path re-open exists for a symlink race to redirect.
 */
import {
  renderDocumentTemplate,
  type DocumentLocale,
  type DocumentTemplateVariables,
  type WorkflowStepPresentation,
} from '../documents/index.js'

export interface DefaultOpenSpecScaffoldFile {
  readonly relativePath: 'proposal.md' | 'design.md' | 'tasks.md'
  readonly content: string
}

/**
 * 只有 tasks.md：不带旧文档契约的新任务（观察模式）仍走 OpenSpec 的 Todo 来源（`tasks-through-step` 按步骤标题判定），
 * 但不再预先铺 proposal / design。
 */
export function defaultTasksScaffoldFile(
  change: string,
  locale: DocumentLocale = 'zh-CN',
  workflowSteps?: readonly WorkflowStepPresentation[],
  workflowStepLabelSource: DocumentTemplateVariables['workflowStepLabelSource'] = 'localized-builtin',
): DefaultOpenSpecScaffoldFile {
  return {
    relativePath: 'tasks.md',
    content: renderDocumentTemplate('workflow-tasks', locale, {
      change,
      workflowStepLabelSource,
      workflowSteps,
    }),
  }
}

export function defaultOpenSpecScaffoldFiles(
  change: string,
  locale: DocumentLocale = 'zh-CN',
  workflowSteps?: readonly WorkflowStepPresentation[],
  workflowStepLabelSource: DocumentTemplateVariables['workflowStepLabelSource'] = 'localized-builtin',
): readonly DefaultOpenSpecScaffoldFile[] {
  return [
    {
      relativePath: 'proposal.md',
      content: renderDocumentTemplate('openspec-proposal', locale, { change }),
    },
    {
      relativePath: 'design.md',
      content: renderDocumentTemplate('openspec-design', locale, { change }),
    },
    defaultTasksScaffoldFile(change, locale, workflowSteps, workflowStepLabelSource),
  ]
}
