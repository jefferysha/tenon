/**
 * `tenon support bundle [--out <path>] [--json]` —— 本机生成一个脱敏的诊断包，不联网、不上传。
 *
 * 内容：版本与运行环境、doctor、managed runtime 状态、配置摘要（只有名称与计数，没有值）、
 * 最近的 Dashboard server 日志（含两份轮转）、hook 耗时（有记录才有）。凭证、cookie、会话码、
 * home 路径、邮箱、用户名在进包前统一抹掉（support/bundle.ts + kernel redactForSharing），
 * 总大小不超过 5 MiB，包文件权限 0600。生成后逐项告诉用户包里有什么、抹了什么。
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform, release, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isTenonUser, readProjectRegistry, readSecrets, totalRedactions, type RedactionKind, type ProductPaths } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { buildSupportBundle, type BundleEntryReport, type BundleSource, type BuiltBundle } from '../support/bundle.js'
import { cmdDoctor } from './doctor.js'
import { cmdRuntime } from './runtime.js'

export interface SupportOpts {
  readonly out?: string
  readonly json?: boolean
}

export interface CapturedCommand {
  readonly exit: number
  readonly out: string
  readonly err: string
}

export interface SupportRuntime {
  doctor(deps: CliDeps): Promise<CapturedCommand>
  runtimeStatus(deps: CliDeps): Promise<CapturedCommand>
  homeDirs(): readonly string[]
  userNames(): readonly string[]
  env(): Readonly<Record<string, string | undefined>>
  host(): { readonly node: string; readonly platform: string; readonly arch: string; readonly release: string }
  readonly maxBytes?: number
}

const NOT_INCLUDED = [
  'project source and any repository file',
  'conversations, prompts and model responses',
  'tap traffic captures and CA material',
  'secret values (only the names of configured keys)',
] as const

const PLAIN_ENV = new Set(['TENON_LANG', 'TENON_DASHBOARD_PORT', 'TENON_CADENCE_POLL_MS', 'TENON_AFK', 'TENON_TEST_TRUST', 'TENON_HOSTS'])
const SECTION_CAP_BYTES = 256 * 1024
const LOG_CAP_BYTES = 1_572_864
const DASHBOARD_LOG_FILES = ['dashboard.log', 'dashboard.log.1', 'dashboard.log.2'] as const

async function capture(deps: CliDeps, run: (inner: CliDeps) => Promise<number>): Promise<CapturedCommand> {
  const out: string[] = []
  const err: string[] = []
  const inner: CliDeps = { ...deps, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
  try {
    const exit = await run(inner)
    return { exit, out: out.join('\n'), err: err.join('\n') }
  } catch (error) {
    return { exit: 1, out: out.join('\n'), err: [...err, errMsg(error)].join('\n') }
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

export function productionSupportRuntime(): SupportRuntime {
  return {
    doctor: (deps) => capture(deps, (inner) => cmdDoctor(inner, { json: true })),
    runtimeStatus: (deps) => capture(deps, (inner) => cmdRuntime(inner, 'status', { json: true })),
    homeDirs: () => {
      const homes = [homedir(), process.env.HOME, process.env.USERPROFILE].filter((value): value is string => value !== undefined && value !== '')
      return [...new Set([...homes, ...homes.map(safeRealpath).filter((value): value is string => value !== undefined)])]
    },
    userNames: () => {
      const names: string[] = []
      try { names.push(userInfo().username) } catch { /* 没有 passwd 项 */ }
      for (const name of [process.env.USER, process.env.USERNAME, process.env.LOGNAME, process.env.TENON_USER_NAME]) {
        if (name !== undefined && name !== '') names.push(name)
      }
      return names
    },
    env: () => ({ ...process.env }),
    host: () => ({ node: process.version, platform: platform(), arch: arch(), release: release() }),
  }
}

function pretty(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    return `${JSON.stringify(parsed, null, 2)}\n`
  } catch {
    return text.endsWith('\n') ? text : `${text}\n`
  }
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function commandSource(name: string, result: CapturedCommand): BundleSource {
  if (result.out.trim() === '') {
    return { kind: 'unavailable', name, reason: result.err.trim() === '' ? `no output (exit ${result.exit})` : result.err.trim().split('\n')[0] ?? '' }
  }
  return { kind: 'text', name, text: pretty(result.out), keep: 'head', maxBytes: SECTION_CAP_BYTES }
}

function envSummary(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith('TENON_')) continue
    const value = env[name]
    if (value === undefined) continue
    out[name] = PLAIN_ENV.has(name) ? value : '<set>'
  }
  return out
}

function pidfileSummary(path: string): unknown {
  const text = readText(path)
  if (text === undefined) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    return { pid: record.pid, port: record.port, version: record.version, started: record.started }
  } catch {
    return 'unreadable'
  }
}

