#!/usr/bin/env node
// 依赖公告门禁：取代裸 `npm audit --audit-level=high`。
//
// 规则：
//   1. `npm audit --json` 里的每条 high / critical 公告都必须修掉，或写进 tools/audit-allowlist.json。
//   2. 白名单条目必须带齐 id（GHSA）、package、reason、expires、scope="dev-only"；
//      expires 是 ISO 日期，已过期、或离今天超过 30 天，都算失败。
//   3. "dev-only" 不信自述，现场验证：白名单里的包出现在 CLI / server 的 esbuild 模块输入、
//      Dashboard 的 Vite 产物模块、已跟踪的 dist 产物，或 `npm ls --omit=dev` 里，就失败。
//      随产物发出去的包不允许靠白名单放行，只能升级、override 或换依赖。
//      这些分析在全新 `npm ci` 的检出上就能跑：`@tenon/*` 工作区包没有 dist（`tsc -b` 才产出），
//      分析时按它们的 package.json `exports` 改从 `src/` 解析，不要求先构建，也不读可能已陈旧的本机 dist。
//      任何一处解析不出来都直接报错，绝不退化成"空集合 = 干净"。
//   4. 不再匹配任何当前 high / critical 公告的条目（陈旧）同样失败，白名单不会烂在仓库里。
// `npm run check:dependency-tree` 另管解析树完整性，本脚本不替代它。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ALLOWLIST_FILE = 'tools/audit-allowlist.json'
const BLOCKING = new Set(['high', 'critical'])
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical']
export const MAX_ALLOWLIST_DAYS = 30
const DAY_MS = 86_400_000
const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ENTRY_KEYS = ['id', 'package', 'reason', 'expires', 'scope']

// 与 package.json 的 `bundle` / `build:server` 脚本保持同一入口；node-test 会核对两边一致。
// canary 是该产物里一定存在的第三方包，缺了说明分析本身失效（空集合不能当作"干净"）。
export const BUNDLES = [
  { label: 'cli bundle', entry: 'packages/cli/src/main.ts', dist: 'packages/cli/dist/tenon.mjs', canary: 'commander' },
  { label: 'server bundle', entry: 'packages/server/src/main.ts', dist: 'packages/server/dist/dashboard.mjs', canary: null },
]
export const DASHBOARD = { label: 'dashboard assets', root: 'packages/dashboard-app', canary: 'react' }

// ---------------------------------------------------------------- 纯函数

/** 取路径里最内层 node_modules 之后的包名；不在 node_modules 里返回 null。 */
export function packageNameFromPath(path) {
  const normalized = String(path).replaceAll('\\', '/')
  const marker = 'node_modules/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return null
  const parts = normalized.slice(index + marker.length).split('/')
  const first = parts[0]?.split('?')[0]
  if (!first) return null
  if (first.startsWith('@')) {
    const second = parts[1]?.split('?')[0]
    return second ? `${first}/${second}` : null
  }
  return first
}

function packageNames(paths) {
  const names = new Set()
  for (const path of paths) {
    const name = packageNameFromPath(path)
    if (name) names.add(name)
  }
  return names
}

function ghsaFromUrl(url) {
  const match = typeof url === 'string' ? /GHSA-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}/.exec(url) : null
  return match ? `GHSA-${match[0].slice(5).toLowerCase()}` : null
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null
  return ms
}

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/** 解析 `npm audit --json` 的 stdout；输出不是公告报告（网络失败、被截断）时抛错，不当作"无公告"。 */
export function parseAuditOutput(stdout, status) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`npm audit --json did not print JSON (exit ${status}); refusing to treat that as "no advisories"`)
  }
  if (parsed?.error) {
    throw new Error(`npm audit failed: ${parsed.error.code ?? 'unknown'} ${parsed.error.summary ?? ''}`.trim())
  }
  if (!parsed || typeof parsed.vulnerabilities !== 'object' || parsed.vulnerabilities === null) {
    throw new Error('npm audit --json output has no "vulnerabilities" object')
  }
  return parsed
}

/** high / critical 公告，按 GHSA id 去重；`reaches` 是被它波及的包（含上游依赖者）。 */
export function collectAdvisories(audit) {
  const advisories = new Map()
  for (const vuln of Object.values(audit.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || via === null || !BLOCKING.has(via.severity)) continue
      const ghsa = ghsaFromUrl(via.url)
      const id = ghsa ?? `npm-advisory-${via.source}`
      const advisory = advisories.get(id) ?? {
        id,
        ghsa: ghsa !== null,
        package: via.name,
        severity: via.severity,
        title: via.title,
        url: via.url,
        range: via.range,
        reaches: new Set(),
      }
      // effects 只列直接依赖者；沿它一路追到最上层，才能说清这条公告波及了哪些包。
      const queue = [vuln.name]
      while (queue.length > 0) {
        const name = queue.shift()
        if (advisory.reaches.has(name)) continue
        advisory.reaches.add(name)
        queue.push(...(audit.vulnerabilities[name]?.effects ?? []))
      }
      advisories.set(id, advisory)
    }
  }
  return advisories
}

