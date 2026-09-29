/**
 * 报告与覆盖率解析器的共同形状。解析器都是纯函数：输入报告文本，输出用例 / 指标 / 覆盖率或一句
 * 失败原因；读文件、判 0 用例、与退出码对账、已登记用例核对都在运行编排里，不在这里。
 *
 * 路径约定：`ParsedCase.file` 尽量给出仓库相对、正斜杠的路径（报告里是绝对路径就用 ctx.repoRoot 换算，
 * 是相对某个 testDir 的路径就按该目录解析）；判定按「文件尾部匹配」对账。时长一律毫秒。
 */
import type { CaseFailure, CoverageResult } from '@tenon/kernel'

export interface ParseContext {
  /** 仓库根（绝对路径），用来把报告里的绝对路径换算成仓库相对路径。 */
  readonly repoRoot: string
  /** 套件工作目录（绝对路径）；报告里相对路径的基准。 */
  readonly cwd: string
}

export interface ParsedAttachment {
  readonly name: string
  readonly contentType?: string
  /** 报告里写的路径：绝对路径，或相对套件 cwd。 */
  readonly path: string
}

export interface ParsedCase {
  readonly file: string
  readonly line?: number
  readonly name: string
  /** 从外到内的分组标题（describe …），不含用例名本身。 */
  readonly suite_path: readonly string[]
  /** Playwright project（浏览器）；没有 project 概念的格式为 null。 */
  readonly project: string | null
  readonly status: 'pass' | 'fail' | 'skip' | 'flaky'
  readonly duration_ms: number
  /** 报告里可见的执行次数；不含重试信息的格式恒为 1。flaky = 先失败后通过。 */
  readonly attempts: number
  readonly failure?: CaseFailure
  readonly attachments: readonly ParsedAttachment[]
}

export type CaseReportFormat = 'junit' | 'playwright-json' | 'vitest-json' | 'jest-json' | 'go-json' | 'tap'

export type CaseReport =
  | { readonly ok: true; readonly cases: readonly ParsedCase[]; readonly projects: readonly string[] }
  | { readonly ok: false; readonly reason: string }

export type BenchmarkReportFormat = 'benchmark-json' | 'k6-summary' | 'lighthouse-json'

/** 每个指标的样本（多次采样时多个值，单值时一个）。 */
export type BenchmarkReport =
  | { readonly ok: true; readonly metrics: Readonly<Record<string, readonly number[]>> }
  | { readonly ok: false; readonly reason: string }

export interface CoverageContext extends ParseContext {
  /** 仓库相对路径 → 本任务在该文件里新增 / 修改的行号；给出时才计算 changed_lines。 */
  readonly changedLines?: ReadonlyMap<string, ReadonlySet<number>>
  /** istanbul-summary 旁边的 coverage-final.json 文本（有则用它按行计算 changed_lines）。 */
  readonly detailText?: string
}

export type CoverageReport =
  | { readonly ok: true; readonly coverage: CoverageResult }
  | { readonly ok: false; readonly reason: string }