function hookInventory(pluginRoot: string | undefined): unknown {
  if (pluginRoot === undefined) return null
  try {
    return readdirSync(join(pluginRoot, 'hooks'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const stat = statSync(join(pluginRoot, 'hooks', entry.name))
        return { name: entry.name, bytes: stat.size, executable: (stat.mode & 0o111) !== 0 }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return null
  }
}

function configSummary(deps: CliDeps, paths: ProductPaths, runtime: SupportRuntime): string {
  const declaredUser = deps.user()
  return jsonText({
    roots: { data: paths.dataRoot, state: paths.stateRoot, config: paths.configRoot },
    projects: { registered: readProjectRegistry(paths.registryPath).length },
    secrets: { configuredKeys: Object.keys(readSecrets(paths.secretsPath).keys).sort() },
    user: { declared: isTenonUser(declaredUser) },
    host: deps.hostKind?.() ?? null,
    locale: deps.locale ?? null,
    dashboard: pidfileSummary(paths.dashboardPidfilePath),
    env: envSummary(runtime.env()),
    hooks: hookInventory(deps.doctor?.pluginRoot),
  })
}

function logSources(paths: ProductPaths): BundleSource[] {
  const sources: BundleSource[] = []
  for (const file of DASHBOARD_LOG_FILES) {
    const text = readText(join(paths.logsRoot, file))
    if (text !== undefined) sources.push({ kind: 'text', name: `logs/${file}`, text, keep: 'tail', maxBytes: LOG_CAP_BYTES })
  }
  if (sources.length === 0) sources.push({ kind: 'unavailable', name: 'logs/dashboard.log', reason: 'no Dashboard server log yet' })
  return sources
}

function collectSources(deps: CliDeps, paths: ProductPaths, runtime: SupportRuntime, doctor: CapturedCommand, status: CapturedCommand): BundleSource[] {
  const host = runtime.host()
  const timings = readText(join(paths.logsRoot, 'hook-timings.jsonl'))
  return [
    {
      kind: 'text', name: 'version.json', keep: 'head',
      text: jsonText({ tenon: deps.pluginVersion ?? 'unknown', node: host.node, platform: host.platform, arch: host.arch, os: host.release, locale: deps.locale ?? null, created_at: deps.clock() }),
    },
    commandSource('doctor.json', doctor),
    commandSource('runtime-status.json', status),
    { kind: 'text', name: 'config-summary.json', text: configSummary(deps, paths, runtime), keep: 'head', maxBytes: SECTION_CAP_BYTES },
    timings === undefined
      ? { kind: 'unavailable', name: 'hook-timings.jsonl', reason: 'no hook timing records' }
      : { kind: 'text', name: 'hook-timings.jsonl', text: timings, keep: 'tail', maxBytes: SECTION_CAP_BYTES },
    ...logSources(paths),
  ]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function entryLine(deps: CliDeps, entry: BundleEntryReport, width: number): string {
  const name = entry.name.padEnd(width)
  if (entry.unavailable !== undefined) return `  ${name}  ${msg(deps, 'support.entry.unavailable', { reason: entry.unavailable })}`
  const note = entry.truncated
    ? msg(deps, 'support.entry.truncated', { kept: formatBytes(entry.bytes), total: formatBytes(entry.originalBytes) })
    : ''
  return `  ${name}  ${formatBytes(entry.bytes)}${note}`
}

function redactionSummary(deps: CliDeps, built: BuiltBundle): string {
  if (totalRedactions(built.redactions) === 0) return msg(deps, 'support.redactedNone')
  const parts = (Object.keys(built.redactions) as RedactionKind[])
    .filter((kind) => built.redactions[kind] > 0)
    .map((kind) => msg(deps, `support.kind.${kind}`, { count: built.redactions[kind] }))
  return msg(deps, 'support.redacted', { summary: parts.join(deps.locale === 'en' ? ', ' : '、') })
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')
}

function writeArchive(path: string, archive: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, archive, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function cmdSupportBundle(
  deps: CliDeps,
  opts: SupportOpts,
  runtime: SupportRuntime = productionSupportRuntime(),
): Promise<number> {
  const paths = deps.productPaths?.()
  if (paths === undefined) {
    deps.io.err('ERROR: product paths are not wired')
    return 1
  }
  const createdAt = deps.clock()
  const target = resolve(deps.cwd, opts.out ?? join(paths.homeDir, `tenon-support-${stamp(createdAt)}.tar.gz`))
  if (isDirectory(target)) {
    deps.io.err(`ERROR: ${msg(deps, 'support.outInvalid')}`)
    return 1
  }
  const [doctor, status] = [await runtime.doctor(deps), await runtime.runtimeStatus(deps)]
  const declared = deps.user()
  let built: BuiltBundle
  try {
    built = buildSupportBundle({
      createdAt,
      sources: collectSources(deps, paths, runtime, doctor, status),
      redaction: {
        homeDirs: [...runtime.homeDirs(), paths.homeDir],
        userNames: [...runtime.userNames(), ...(isTenonUser(declared) ? [declared.name] : [])],
      },
      notIncluded: NOT_INCLUDED,
      ...(runtime.maxBytes === undefined ? {} : { maxBytes: runtime.maxBytes }),
    })
    writeArchive(target, built.archive)
  } catch (error) {
    deps.io.err(`ERROR: ${msg(deps, 'support.writeFailed', { path: target, error: errMsg(error) })}`)
    return 1
  }
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      path: target,
      bytes: built.archive.length,
      entries: built.entries,
      redactions: built.redactions,
      not_included: NOT_INCLUDED,
    }))
    return 0
  }
  const width = Math.max(...built.entries.map((entry) => entry.name.length))
  deps.io.out(msg(deps, 'support.written', { path: target, size: formatBytes(built.archive.length) }))
  deps.io.out(msg(deps, 'support.included'))
  for (const entry of built.entries) deps.io.out(entryLine(deps, entry, width))
  deps.io.out(redactionSummary(deps, built))
  deps.io.out(msg(deps, 'support.notIncluded'))
  deps.io.out(msg(deps, 'support.review'))
  return 0
}
