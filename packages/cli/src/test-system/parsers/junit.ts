/**
 * JUnit XML → 用例。各工具方言差别很大（vitest / Playwright 用 `classname`=文件、`name`=分组 › 用例；node:test 用
 * `file` 属性与嵌套 testsuite；pytest 用点号分隔的 `classname`），所以文件、分组与用例名按下面的次序推断：
 *   文件：testcase@file → 像路径的 classname → 祖先 testsuite@file → 像路径的 testsuite@name（仅当 testcase 没有 classname）→
 *   pytest 方言下点号 classname 推成 .py → 像类名的 classname（`com.example.MathTest`，Java / .NET 一类）→ 无文件（UNKNOWN_CASE_FILE）。
 *   node:test 在 Node 22 及以前不写 testcase@file，classname 恒为 `test`，testsuite 名是 describe 标题：这些都不是文件，
 *   所以这样的用例如实记为无文件，登记的用例引用改由 kernel 按名字唯一对（casesMatchingRef），而不是把 `test` 或 describe 标题当成文件。
 *   用例名：`name` 按 ` › ` 或 ` > ` 拆成 分组… › 用例；没有分隔符时，非文件名的祖先 testsuite 名当分组。
 * 状态：`<skipped>` 跳过；`<failure>` / `<error>` 失败；只有 flakyFailure / rerunFailure（重试后通过）判 flaky。
 */
import { basename } from 'node:path'
import { UNKNOWN_CASE_FILE, fileRefMatches, type CaseFailure } from '@tenon/kernel'
import { cleanName, failureFromText, repoPath } from './text.js'
import type { CaseReport, ParseContext, ParsedAttachment, ParsedCase } from './types.js'
import { childrenNamed, parseXml, XmlError, type XmlElement } from './xml.js'

const PATH_EXTENSION = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|m|mm|dart|ex|exs|feature)$/i
const FILE_LINE = /^(.*\.[A-Za-z0-9]+):(\d+)(?::\d+)?$/
const ATTACHMENT = /\[\[ATTACHMENT\|([^\]]+)\]\]/g

function looksLikePath(value: string): boolean {
  return value !== '' && !/\s/.test(value) && (value.includes('/') || PATH_EXTENSION.test(value))
}

function dottedModulePath(classname: string): { file: string; klass: string[] } | undefined {
  if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(classname)) return undefined
  const segments = classname.split('.')
  const klassAt = segments.findIndex((segment) => /^[A-Z]/.test(segment))
  const modules = klassAt < 0 ? segments : segments.slice(0, klassAt)
  if (modules.length === 0) return undefined
  return { file: `${modules.join('/')}.py`, klass: klassAt < 0 ? [] : segments.slice(klassAt) }
}

function seconds(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : 0
}

function failureOf(element: XmlElement): CaseFailure {
  const headline = element.attrs.message ?? element.attrs.type
  return failureFromText(element.text, headline)
}

function attachmentsOf(testcase: XmlElement): ParsedAttachment[] {
  const out: ParsedAttachment[] = []
  for (const stream of testcase.children.filter((child) => child.name === 'system-out' || child.name === 'system-err')) {
    for (const match of stream.text.matchAll(ATTACHMENT)) {
      const path = match[1]?.trim()
      if (path !== undefined && path !== '') out.push({ name: basename(path), path })
    }
  }
  return out
}

interface SplitName {
  readonly path: readonly string[]
  readonly name: string
  readonly project: string | null
  readonly line?: number
  readonly fileHint?: string
}

