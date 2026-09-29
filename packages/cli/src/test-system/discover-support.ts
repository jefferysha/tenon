/** 目录扫描的共用类型与小工具：建议套件的形状、带默认值的套件构造、文件读取。 */
import { lstat, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  CATALOG_DEFAULT_TIMEOUT_S, defaultReportFormat, isRepoRelativePath,
  type CatalogReport, type CatalogSelect, type CatalogSuite, type ReportFormat, type TestKind, type TestRunner,
} from '@tenon/kernel'

const MAX_TEXT = 256 * 1024

export interface DiscoveredSuite {
  readonly suite: CatalogSuite
  /** 建议依据（人读）：来自哪个文件 / 脚本。 */
  readonly source: string
}

export interface ProjectDir {
  /** 仓库相对路径，根目录为 '.'。 */
  readonly rel: string
  readonly abs: string
  readonly names: ReadonlySet<string>
}

export async function readSmallText(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > MAX_TEXT) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 目录相对路径 → 套件 id 前缀（根目录为空）。 */
export function idPrefix(rel: string): string {
  if (rel === '.') return ''
  const slug = basename(rel).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? '' : `${slug}-`
}

export function makeSuite(input: {
  readonly id: string
  readonly label: string
  readonly kind: TestKind
  readonly runner: TestRunner
  readonly command: string
  readonly cwd: string
  readonly files?: readonly string[]
  readonly covers?: readonly string[]
  readonly select?: CatalogSelect
  readonly report?: CatalogReport
  readonly coverage?: CatalogSuite['coverage']
  readonly artifacts?: readonly string[]
  readonly timeout_s?: number
  readonly browsers?: readonly string[]
  readonly tags?: readonly string[]
  readonly benchmark?: CatalogSuite['benchmark']
}): CatalogSuite {
  const format: ReportFormat = input.report?.format ?? defaultReportFormat(input.runner)
  return {
    id: input.id.slice(0, 48),
    label: input.label,
    kind: input.kind,
    runner: input.runner,
    command: input.command,
    cwd: isRepoRelativePath(input.cwd) ? input.cwd : '.',
    timeout_s: input.timeout_s ?? CATALOG_DEFAULT_TIMEOUT_S,
    files: input.files ?? [],
    covers: input.covers ?? [],
    ...(input.select === undefined ? {} : { select: input.select }),
    report: input.report ?? { format },
    ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
    artifacts: input.artifacts ?? [],
    env: [],
    services: [],
    retries: 0,
    parallel: false,
    tags: input.tags ?? [],
    browsers: input.browsers ?? [],
    ...(input.benchmark === undefined ? {} : { benchmark: input.benchmark }),
  }
}

