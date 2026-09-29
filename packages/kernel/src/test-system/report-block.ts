/**
 * 验证报告里的测试追溯块：`tenon test report --write` 只改两个标记之间的部分（没有就在末尾追加一个块），
 * 其余字节原样。`tenon status` 的 `test-report` 动作靠同一对标记判断报告是否已带上最新运行——块存在、
 * 且引用了每个套件最新运行的 run id——所以写入方与判定方共用这一个文件里的函数，不各写一份。
 */
export const TEST_REPORT_BEGIN = '<!-- tenon:test-report:begin -->'
export const TEST_REPORT_END = '<!-- tenon:test-report:end -->'

function blockRange(text: string): { readonly start: number; readonly end: number } | undefined {
  const start = text.indexOf(TEST_REPORT_BEGIN)
  if (start < 0) return undefined
  const end = text.indexOf(TEST_REPORT_END, start + TEST_REPORT_BEGIN.length)
  return end < 0 ? undefined : { start, end }
}

/** 两个标记之间的内容；没有块（或标记不成对）时 undefined。 */
export function testReportBlock(text: string): string | undefined {
  const range = blockRange(text)
  return range === undefined ? undefined : text.slice(range.start + TEST_REPORT_BEGIN.length, range.end)
}

/** 用 `body` 替换报告里的块；没有块就在末尾追加一个。块之外的内容一个字节都不动。 */
export function replaceTestReportBlock(text: string, body: string): string {
  const block = `${TEST_REPORT_BEGIN}\n${body.trim()}\n${TEST_REPORT_END}`
  const range = blockRange(text)
  if (range !== undefined) return `${text.slice(0, range.start)}${block}${text.slice(range.end + TEST_REPORT_END.length)}`
  return `${text.trimEnd()}\n\n${block}\n`
}

/** 报告的追溯块是否引用了这些运行（每个 run id 都出现在块里）。 */
export function reportCarriesRuns(text: string, runIds: readonly string[]): boolean {
  const block = testReportBlock(text)
  return block !== undefined && runIds.every((id) => block.includes(id))
}