function splitName(raw: string): SplitName {
  const parts = raw.split(/ [›>] /).map((part) => part.trim()).filter((part) => part !== '')
  let project: string | null = null
  let line: number | undefined
  let fileHint: string | undefined
  const kept: string[] = []
  parts.forEach((part, index) => {
    const bracket = /^\[([^\]]+)\]$/.exec(part)
    if (index === 0 && bracket !== null && parts.length > 1) { project = bracket[1] ?? null; return }
    const located = FILE_LINE.exec(part)
    if (located !== null && index < parts.length - 1 && looksLikePath(located[1] ?? '')) {
      fileHint = located[1]
      line = Number(located[2])
      return
    }
    kept.push(part)
  })
  const name = kept.pop() ?? raw.trim()
  return { path: kept, name, project, ...(line === undefined ? {} : { line }), ...(fileHint === undefined ? {} : { fileHint }) }
}

interface Ancestors {
  readonly suites: readonly XmlElement[]
}

/** 像类名的 classname：点号 / `::` / `$` 限定的标识符，最后一段首字母大写（`com.example.MathTest`、`MathTest`）；`test`、分组标题不是。 */
function looksLikeClassName(value: string): boolean {
  return /^(?:[A-Za-z_][\w$]*(?:\.|::|\$|\+))*[A-Z][\w$]*$/.test(value)
}

function fileOf(testcase: XmlElement, ancestors: Ancestors, split: SplitName): { file: string; klass: string[] } {
  const declared = testcase.attrs.file
  if (declared !== undefined && declared !== '') return { file: declared, klass: [] }
  const classname = testcase.attrs.classname ?? ''
  if (looksLikePath(classname)) return { file: classname, klass: [] }
  if (split.fileHint !== undefined) return { file: split.fileHint, klass: [] }
  for (const suite of [...ancestors.suites].reverse()) {
    const file = suite.attrs.file
    if (file !== undefined && file !== '') return { file, klass: [] }
  }
  // testsuite 名当文件只对「file 每个 suite」的方言（testcase 没有 classname）成立；有 classname 却不是路径（node:test 的 `test`）
  // 说明 testsuite 名是 describe 标题，`describe('utils.js')` 不是文件。
  if (classname === '') {
    for (const suite of [...ancestors.suites].reverse()) {
      const name = suite.attrs.name ?? ''
      if (looksLikePath(name)) return { file: name, klass: [] }
    }
  }
  // 点号 classname 推成 .py 文件只对 pytest 方言成立（Java 的 com.example.MathTest 不是 Python 模块）。
  const pytest = ancestors.suites.some((suite) => suite.attrs.name === 'pytest')
  const dotted = pytest ? dottedModulePath(classname) : undefined
  if (dotted !== undefined) return dotted
  const identity = classname !== '' ? classname : (ancestors.suites.at(-1)?.attrs.name ?? '')
  return { file: looksLikeClassName(identity) ? identity : UNKNOWN_CASE_FILE, klass: [] }
}

/** 这个 testsuite 名是不是「文件外壳」（vitest / Playwright 每个文件一个 testsuite，名字就是该文件）：与用例文件同名或互为路径尾部。 */
function isFileSuiteName(name: string, file: string): boolean {
  if (name === file) return true
  return file !== UNKNOWN_CASE_FILE && looksLikePath(name) && (fileRefMatches(name, file) || fileRefMatches(file, name))
}

function groupsFromSuites(ancestors: Ancestors, file: string): string[] {
  return ancestors.suites
    .map((suite) => suite.attrs.name ?? '')
    .filter((name) => name !== '' && !isFileSuiteName(name, file) && !/^(?:vitest|jest|mocha|pytest) tests$/i.test(name) && name !== 'pytest')
}

function isFileWrapper(name: string, file: string): boolean {
  return PATH_EXTENSION.test(name) && !/\s/.test(name) && basename(file) === name
}