/** 严重度为 high / critical、却追不到任何 high / critical 公告的节点（报告结构异常时按失败处理）。 */
function unexplainedVulnerabilities(audit) {
  const vulns = audit.vulnerabilities
  const explained = (name, seen) => {
    const vuln = vulns[name]
    if (!vuln || seen.has(name)) return false
    seen.add(name)
    return (vuln.via ?? []).some((via) => (typeof via === 'string'
      ? explained(via, seen)
      : BLOCKING.has(via?.severity)))
  }
  return Object.values(vulns)
    .filter((vuln) => BLOCKING.has(vuln.severity) && !explained(vuln.name, new Set()))
    .map((vuln) => vuln.name)
}

/** 校验白名单；每个条目带 `problems`（空数组即合格）。 */
export function validateAllowlist(raw, today) {
  if (!Array.isArray(raw)) return { entries: [], problems: [`${ALLOWLIST_FILE} must be a JSON array`] }
  const todayMs = parseIsoDate(today)
  if (todayMs === null) throw new Error(`today must be an ISO date, got ${today}`)
  const seen = new Set()
  const entries = raw.map((item, index) => {
    const problems = []
    const entry = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : null
    if (!entry) {
      return { index, label: `#${index}`, id: null, package: null, problems: ['entry must be an object'] }
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) problems.push(`unknown field "${key}"`)
    }
    for (const key of ENTRY_KEYS) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') problems.push(`missing or empty "${key}"`)
    }
    if (typeof entry.id === 'string' && !GHSA_ID.test(entry.id)) problems.push(`"id" is not a GHSA id: ${entry.id}`)
    if (typeof entry.id === 'string') {
      if (seen.has(entry.id)) problems.push(`duplicate id ${entry.id}`)
      seen.add(entry.id)
    }
    if (typeof entry.scope === 'string' && entry.scope !== 'dev-only') {
      problems.push(`scope must be "dev-only", got "${entry.scope}"`)
    }
    if (typeof entry.expires === 'string') {
      const expiresMs = parseIsoDate(entry.expires)
      if (expiresMs === null) problems.push(`"expires" must be an ISO date (YYYY-MM-DD), got "${entry.expires}"`)
      else if (expiresMs < todayMs) problems.push(`expired on ${entry.expires}`)
      else if (expiresMs - todayMs > MAX_ALLOWLIST_DAYS * DAY_MS) {
        problems.push(`"expires" ${entry.expires} is more than ${MAX_ALLOWLIST_DAYS} days after today (${today})`)
      }
    }
    return {
      index,
      label: typeof entry.id === 'string' ? entry.id : `#${index}`,
      id: typeof entry.id === 'string' ? entry.id : null,
      package: typeof entry.package === 'string' ? entry.package : null,
      reason: entry.reason,
      expires: entry.expires,
      problems,
    }
  })
  return { entries, problems: [] }
}

function daysUntil(expires, today) {
  return Math.round((parseIsoDate(expires) - parseIsoDate(today)) / DAY_MS)
}

/**
 * 纯判定：输入公告报告、白名单、今天、已发布包集合与生产依赖树，返回 { ok, failures, passes, allowlisted, ... }。
 * shipped = { bundles: [{ label, packages: Set }] }；prod = Set。只有存在被白名单放行的公告时才会用到后两者。
 */
