/**
 * 测试门禁的阻塞码（设计 §9 全集）与提示码。每个阻塞带：稳定 code（同时是 Dashboard 短标签的键）、
 * 是否阻塞、完整说明、修复命令。`tenon status` 的 blockers、transition 拒绝与工作台共用这一份。
 */

export const TEST_BLOCKER_CODES = [
  'test-catalog-missing', 'test-plan-missing', 'test-plan-tampered', 'test-kind-missing', 'test-file-unregistered',
  'test-file-orphan', 'files-diff-unavailable', 'test-not-run', 'test-failed', 'test-stale', 'no-tests-ran', 'report-missing',
  'report-unreadable', 'exit-report-mismatch', 'registered-test-not-executed', 'coverage-below',
  'benchmark-regression', 'baseline-missing', 'flaky-over-limit', 'browser-project-missing', 'scenario-uncovered',
  'scenario-failing', 'service-not-ready', 'record-chain-broken', 'waiver-unapproved',
] as const
export type TestBlockerCode = (typeof TEST_BLOCKER_CODES)[number]

/** 不属于阻塞集的提示：已知失败已修好 / 已过期、基准噪声大、映射指向不存在的场景、未能检查 diff。 */
export const TEST_NOTICE_CODES = [
  'known-failure-fixed', 'known-failure-expired', 'benchmark-noisy', 'trace-mapping-stale', 'files-unchecked',
] as const
export type TestNoticeCode = (typeof TEST_NOTICE_CODES)[number]

export interface ShortLabel {
  readonly zh: string
  readonly en: string
}

export const TEST_BLOCKER_LABELS: Readonly<Record<TestBlockerCode, ShortLabel>> = {
  'test-catalog-missing': { zh: '目录缺失', en: 'No test catalog' },
  'test-plan-missing': { zh: '未登记计划', en: 'No test plan' },
  'test-plan-tampered': { zh: '计划被改动', en: 'Plan tampered' },
  'test-kind-missing': { zh: '缺测试种类', en: 'Kind missing' },
  'test-file-unregistered': { zh: '文件未登记', en: 'Unregistered file' },
  'test-file-orphan': { zh: '文件无套件', en: 'Orphan test file' },
  'files-diff-unavailable': { zh: '读不到改动', en: 'Diff unavailable' },
  'test-not-run': { zh: '未运行', en: 'Not run' },
  'test-failed': { zh: '失败', en: 'Failed' },
  'test-stale': { zh: '过期', en: 'Stale' },
  'no-tests-ran': { zh: '没有用例', en: 'No tests ran' },
  'report-missing': { zh: '缺报告', en: 'No report' },
  'report-unreadable': { zh: '报告无法解析', en: 'Unreadable report' },
  'exit-report-mismatch': { zh: '退出码与报告不符', en: 'Exit/report mismatch' },
  'registered-test-not-executed': { zh: '登记用例未执行', en: 'Registered test not run' },
  'coverage-below': { zh: '覆盖率不足', en: 'Coverage below' },
  'benchmark-regression': { zh: '基准退化', en: 'Benchmark regression' },
  'baseline-missing': { zh: '缺基线', en: 'No baseline' },
  'flaky-over-limit': { zh: '不稳定超限', en: 'Too flaky' },
  'browser-project-missing': { zh: '缺浏览器', en: 'Browser missing' },
  'scenario-uncovered': { zh: '场景/任务未覆盖', en: 'Scenario/task uncovered' },
  'scenario-failing': { zh: '场景/任务未通过', en: 'Scenario/task failing' },
  'service-not-ready': { zh: '服务未就绪', en: 'Service not ready' },
  'record-chain-broken': { zh: '记录被改动', en: 'Records tampered' },
  'waiver-unapproved': { zh: '豁免未批准', en: 'Waiver unapproved' },
}

export const TEST_NOTICE_LABELS: Readonly<Record<TestNoticeCode, ShortLabel>> = {
  'known-failure-fixed': { zh: '已修好', en: 'Fixed' },
  'known-failure-expired': { zh: '已知失败过期', en: 'Known failure expired' },
  'benchmark-noisy': { zh: '基准波动大', en: 'Noisy benchmark' },
  'trace-mapping-stale': { zh: '映射失效', en: 'Stale mapping' },
  'files-unchecked': { zh: '未检查文件', en: 'Files unchecked' },
}

export interface TestBlocker {
  readonly code: TestBlockerCode
  /** false = 只提示（如策略不要求基线时的 baseline-missing）。 */
  readonly blocking: boolean
  readonly message: string
  /** 可直接复制执行的修复命令。 */
  readonly fix?: string
  /** 涉及的对象：套件 id、种类、文件路径、场景 covers 等。 */
  readonly subject?: string
}

export interface TestNotice {
  readonly code: TestNoticeCode
  readonly message: string
  readonly fix?: string
  readonly subject?: string
}

export function testBlocker(
  code: TestBlockerCode,
  message: string,
  options: { readonly fix?: string; readonly subject?: string; readonly blocking?: boolean } = {},
): TestBlocker {
  return {
    code,
    blocking: options.blocking ?? true,
    message,
    ...(options.fix === undefined ? {} : { fix: options.fix }),
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  }
}

export function testNotice(
  code: TestNoticeCode,
  message: string,
  options: { readonly fix?: string; readonly subject?: string } = {},
): TestNotice {
  return {
    code,
    message,
    ...(options.fix === undefined ? {} : { fix: options.fix }),
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  }
}

/** 渲染成一行可读文案（与既有测试证据阻塞同一口径：说明；执行 命令）。 */
export function renderTestBlocker(blocker: Pick<TestBlocker, 'message' | 'fix'>): string {
  return blocker.fix === undefined ? blocker.message : `${blocker.message}；执行 ${blocker.fix}`
}

/** shell 单引号引用，拼进修复命令里的路径、原因与用例名不会被 shell 拆开。 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
