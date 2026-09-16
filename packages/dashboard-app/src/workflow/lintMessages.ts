import type { useT } from '../i18n'
import type { LintIssue } from './lint'

type Translate = ReturnType<typeof useT>['t']

/** 一条 lint 问题的界面文案（导航圆点 title 与阶段面板共用）。 */
export function lintMessage(t: Translate, issue: LintIssue, labelOf: (stepId: string) => string): string {
  switch (issue.kind) {
    case 'step-no-output': return t('workflow.lint_no_output')
    case 'input-not-upstream': return t('workflow.lint_input_not_upstream', { field: issue.field })
    case 'transition-empty-event': return t('workflow.lint_transition_empty_event')
    case 'transition-duplicate-event': return t('workflow.lint_transition_duplicate_event', { event: issue.event })
    case 'transition-contract-required': return t('workflow.lint_transition_contract_required', { to: labelOf(issue.to) })
    case 'transition-not-next-or-back': return t('workflow.lint_transition_not_next_or_back', { event: issue.event, to: labelOf(issue.to) })
    case 'document-producer-missing': return t('workflow.lint_document_producer_missing', { document: issue.document, skill: issue.skill })
    case 'document-order': return t('workflow.lint_document_order', { document: issue.document })
    case 'document-chain-gap': return t('workflow.lint_document_gap', { missing: issue.missing })
    case 'test-id-duplicate': return t('workflow.lint_test_id_duplicate', { test: issue.test })
    case 'test-command-empty': return t('workflow.lint_test_command_empty', { test: issue.test })
    case 'test-output-location': return t('workflow.lint_test_output_location', { path: issue.path })
  }
}
