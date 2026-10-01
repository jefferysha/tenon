/**
 * 测试完整性信号的码与中英短标签。不依赖任何模块：Dashboard 经 `@tenon/kernel/test-system/integrity-labels`
 * 直接读它（与阻塞码标签 blockers.ts 同一做法，前端不另存一份文案）。
 */
export const INTEGRITY_SIGNAL_CODES = [
  'case-count-drop', 'skip-count-rise', 'test-file-deleted', 'tests-removed', 'test-skipped',
  'assertion-weakened', 'snapshot-rewritten', 'baseline-changed', 'known-failure-added', 'coverage-threshold-lowered',
] as const
export type IntegritySignalCode = (typeof INTEGRITY_SIGNAL_CODES)[number]

export const INTEGRITY_SIGNAL_LABELS: Readonly<Record<IntegritySignalCode, { readonly zh: string; readonly en: string }>> = {
  'case-count-drop': { zh: '用例数下降', en: 'Case count dropped' },
  'skip-count-rise': { zh: '跳过数上升', en: 'Skips rose' },
  'test-file-deleted': { zh: '测试文件被删', en: 'Test file deleted' },
  'tests-removed': { zh: '用例被删', en: 'Tests removed' },
  'test-skipped': { zh: '用例被跳过', en: 'Tests skipped' },
  'assertion-weakened': { zh: '断言变少', en: 'Assertions removed' },
  'snapshot-rewritten': { zh: '快照被改写', en: 'Snapshot rewritten' },
  'baseline-changed': { zh: '基线被改', en: 'Baseline changed' },
  'known-failure-added': { zh: '新增已知失败', en: 'Known failure added' },
  'coverage-threshold-lowered': { zh: '覆盖率门槛降低', en: 'Coverage threshold lowered' },
}
