/**
 * node:test 的 JUnit reporter（随 CLI bundle 分发的源码）。
 *
 * 为什么要自带：Node 22 及以前内置的 `--test-reporter=junit` 不给 `<testcase>` 写 `file` 属性（较新的 Node 才写），
 * 报告里的用例没有文件归属，追溯表、已登记用例的核对、运行详情里的位置都对不上。这个 reporter 在 Node 20 / 22 / 24
 * 上都写 `file`（取自 test:pass / test:fail 事件的 `data.file`），其余沿用内置 reporter 的方言：`classname="test"`（嵌套时是点号
 * 连接的 describe 路径）、嵌套的 `<testsuite>`、`<failure type message>` 里放 util.inspect 的错误全文、`<skipped>`。
 *
 * 怎么被引用而不往用户项目里写文件：`tenon test run` 在本次运行的产物目录下落一份（writeNodeTestReporter），
 * 把它的 file URL 放进环境变量 TENON_NODE_TEST_REPORTER，套件命令写 `--test-reporter="${TENON_NODE_TEST_REPORTER:-junit}"`：
 * 由 tenon 运行时用带 file 的这份；手工在 tenon 之外跑同一条命令时环境变量为空，退回内置 junit。
 *
 * 下面的源码是另一个进程里跑的独立 ESM 模块，只用 node: 内置模块，不能引用本文件里的任何东西。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NODE_TEST_REPORTER_ENV } from '@tenon/kernel'

export { NODE_TEST_REPORTER_ENV }
export const NODE_TEST_REPORTER_FILE = 'node-test-junit.mjs'

/** String.raw：这是另一个文件的源码，反斜杠与美元符号原样写进去；源码里只有 ASCII，不出现反引号、模板插值与 unicode 转义。 */
export const NODE_TEST_JUNIT_REPORTER_SOURCE = String.raw`import { inspect } from 'node:util'

const MAX_TEXT = 60000

// XML 1.0 allows only tab, newline, carriage return and code points >= 0x20 that are neither surrogates nor the
// noncharacters 0xFFFE / 0xFFFF; anything else would make the report unparseable, so it is dropped.
// Compared by code point, with no unicode escapes and no non-ASCII text in this source: escapes get rewritten into
// literal characters by editors and bundlers, which would silently change what this file contains.
function legal(value) {
  let out = ''
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 0xD800) || (code > 0xDFFF && code < 0xFFFE) || code > 0xFFFF) out += char
  }
  return out
}

const text = (value) => legal(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attr = (value) => text(value).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')
const clip = (value) => (value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '...' : value)
const seconds = (ms) => (Number(ms) / 1000).toFixed(6)

function describeError(error) {
  const cause = error && error.cause ? error.cause : error
  const message = String((cause && cause.message) || (error && error.message) || 'test failed')
  let body
  try {
    body = inspect(error, { colors: false, breakLength: Infinity })
  } catch {
    body = message
  }
  return { type: (error && error.failureType) || 'testCodeFailure', message: clip(message), body: clip(body) }
}

function failureXml(error, pad) {
  const info = describeError(error)
  return pad + '<failure type="' + attr(info.type) + '" message="' + attr(info.message) + '">\n' + text(info.body) + '\n' + pad + '</failure>\n'
}

function leaves(node) {
  return node.children.length === 0 ? [node] : node.children.flatMap(leaves)
}

function renderCase(node, names, pad) {
  const classname = names.length > 0 ? names.join('.') : 'test'
  const attrs = 'name="' + attr(node.name) + '" time="' + seconds(node.ms) + '" classname="' + attr(classname) + '"'
    + (node.file ? ' file="' + attr(node.file) + '"' : '')
  if (!node.failed && !node.skipped) return pad + '<testcase ' + attrs + '/>\n'
  const inner = node.failed ? failureXml(node.error, pad + '\t') : pad + '\t<skipped type="skipped" message="' + attr(node.skipped) + '"/>\n'
  return pad + '<testcase ' + attrs + '>\n' + inner + pad + '</testcase>\n'
}

function renderNode(node, names, depth) {
  const pad = '\t'.repeat(depth + 1)
  if (node.children.length === 0) return node.suite ? '' : renderCase(node, names, pad)
  const all = leaves(node).filter((leaf) => !leaf.suite)
  const failures = all.filter((leaf) => leaf.failed).length
  const skipped = all.filter((leaf) => !leaf.failed && leaf.skipped).length
  const own = node.failed && !(node.error && node.error.failureType === 'subtestsFailed') ? failureXml(node.error, pad + '\t') : ''
  const inside = names.concat([node.name])
  const body = node.children.map((child) => renderNode(child, inside, depth + 1)).join('')
  return pad + '<testsuite name="' + attr(node.name) + '"' + (node.file ? ' file="' + attr(node.file) + '"' : '')
    + ' time="' + seconds(node.ms) + '" disabled="0" errors="0" tests="' + all.length + '" failures="' + failures + '" skipped="' + skipped + '">\n'
    + own + body + pad + '</testsuite>\n'
}

export default async function* nodeTestJunit(source) {
  const roots = []
  const pending = []
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const data = event.data
    const details = data.details || {}
    const node = {
      name: data.name,
      file: data.file,
      nesting: data.nesting,
      ms: details.duration_ms || 0,
      failed: event.type === 'test:fail',
      error: details.error,
      suite: details.type === 'suite',
      skipped: data.skip !== undefined && data.skip !== false ? String(data.skip) : data.todo !== undefined && data.todo !== false ? String(data.todo) : '',
      children: [],
    }
    for (let index = 0; index < pending.length;) {
      const child = pending[index]
      if (child.nesting === node.nesting + 1 && child.file === node.file) {
        node.children.push(child)
        pending.splice(index, 1)
      } else {
        index++
      }
    }
    if (node.nesting === 0) roots.push(node)
    else pending.push(node)
  }
  roots.push(...pending)
  yield '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n' + roots.map((root) => renderNode(root, [], 0)).join('') + '</testsuites>\n'
}
`

/** 引用 reporter 的套件命令是否读了环境变量（不读就不必落文件）。 */
export function usesNodeTestReporter(commands: readonly (string | undefined)[]): boolean {
  return commands.some((command) => command?.includes(NODE_TEST_REPORTER_ENV) === true)
}

/**
 * 把 reporter 落在 dir 下（调用方给的是本次运行自己的产物目录，不是用户项目里的受版本管理路径），返回它的 file URL。
 * file URL 而不是路径：Node 的 `--test-reporter` 按 ESM 说明符解析，Windows 盘符路径不合法，file URL 在各平台都合法。
 */
export async function writeNodeTestReporter(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, NODE_TEST_REPORTER_FILE)
  await writeFile(path, NODE_TEST_JUNIT_REPORTER_SOURCE, { mode: 0o600 })
  return pathToFileURL(path).href
}
