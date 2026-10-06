/**
 * `tenon verify --ci` 报告里的固定文案（标题、列名、信任边界陈述、CI 独有发现的说明）按稳定的键取，文本由调用方给：
 * kernel 只定义键与参数，不带任何一种语言。CLI 把这些键登记进它的消息目录（`verify.<键>`，zh / en 各一份，语言由
 * `TENON_LANG` → `LC_ALL` → `LC_MESSAGES` → `LANG` 决定，缺省中文），测试用 `ciKeyText` 看键与参数。
 *
 * 占位符写成 `{name}`；渲染层只传字符串与数字。策略判定产出的阻塞 / 提示文案不在这里：它们来自测试体系的判定
 * （中文句子 + 中英文短标签），由 CLI 按语言选。
 */
export const CI_TEXT_KEYS = [
  // 标题与图例
  'headline', 'verdict.pass', 'verdict.fail', 'severity.error', 'severity.warning', 'severity.note',
  'chain.none', 'chain.records', 'chain.empty', 'chain.broken',
  'policy.none', 'policy.pass', 'policy.fail', 'changeLine', 'noFindings', 'noChangesInScope',
  'verifiedHeading', 'unverifiableHeading', 'footer', 'unknown', 'fixSuffix',
  // Markdown 表格与小节
  'md.colChange', 'md.colStep', 'md.colPolicy', 'md.colChains', 'md.colAnchor', 'md.colErrors', 'md.colWarnings',
  'md.findingsHeading', 'md.colSeverity', 'md.colCode', 'md.colTask', 'md.colMessage',
  'md.verifiedHeading', 'md.unverifiableHeading', 'md.unverifiableLead',
  // 信任边界
  'trust.unverifiable.records', 'trust.unverifiable.approvals', 'trust.unverifiable.reports', 'trust.unverifiable.identity',
  'trust.verified.chain', 'trust.verified.consistent', 'trust.verified.plan', 'trust.verified.policy',
  'trust.verified.candidateOff', 'trust.verified.candidate', 'trust.verified.candidateWarn',
  'trust.verified.protected', 'trust.verified.integrity', 'trust.verified.anchor', 'trust.verified.anchorNone',
  // 锚点
  'anchor.missing', 'anchor.emptyChain', 'anchor.unverifiable', 'anchor.rewritten', 'anchor.behind',
  // 受保护文件批准
  'protected.kind.catalog', 'protected.kind.baseline', 'protected.kind.known-failures', 'protected.kind.workflow',
  'protected.status.added', 'protected.status.modified', 'protected.status.deleted',
  'protected.line', 'protected.unapproved', 'protected.unbound', 'protected.changed',
  // 记录自洽
  'record.keptTooMany', 'record.wrongChange', 'record.wrongActor', 'record.resultMismatch',
] as const

export type CiTextKey = (typeof CI_TEXT_KEYS)[number]
export type CiTextParams = Readonly<Record<string, string | number>>
export type CiText = (key: CiTextKey, params?: CiTextParams) => string

/** 把键和参数原样写出来的文本源：kernel 的单元测试用它断言「说了什么」而不依赖任何一种语言。 */
export const ciKeyText: CiText = (key, params) =>
  params === undefined || Object.keys(params).length === 0 ? key : `${key} ${JSON.stringify(params)}`
