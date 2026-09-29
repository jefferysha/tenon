/**
 * 运行范围 → 要执行的命令。套件的 `select` 模板里 `{files}` 换成 shell 引用后的文件列表（相对套件 cwd），`{pattern}` 换成
 * shell 引用后的用例名正则。套件没有对应模板时退回全量运行——退回是如实记录的（返回的 scope 是实际范围），
 * 不会把「其实跑了全量」标成 changed。
 */
import { relative } from 'node:path'
import {
  matchesAnyGlob, shellQuote, suiteCoverGlobs, suiteFileGlobs,
  type CatalogSuite, type PlanScope, type RunScope,
} from '@tenon/kernel'

export interface ScopeRequest {
  readonly scope: PlanScope
  readonly pattern?: string
  readonly files?: readonly string[]
}

export interface PlannedCommand {
  readonly command: string
  /** 实际范围：请求的范围在套件上做不到时退回 full。 */
  readonly scope: RunScope
  readonly selection: readonly string[]
  readonly note?: string
}

function quoteFiles(suite: CatalogSuite, files: readonly string[]): string {
  return files.map((file) => shellQuote(suite.cwd === '.' ? file : relative(suite.cwd, file))).join(' ')
}

/** 正则元字符转义，用例名整体当字面量匹配。 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在套件命令上补 Playwright 原生重试（`--retries`）；命令里已经写了就不动。 */
export function withNativeRetries(suite: CatalogSuite, command: string): string {
  if (suite.runner !== 'playwright' || suite.retries === 0) return command
  if (!/\bplaywright test\b/.test(command) || /--retries\b/.test(command)) return command
  return command.replace(/(\bplaywright test\b)/, `$1 --retries=${suite.retries}`)
}

function full(suite: CatalogSuite, note?: string): PlannedCommand {
  return { command: withNativeRetries(suite, suite.command), scope: 'full', selection: [], ...(note === undefined ? {} : { note }) }
}

function byFiles(suite: CatalogSuite, files: readonly string[], scope: RunScope): PlannedCommand {
  const template = suite.select?.files
  if (template === undefined) return full(suite, `套件 ${suite.id} 没有 select.files 模板，按全量运行`)
  return {
    command: withNativeRetries(suite, template.replace('{files}', quoteFiles(suite, files))),
    scope, selection: files,
  }
}

/**
 * changed 范围：改动文件里只有本套件拥有的测试文件、且没有碰到 covers 里的源码时，只跑这些测试文件；
 * 改到了源码（无法从源码推出受影响的测试）或没有可选的文件，按全量运行。
 */
export function planCommand(suite: CatalogSuite, request: ScopeRequest, changedFiles: readonly string[] | undefined): PlannedCommand {
  if (request.scope === 'full') return full(suite)
  if (request.scope === 'grep') {
    const template = suite.select?.grep
    if (template === undefined || request.pattern === undefined) return full(suite, `套件 ${suite.id} 没有 select.grep 模板，按全量运行`)
    return {
      command: withNativeRetries(suite, template.replace('{pattern}', shellQuote(request.pattern))),
      scope: 'grep', selection: [request.pattern],
    }
  }
  if (request.scope === 'files') return byFiles(suite, request.files ?? [], 'files')
  if (changedFiles === undefined) return full(suite, '读不到改动文件列表，changed 范围按全量运行')
  const owned = changedFiles.filter((path) => matchesAnyGlob(path, suiteFileGlobs(suite)))
  const sourceTouched = changedFiles.some((path) => !matchesAnyGlob(path, suiteFileGlobs(suite)) && matchesAnyGlob(path, suiteCoverGlobs(suite)))
  if (owned.length === 0 || sourceTouched) return full(suite, sourceTouched ? '改到了源码，无法推出受影响的测试，按全量运行' : '没有改动到本套件的测试文件，按全量运行')
  return byFiles(suite, owned, 'changed')
}

/** 重跑失败用例：优先按用例名（select.grep），其次按文件（select.files）；都没有就不能重跑。 */
export function planRerun(suite: CatalogSuite, failed: ReadonlyArray<{ readonly file: string; readonly name: string }>): PlannedCommand | undefined {
  if (suite.select?.grep !== undefined) {
    const pattern = failed.map((item) => escapeRegex(item.name)).join('|')
    return { command: suite.select.grep.replace('{pattern}', shellQuote(pattern)), scope: 'grep', selection: [pattern] }
  }
  if (suite.select?.files !== undefined) {
    const files = [...new Set(failed.map((item) => item.file))]
    return { command: suite.select.files.replace('{files}', quoteFiles(suite, files)), scope: 'files', selection: files }
  }
  return undefined
}

