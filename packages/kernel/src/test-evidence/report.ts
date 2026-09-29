/**
 * 验证报告的测试段由登记结果生成（R12），写在一对标记之间，重复写入等于替换。
 * 没有门禁比较这段文字与记录：同一批事实不设第二道证据闸（D10），摘要注释只为事后审计。
 */
import { sha256Hex } from '../sha256.js'
import { userSlug } from '../users/user.js'
import type { TestEvidenceItem, TestItemStatus } from './evaluate.js'

export const TESTS_REGION_START = '<!-- tenon:tests:start'
export const TESTS_REGION_END = '<!-- tenon:tests:end -->'

export type ReportLocale = 'zh-CN' | 'en'

export interface TestsRegionItem extends TestEvidenceItem {
  readonly stepId: string
  readonly stepLabel: string
}

const HEADERS: Readonly<Record<ReportLocale, readonly string[]>> = {
  'zh-CN': ['阶段', '测试', '方向', '状态', '退出码', '耗时', '执行人', '时间', '候选'],
  en: ['Step', 'Test', 'Direction', 'Status', 'Exit', 'Duration', 'Actor', 'Time', 'Candidate'],
}

const STATUS_WORDS: Readonly<Record<ReportLocale, Readonly<Record<TestItemStatus, string>>>> = {
  'zh-CN': { passed: '通过', failed: '失败', stale: '过期', missing: '未运行', running: '运行中' },
  en: { passed: 'pass', failed: 'fail', stale: 'stale', missing: 'not run', running: 'running' },
}

const SECTIONS: Readonly<Record<ReportLocale, { readonly failures: string; readonly commands: string; readonly title: string }>> = {
  'zh-CN': { failures: '### 失败', commands: '### 命令', title: '## 测试' },
  en: { failures: '### Failures', commands: '### Commands', title: '## Tests' },
}

function shortCandidate(candidate: string | null): string {
  if (candidate === null) return '—'
  return `\`${candidate.slice(0, 'workspace:sha256:'.length + 4)}…\``
}

function duration(item: TestsRegionItem): string {
  const ms = item.run?.duration_ms
  return ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`
}

function recordPath(item: TestsRegionItem, changeName: string): string {
  const run = item.run
  if (run === undefined) return '—'
  return `\`.tenon/users/${userSlug(run.actor.id)}/tests/${changeName}/${run.run_id}.json\``
}

function row(item: TestsRegionItem, locale: ReportLocale): string {
  const run = item.run
  const cells = [
    item.stepLabel === '' ? item.stepId : item.stepLabel,
    `${item.test.label ?? item.test.id} \`${item.test.id}\``,
    item.test.direction,
    STATUS_WORDS[locale][item.status],
    run?.exit_code === undefined || run.exit_code === null ? (run?.signal ?? '—') : String(run.exit_code),
    duration(item),
    run?.actor.name ?? '—',
    run?.finished_at ?? '—',
    shortCandidate(run?.candidate ?? null),
  ]
  return `| ${cells.join(' | ')} |`
}

export function renderTestsRegion(input: {
  readonly changeName: string
  readonly locale: ReportLocale
  readonly items: readonly TestsRegionItem[]
}): string {
  const { locale } = input
  const headers = HEADERS[locale]
  const body: string[] = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...input.items.map((item) => row(item, locale)),
  ]
  const failures = input.items.filter((item) => item.status !== 'passed')
  if (failures.length > 0) {
    body.push(SECTIONS[locale].failures)
    for (const item of failures) {
      const codes = (item.run?.reasons ?? []).map((reason) => reason.code)
      const detail = codes.length === 0 ? STATUS_WORDS[locale][item.status] : codes.join(', ')
      body.push(`- \`${item.test.id}\`：${detail} — ${recordPath(item, input.changeName)}`)
    }
  }
  if (input.items.length > 0) {
    body.push(SECTIONS[locale].commands)
    for (const item of input.items) {
      body.push(`- \`${item.test.id}\`：\`${item.test.command}\`（cwd \`${item.test.cwd}\`）`)
    }
  }
  const text = body.join('\n')
  return `${TESTS_REGION_START} digest=sha256:${sha256Hex(text)} -->\n${text}\n${TESTS_REGION_END}`
}

/** 有标记就替换，没有就在文末追加一节；重复调用与调用一次结果相同。 */
export function replaceTestsRegion(markdown: string, region: string, locale: ReportLocale): string {
  const start = markdown.indexOf(TESTS_REGION_START)
  const end = markdown.indexOf(TESTS_REGION_END)
  if (start >= 0 && end > start) {
    return `${markdown.slice(0, start)}${region}${markdown.slice(end + TESTS_REGION_END.length)}`
  }
  const base = markdown.endsWith('\n') ? markdown : `${markdown}\n`
  return `${base}\n${SECTIONS[locale].title}\n\n${region}\n`
}