function toCase(testcase: XmlElement, ancestors: Ancestors, ctx: ParseContext): ParsedCase | undefined {
  const rawName = testcase.attrs.name ?? ''
  const split = splitName(rawName)
  const located = fileOf(testcase, ancestors, split)
  if (isFileWrapper(split.name, located.file)) return undefined
  const skipped = childrenNamed(testcase, 'skipped').length > 0
  const failed = [...childrenNamed(testcase, 'failure'), ...childrenNamed(testcase, 'error')]
  const reruns = testcase.children.filter((child) => /^(?:flaky|rerun)(?:Failure|Error)$/.test(child.name))
  const status: ParsedCase['status'] = skipped ? 'skip' : failed.length > 0 ? 'fail' : reruns.length > 0 ? 'flaky' : 'pass'
  const failureSource = failed[0] ?? (status === 'flaky' ? reruns[0] : undefined)
  const groups = split.path.length > 0 ? split.path : groupsFromSuites(ancestors, located.file)
  const lineText = testcase.attrs.line
  const line = split.line ?? (lineText !== undefined && /^\d+$/.test(lineText) ? Number(lineText) : undefined)
  return {
    file: located.file === UNKNOWN_CASE_FILE ? UNKNOWN_CASE_FILE : repoPath(ctx, located.file),
    ...(line === undefined ? {} : { line }),
    name: cleanName(split.name, '(未命名用例)'),
    suite_path: [...located.klass, ...groups].map((group) => cleanName(group, '(分组)')),
    project: split.project,
    status,
    duration_ms: seconds(testcase.attrs.time),
    attempts: 1 + reruns.length,
    ...(failureSource !== undefined && status !== 'skip' ? { failure: failureOf(failureSource) } : {}),
    attachments: attachmentsOf(testcase),
  }
}

/** testsuite 自己出错（进程崩溃、hook 失败）时它所属的文件：file 属性，或像路径的名字；describe 标题不是文件。 */
function suiteFile(suite: XmlElement): string {
  const declared = suite.attrs.file
  if (declared !== undefined && declared !== '') return declared
  const name = suite.attrs.name ?? ''
  return looksLikePath(name) ? name : UNKNOWN_CASE_FILE
}

/** 遍历带祖先链的 testcase，并为 testsuite 直接挂的 error / failure 生成一条失败用例。 */
function walk(root: XmlElement, ctx: ParseContext): ParsedCase[] {
  const cases: ParsedCase[] = []
  const visit = (element: XmlElement, suites: readonly XmlElement[]): void => {
    for (const child of element.children) {
      if (child.name === 'testcase') {
        const parsed = toCase(child, { suites }, ctx)
        if (parsed !== undefined) cases.push(parsed)
      } else if (child.name === 'testsuite') {
        const chain = [...suites, child]
        const own = [...childrenNamed(child, 'error'), ...childrenNamed(child, 'failure')]
        if (own.length > 0 && own[0] !== undefined) {
          const file = suiteFile(child)
          cases.push({
            file: file === UNKNOWN_CASE_FILE ? UNKNOWN_CASE_FILE : repoPath(ctx, file),
            name: cleanName(child.attrs.name ?? '', '(测试套件无法运行)'),
            suite_path: [],
            project: null,
            status: 'fail',
            duration_ms: seconds(child.attrs.time),
            attempts: 1,
            failure: failureOf(own[0]),
            attachments: [],
          })
        }
        visit(child, chain)
      }
    }
  }
  visit(root, [])
  return cases
}

export function parseJunit(text: string, ctx: ParseContext): CaseReport {
  let root: XmlElement
  try {
    root = parseXml(text)
  } catch (error) {
    return { ok: false, reason: `不是合法的 JUnit XML：${error instanceof XmlError ? error.message : '解析失败'}` }
  }
  if (root.name !== 'testsuites' && root.name !== 'testsuite') {
    return { ok: false, reason: `根元素是 <${root.name}>，不是 JUnit 的 testsuites / testsuite` }
  }
  const container: XmlElement = root.name === 'testsuite' ? { name: 'testsuites', attrs: {}, children: [root], text: '' } : root
  const cases = walk(container, ctx)
  const projects = [...new Set(cases.flatMap((item) => (item.project === null ? [] : [item.project])))]
  return { ok: true, cases, projects }
}
