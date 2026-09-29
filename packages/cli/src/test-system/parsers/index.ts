export { parseBenchmarkReport, metricName } from './benchmark.js'
export { parseCoverageReport } from './coverage.js'
export { parseGoJson } from './gojson.js'
export { parseJestJson } from './jest.js'
export { parseJunit } from './junit.js'
export { parsePlaywrightJson } from './playwright.js'
export { parseTap } from './tap.js'
export type {
  BenchmarkReport, BenchmarkReportFormat, CaseReport, CaseReportFormat, CoverageContext, CoverageReport, ParseContext,
  ParsedAttachment, ParsedCase,
} from './types.js'

import { parseGoJson } from './gojson.js'
import { parseJestJson } from './jest.js'
import { parseJunit } from './junit.js'
import { parsePlaywrightJson } from './playwright.js'
import { parseTap } from './tap.js'
import type { CaseReport, CaseReportFormat, ParseContext } from './types.js'

/** 按报告格式分派；vitest-json 与 jest-json 共用同一个解析器（形状相同）。 */
export function parseCaseReport(format: CaseReportFormat, text: string, ctx: ParseContext): CaseReport {
  switch (format) {
    case 'junit': return parseJunit(text, ctx)
    case 'playwright-json': return parsePlaywrightJson(text, ctx)
    case 'vitest-json':
    case 'jest-json': return parseJestJson(text, ctx)
    case 'go-json': return parseGoJson(text, ctx)
    case 'tap': return parseTap(text, ctx)
  }
}