export function evaluate({ audit, allowlist, today, shipped, prod }) {
  const failures = []
  const passes = []
  const advisories = collectAdvisories(audit)
  const { entries, problems: fileProblems } = validateAllowlist(allowlist, today)
  for (const problem of fileProblems) failures.push(problem)
  for (const entry of entries) {
    for (const problem of entry.problems) failures.push(`allowlist ${entry.label}: ${problem}`)
  }
  const usable = new Map()
  for (const entry of entries) {
    if (entry.id && !usable.has(entry.id)) usable.set(entry.id, entry)
  }

  const allowlisted = []
  let blocked = 0
  for (const advisory of advisories.values()) {
    const entry = usable.get(advisory.id)
    const head = `${advisory.id} ${advisory.package} (${advisory.severity}): ${advisory.title}`
    if (!entry) {
      blocked += 1
      failures.push(`${head} -- not allowlisted; fix it by upgrade, override or dependency change`)
      continue
    }
    if (entry.problems.length > 0) {
      blocked += 1
      continue
    }
    if (entry.package !== advisory.package) {
      blocked += 1
      failures.push(`${advisory.id}: allowlist names package "${entry.package}" but the advisory is for "${advisory.package}"`)
      continue
    }
    if (!shipped || !prod) {
      blocked += 1
      failures.push(`${advisory.id} ${advisory.package}: dev-only claim could not be verified (no bundle or production tree data)`)
      continue
    }
    const where = shipped.bundles.filter((bundle) => bundle.packages.has(advisory.package)).map((bundle) => bundle.label)
    if (prod.has(advisory.package)) where.push('npm ls --omit=dev')
    if (where.length > 0) {
      blocked += 1
      failures.push(`${head} -- allowlisted as dev-only but it is shipped (found in: ${where.join(', ')}); fix it by upgrade, override or dependency change instead`)
      continue
    }
    allowlisted.push({ entry, advisory })
  }

  for (const entry of entries) {
    if (entry.id && !advisories.has(entry.id)) {
      failures.push(`allowlist ${entry.id} (${entry.package}): stale, no current high/critical advisory matches it; remove the entry`)
    }
  }
  for (const name of unexplainedVulnerabilities(audit)) {
    failures.push(`${name}: reported high/critical but no high/critical advisory explains it`)
  }

  if (advisories.size === 0) passes.push('no high or critical advisories')
  else if (blocked === 0) passes.push(`all ${advisories.size} high/critical advisories are allowlisted and verified dev-only`)
  if (entries.length > 0 && entries.every((entry) => entry.problems.length === 0)) {
    passes.push(`allowlist structure valid (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, none expired or beyond ${MAX_ALLOWLIST_DAYS} days)`)
  }
  if (entries.length > 0 && entries.every((entry) => !entry.id || advisories.has(entry.id))) {
    passes.push('no stale allowlist entries')
  }

  return {
    ok: failures.length === 0,
    today,
    counts: audit.metadata?.vulnerabilities ?? null,
    advisoryCount: advisories.size,
    allowlisted,
    passes,
    failures,
    shipped: shipped ? shipped.bundles.map((bundle) => ({ label: bundle.label, count: bundle.packages.size })) : null,
  }
}

export function render(result) {
  const lines = [`Dependency advisory gate (npm audit, ${result.today})`]
  if (result.counts) {
    const counts = SEVERITY_ORDER.filter((severity) => result.counts[severity] > 0)
      .map((severity) => `${result.counts[severity]} ${severity}`)
    lines.push(`  npm audit: ${result.counts.total} vulnerable package(s)${counts.length ? ` (${counts.join(', ')})` : ''}; the gate blocks high and critical only`)
  }
  lines.push(`  ${result.advisoryCount} distinct high/critical advisor${result.advisoryCount === 1 ? 'y' : 'ies'}`)
  for (const passed of result.passes) lines.push(`  PASS  ${passed}`)
  for (const { entry, advisory } of result.allowlisted) {
    lines.push(`  ALLOW ${advisory.id} ${advisory.package} (${advisory.severity}) until ${entry.expires} (${daysUntil(entry.expires, result.today)} days left)`)
    lines.push(`        reason: ${entry.reason}`)
    lines.push(`        reaches: ${[...advisory.reaches].join(', ')}`)
  }
  if (result.shipped && result.allowlisted.length > 0) {
    const where = result.shipped.map((bundle) => `${bundle.label} [${bundle.count} third-party]`)
    lines.push(`  VERIFIED dev-only: allowlisted packages are absent from ${where.join(', ')} and from npm ls --omit=dev`)
  }
  for (const failure of result.failures) lines.push(`  FAIL  ${failure}`)
  lines.push(result.ok
    ? `RESULT: PASS (${result.allowlisted.length} allowlisted, 0 blocked)`
    : `RESULT: FAIL (${result.failures.length} problem${result.failures.length === 1 ? '' : 's'})`)
  return lines
}

// ---------------------------------------------------------------- 数据采集

function npm(args, root) {
  const win = process.platform === 'win32'
  const result = spawnSync(win ? 'npm.cmd' : 'npm', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: win,
  })
  if (result.error) throw result.error
  return result
}

function auditCollector(root) {
  const result = npm(['audit', '--json'], root)
  return parseAuditOutput(result.stdout, result.status)
}

