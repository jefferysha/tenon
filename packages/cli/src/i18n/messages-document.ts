/**
 * 观察模式（没有旧文档契约的新任务）下 `tenon document` 命令的输出：旧命令的拒绝、`document read` 的路径校验、
 * `document status` 的人读报告，以及 verify-fail 就绪检查里「必须产出还缺」的一句。
 * 信息本身（输入 / 产出 / 必须产出）来自 kernel 的步骤产出账本，这里只有措辞。
 */
export const DOCUMENT_MESSAGES = {
  'document.observed.autoRecorded': {
    zh: '本任务的产出由 Tenon 在离开步骤时自动记录，tenon {command} 只服务升级前创建的任务',
    en: 'The outputs of this task are recorded automatically by Tenon when a step is left; tenon {command} only serves tasks created before the upgrade',
  },
  'document.observed.pathOutsideProject': {
    zh: "路径 '{path}' 不在项目内：tenon document read 只接受本步的交接输入",
    en: "path '{path}' is outside the project: tenon document read only accepts the handoff inputs of this step",
  },
  'document.observed.inputLine': {
    zh: '  [{mark}] {path} · 来自 {from} · {skill}',
    en: '  [{mark}] {path} · from {from} · {skill}',
  },
  'document.observed.outputLine': {
    zh: '  [OUT:{change}] {path} · {skill}',
    en: '  [OUT:{change}] {path} · {skill}',
  },
  'document.observed.skillUnknown': {
    zh: '未知',
    en: 'unknown',
  },
  'document.observed.unreadSummary': {
    zh: '还有 {count} 个输入没读；读完后执行 tenon document read {change} all',
    en: 'Unread inputs: {count}; read them, then run tenon document read {change} all',
  },
  'document.observed.requiredMissing': {
    zh: "step '{step}' 要求产出匹配 {path} 的文件（本任务里这一步还没有写出这样的文件）",
    en: "step '{step}' requires a produced file matching {path} (this step has not written one in this task yet)",
  },
  'document.observed.pass': {
    zh: '输入已读完，必须产出齐全',
    en: 'all inputs are read and the required outputs are present',
  },
} as const
