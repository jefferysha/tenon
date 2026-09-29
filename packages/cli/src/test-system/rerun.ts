/**
 * 失败用例重跑结果并回首轮：重跑里同一用例（文件 + 分组 + 名字 + project）通过 → flaky（先失败后通过），
 * 仍失败 → 保持失败并累加尝试次数；重跑没跑到的用例保持原样。只动首轮失败过的用例。
 */
import { fileRefMatches } from '@tenon/kernel'
import type { ParsedCase } from './parsers/index.js'

function sameCase(left: ParsedCase, right: ParsedCase): boolean {
  return left.name === right.name && left.project === right.project
    && left.suite_path.join('\u0000') === right.suite_path.join('\u0000')
    && (fileRefMatches(left.file, right.file) || fileRefMatches(right.file, left.file))
}

export function mergeRerun(cases: readonly ParsedCase[], failed: readonly ParsedCase[], again: readonly ParsedCase[]): readonly ParsedCase[] {
  return cases.map((item) => {
    if (!failed.includes(item)) return item
    const match = again.find((candidate) => sameCase(candidate, item))
    if (match === undefined || match.status === 'skip') return item
    if (match.status === 'pass' || match.status === 'flaky') {
      return { ...match, status: 'flaky', attempts: item.attempts + match.attempts, ...(item.failure === undefined ? {} : { failure: item.failure }) }
    }
    return { ...match, attempts: item.attempts + match.attempts }
  })
}