/** `npm ls --omit=dev --all --json` 里出现过的所有包名（含工作区的生产依赖）。 */
export function prodPackageNames(tree) {
  const names = new Set()
  const walk = (node) => {
    for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
      names.add(name)
      walk(child)
    }
  }
  walk(tree)
  return names
}

function prodCollector(root) {
  const result = npm(['ls', '--omit=dev', '--all', '--json'], root)
  let tree
  try {
    tree = JSON.parse(result.stdout)
  } catch {
    throw new Error(`npm ls --omit=dev --all --json did not print JSON (exit ${result.status})`)
  }
  return prodPackageNames(tree)
}

// ---------------------------------------------------------------- 工作区包按源码解析

const WORKSPACE_SCOPE = '@tenon/'
const WORKSPACE_PACKAGES_DIR = 'packages'

/**
 * 工作区包的 dist 路径 → 对应源码：`<root>/packages/<pkg>/dist/a/b.js` → `<root>/packages/<pkg>/src/a/b.ts`。
 * 各包 tsconfig 固定 rootDir src、outDir dist，所以这个映射与 `tsc -b` 的产出一一对应。
 * roots 同时给出路径本身与它的 realpath（macOS 的 /var → /private/var、符号链接的工作目录），
 * 免得 esbuild / vite 报来的路径与 root 写法不同而漏映射。不在某个工作区包的 dist 下返回 null；映射到的源码不存在则抛错。
 */
function distToSource(roots, absolutePath) {
  for (const root of roots) {
    const parts = relative(join(root, WORKSPACE_PACKAGES_DIR), absolutePath).split(/[\\/]/)
    if (parts.length < 3 || parts[0] === '..' || parts[1] !== 'dist' || !parts.at(-1).endsWith('.js')) continue
    const source = join(root, WORKSPACE_PACKAGES_DIR, parts[0], 'src', ...parts.slice(2, -1), `${parts.at(-1).slice(0, -3)}.ts`)
    if (!existsSync(source)) {
      throw new Error(`cannot resolve ${relative(root, absolutePath)} from source: ${relative(root, source)} does not exist`)
    }
    return source
  }
  return null
}

/**
 * 在全新 `npm ci` 检出（没有 dist）上也能复刻真实打包的两条解析路径，都改从 `src/` 取：
 *   1. `@tenon/<pkg>[/<sub>]`：真实打包经 node_modules 符号链接 → 包的 package.json `exports` → `./dist/*.js`；
 *      这里沿用同一份 `exports`，再把 dist 换成 src。
 *   2. 相对路径直接伸进兄弟包 dist（如 `../../kernel/dist/skill-invocation/producer-internal.js`，该文件刻意不在 exports 里）。
 * 返回源码绝对路径；与工作区无关的导入返回 null（交回默认解析）；是工作区导入却解不出来就抛错，
 * 让分析失败，而不是悄悄漏掉模块。
 */
export function createWorkspaceResolver(root) {
  const roots = [...new Set([resolve(root), realpathSync(root)])]
  let packages // 包名 → { dir, exports }；首次用到时才扫描
  const loadPackages = () => {
    const found = new Map()
    const base = join(roots[0], WORKSPACE_PACKAGES_DIR)
    if (!existsSync(base)) return found
    for (const dirent of readdirSync(base, { withFileTypes: true })) {
      const manifestPath = join(base, dirent.name, 'package.json')
      if (!dirent.isDirectory() || !existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string') found.set(manifest.name, { dir: join(base, dirent.name), exports: manifest.exports })
    }
    return found
  }
  const resolvePackage = (specifier) => {
    packages ??= loadPackages()
    const [scope, name, ...rest] = specifier.split('/')
    const workspace = packages.get(`${scope}/${name}`)
    if (!workspace) return null
    const key = rest.length === 0 ? '.' : `./${rest.join('/')}`
    const target = workspace.exports !== null && typeof workspace.exports === 'object' ? workspace.exports[key] : undefined
    if (typeof target !== 'string') {
      throw new Error(`cannot resolve ${specifier} from source: its package.json "exports" has no string target for "${key}"`)
    }
    const source = distToSource(roots, join(workspace.dir, target))
    if (!source) throw new Error(`cannot resolve ${specifier} from source: exports target "${target}" is not a ./dist/*.js build output`)
    return source
  }
  return (specifier, importerDir) => {
    if (specifier.startsWith(WORKSPACE_SCOPE)) return resolvePackage(specifier)
    if (specifier.startsWith('.') && importerDir) return distToSource(roots, resolve(importerDir, specifier))
    return null
  }
}

function workspaceEsbuildPlugin(root) {
  const resolveWorkspace = createWorkspaceResolver(root)
  return {
    name: 'tenon-workspace-source',
    setup(build) {
      // 只拦 `@tenon/*` 与路径里带 /dist/ 的导入；其余照常交给 esbuild。
      build.onResolve({ filter: /^@tenon\/|\/dist\// }, (args) => {
        try {
          const path = resolveWorkspace(args.path, args.resolveDir)
          return path ? { path } : undefined
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] }
        }
      })
    },
  }
}

