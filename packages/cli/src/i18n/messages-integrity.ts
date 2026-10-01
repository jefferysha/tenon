/**
 * `tenon test integrity` 的输出。`zh` 与该命令原有的中文输出逐字一致；
 * 信号名本身（用例数下降、跳过上升……）来自 kernel 的 INTEGRITY_SIGNAL_LABELS，按语言取。
 */
export const INTEGRITY_MESSAGES = {
  'integrity.stepNotInWorkflow': {
    zh: "step '{step}' 不在 workflow '{workflow}' 里",
    en: "step '{step}' is not in workflow '{workflow}'",
  },
  'integrity.unavailable': {
    zh: '读不出本任务的改动行（{reason}）：只检查了运行记录',
    en: 'cannot read the changed lines of this task ({reason}): only the run records were checked',
  },
  'integrity.reasonUnknown': {
    zh: '未知',
    en: 'unknown',
  },
  'integrity.truncated': {
    zh: '相关测试文件有 {found} 个，只检查了前 {limit} 个',
    en: 'there are {found} relevant test files; only the first {limit} were checked',
  },
} as const