function workspaceVitePlugin(root) {
  const resolveWorkspace = createWorkspaceResolver(root)
  // 抛出的错误会让 vite build 失败；enforce:'pre' 保证它先于 vite 自带的 node_modules 解析。
  return {
    name: 'tenon-workspace-source',
    enforce: 'pre',
    resolveId: (source, importer) => resolveWorkspace(source, importer ? dirname(importer.split('?')[0]) : undefined),
  }
}

// ---------------------------------------------------------------- 已发布包分析

/** esbuild 以入口源码打包（`@tenon/*` 按源码解析）得到的第三方包集合。 */
export async function sourceBundleInputs(root, bundle) {
  const { build } = await import('esbuild')
  const result = await build({
    absWorkingDir: root,
    entryPoints: [bundle.entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    metafile: true,
    logLevel: 'silent',
    outfile: join(tmpdir(), 'tenon-check-audit-unused.mjs'),
    plugins: [workspaceEsbuildPlugin(root)],
  })
  return packageNames(Object.keys(result.metafile.inputs))
}

/** 已跟踪的 dist 里每个第三方模块前都有 `// node_modules/...` 注释；文件不存在时返回空集合。 */
export function trackedBundleInputs(root, bundle) {
  const distPath = join(root, bundle.dist)
  if (!existsSync(distPath)) return new Set()
  const comments = readFileSync(distPath, 'utf8').matchAll(/^\/\/ (\S*node_modules\/\S+)$/gm)
  return packageNames([...comments].map((match) => match[1]))
}

/** 源码分析并上已跟踪的 dist，陈旧或手改的产物也算数。 */
export async function bundleInputs(root, bundle) {
  const packages = await sourceBundleInputs(root, bundle)
  for (const name of trackedBundleInputs(root, bundle)) packages.add(name)
  return packages
}

export async function dashboardInputs(root, dashboard = DASHBOARD) {
  const { build } = await import('vite')
  const output = await build({
    root: join(root, dashboard.root),
    logLevel: 'silent',
    plugins: [workspaceVitePlugin(root)],
    // write:false 不落盘；outDir 指向临时目录，保证不会碰已跟踪的 packages/dashboard-app/dist。
    build: { write: false, outDir: join(tmpdir(), 'tenon-check-audit-dashboard'), emptyOutDir: false },
  })
  const ids = []
  for (const bundle of Array.isArray(output) ? output : [output]) {
    for (const item of bundle.output) {
      if (item.type === 'chunk') ids.push(...Object.keys(item.modules))
      else ids.push(...(item.originalFileNames ?? []))
    }
  }
  return packageNames(ids)
}

async function shippedCollector(root) {
  const bundles = []
  for (const bundle of BUNDLES) bundles.push({ label: bundle.label, canary: bundle.canary, packages: await bundleInputs(root, bundle) })
  bundles.push({ label: DASHBOARD.label, canary: DASHBOARD.canary, packages: await dashboardInputs(root) })
  for (const bundle of bundles) {
    if (bundle.canary && !bundle.packages.has(bundle.canary)) {
      throw new Error(`shipped-package analysis is broken: ${bundle.label} should contain "${bundle.canary}" but the module list does not`)
    }
  }
  return { bundles }
}

export function defaultCollectors(root = ROOT) {
  return {
    audit: () => auditCollector(root),
    prod: () => prodCollector(root),
    shipped: () => shippedCollector(root),
  }
}

export async function check({ root = ROOT, today = todayIso(), collectors = defaultCollectors(root) } = {}) {
  const allowlist = JSON.parse(readFileSync(join(root, ALLOWLIST_FILE), 'utf8'))
  const audit = await collectors.audit()
  const advisories = collectAdvisories(audit)
  // 只有存在被白名单放行的公告时，才付出构建产物与读生产树的代价。
  const needsVerification = Array.isArray(allowlist) && allowlist.some((entry) => advisories.has(entry?.id))
  const shipped = needsVerification ? await collectors.shipped() : undefined
  const prod = needsVerification ? await collectors.prod() : undefined
  return evaluate({ audit, allowlist, today, shipped, prod })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await check()
    const lines = render(result)
    ;(result.ok ? process.stdout : process.stderr).write(`${lines.join('\n')}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`Dependency advisory gate could not run: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
