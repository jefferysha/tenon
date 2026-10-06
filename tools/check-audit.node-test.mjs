import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  analyzeSourceBundle,
  assertBundleModules,
  BUNDLES,
  bundleInputs,
  check,
  collectAdvisories,
  createWorkspaceResolver,
  dashboardCrossCheckInputs,
  dashboardInputs,
  DASHBOARD_SNAPSHOT_FILE,
  diffPackageLists,
  evaluate,
  missingBundleModules,
  packageNameFromPath,
  parseAuditOutput,
  prodPackageNames,
  readDashboardSnapshot,
  render,
  sourceBundleInputs,
  trackedBundleInputs,
  UPDATE_DASHBOARD_SNAPSHOT_COMMAND,
  validateAllowlist,
  writeDashboardSnapshot,
} from './check-audit.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const TODAY = '2026-10-06'
const BRACES_ID = 'GHSA-vfj7-8cjw-p6xm'
const TINYPOOL_ID = 'GHSA-5gmw-xhrv-c9v3'

function via(name, ghsa, severity = 'high') {
  return {
    source: 1,
    name,
    dependency: name,
    title: `${name} advisory`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: '<=1.0.0',
  }
}

// 与真实 `npm audit --json` 同形：braces 带公告，micromatch / fast-glob / openspec 只是沿依赖链传播。
function bracesAudit(extra = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: { name: 'braces', severity: 'high', via: [via('braces', BRACES_ID)], effects: ['micromatch'], range: '*' },
      micromatch: { name: 'micromatch', severity: 'high', via: ['braces'], effects: ['fast-glob'], range: '*' },
      'fast-glob': { name: 'fast-glob', severity: 'high', via: ['micromatch'], effects: ['@fission-ai/openspec'], range: '*' },
      '@fission-ai/openspec': { name: '@fission-ai/openspec', severity: 'high', via: ['fast-glob'], effects: [], range: '*' },
      'fast-uri': { name: 'fast-uri', severity: 'moderate', via: [via('fast-uri', 'GHSA-hrr3-gc8f-f4qj', 'moderate')], effects: [], range: '*' },
      ...extra,
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 4, critical: 0, total: 5 } },
  }
}

const bracesEntry = (overrides = {}) => ({
  id: BRACES_ID,
  package: 'braces',
  reason: 'reached only through the openspec CLI used by check:openspec; patterns are repository-controlled',
  expires: '2026-11-05',
  scope: 'dev-only',
  ...overrides,
})

const cleanShipped = () => ({
  bundles: [
    { label: 'cli bundle', packages: new Set(['commander']) },
    { label: 'server bundle', packages: new Set() },
    { label: 'dashboard assets', packages: new Set(['react']) },
  ],
})

const cleanProd = () => new Set(['commander', 'react'])

function run(overrides = {}) {
  return evaluate({
    audit: bracesAudit(),
    allowlist: [bracesEntry()],
    today: TODAY,
    shipped: cleanShipped(),
    prod: cleanProd(),
    ...overrides,
  })
}

test('passes an allowlisted advisory that is verified dev-only and prints when it expires', () => {
  const result = run()
  assert.equal(result.ok, true, result.failures.join('\n'))
  assert.equal(result.allowlisted.length, 1)
  const text = render(result).join('\n')
  assert.match(text, /ALLOW GHSA-vfj7-8cjw-p6xm braces \(high\) until 2026-11-05 \(30 days left\)/)
  assert.match(text, /reaches: braces, micromatch, fast-glob, @fission-ai\/openspec/)
  assert.match(text, /VERIFIED dev-only/)
  assert.match(text, /RESULT: PASS \(1 allowlisted, 0 blocked\)/)
})

test('passes with no advisories and an empty allowlist', () => {
  const result = run({ audit: { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }, allowlist: [], shipped: undefined, prod: undefined })
  assert.equal(result.ok, true)
  assert.match(render(result).join('\n'), /no high or critical advisories/)
})

test('fails a high advisory that is not allowlisted, and ignores moderate ones', () => {
  const result = run({ allowlist: [] })
  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], new RegExp(`${BRACES_ID} braces \\(high\\).*not allowlisted`))
  assert.doesNotMatch(result.failures.join('\n'), /fast-uri|GHSA-hrr3/)
  assert.match(render(result).join('\n'), /RESULT: FAIL \(1 problem\)/)
})

test('collects advisories by GHSA id once, keeping only high and critical', () => {
  const audit = bracesAudit({
    tinypool: { name: 'tinypool', severity: 'critical', via: [via('tinypool', TINYPOOL_ID, 'critical'), via('tinypool', TINYPOOL_ID, 'critical')], effects: ['vitest'], range: '*' },
  })
  const advisories = collectAdvisories(audit)
  assert.deepEqual([...advisories.keys()].sort(), [TINYPOOL_ID, BRACES_ID].sort())
  assert.equal(advisories.get(TINYPOOL_ID).severity, 'critical')
  assert.deepEqual([...advisories.get(BRACES_ID).reaches], ['braces', 'micromatch', 'fast-glob', '@fission-ai/openspec'])
})

test('fails an expired allowlist entry, and still accepts one that expires today', () => {
  const expired = run({ allowlist: [bracesEntry({ expires: '2026-10-05' })] })
  assert.equal(expired.ok, false)
  assert.match(expired.failures.join('\n'), /expired on 2026-10-05/)

  assert.equal(run({ allowlist: [bracesEntry({ expires: TODAY })] }).ok, true)
})

test('rejects an expiry more than 30 days out, and accepts exactly 30 days', () => {
  const far = run({ allowlist: [bracesEntry({ expires: '2026-11-06' })] })
  assert.equal(far.ok, false)
  assert.match(far.failures.join('\n'), /more than 30 days after today/)

  assert.equal(run({ allowlist: [bracesEntry({ expires: '2026-11-05' })] }).ok, true)
})

test('rejects entries that miss a field, use another scope, carry unknown fields or bad dates', () => {
  const cases = [
    [{ reason: undefined }, /missing or empty "reason"/],
    [{ reason: '  ' }, /missing or empty "reason"/],
    [{ package: undefined }, /missing or empty "package"/],
    [{ expires: undefined }, /missing or empty "expires"/],
    [{ scope: 'runtime' }, /scope must be "dev-only"/],
    [{ scope: undefined }, /missing or empty "scope"/],
    [{ id: 'CVE-2024-4068' }, /not a GHSA id/],
    [{ expires: '2026-02-30' }, /must be an ISO date/],
    [{ expires: 'soon' }, /must be an ISO date/],
    [{ owner: 'someone' }, /unknown field "owner"/],
  ]
  for (const [overrides, pattern] of cases) {
    const result = run({ allowlist: [bracesEntry(overrides)] })
    assert.equal(result.ok, false, JSON.stringify(overrides))
    assert.match(result.failures.join('\n'), pattern, JSON.stringify(overrides))
  }
  assert.equal(run({ allowlist: { id: BRACES_ID } }).ok, false)
  assert.equal(run({ allowlist: ['GHSA-vfj7-8cjw-p6xm'] }).ok, false)
})

test('fails a duplicated allowlist id', () => {
  const result = run({ allowlist: [bracesEntry(), bracesEntry()] })
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /duplicate id/)
})

test('fails a stale entry that matches no current high or critical advisory', () => {
  const result = run({ allowlist: [bracesEntry(), bracesEntry({ id: TINYPOOL_ID, package: 'tinypool' })] })
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), new RegExp(`allowlist ${TINYPOOL_ID} \\(tinypool\\): stale`))

  const moderateOnly = run({
    audit: { vulnerabilities: { 'fast-uri': bracesAudit().vulnerabilities['fast-uri'] }, metadata: {} },
    allowlist: [bracesEntry({ id: 'GHSA-hrr3-gc8f-f4qj', package: 'fast-uri' })],
    shipped: undefined,
    prod: undefined,
  })
  assert.equal(moderateOnly.ok, false)
  assert.match(moderateOnly.failures.join('\n'), /stale/)
})

test('fails when the allowlisted package is in a shipped bundle, whatever the allowlist says', () => {
  for (const label of ['cli bundle', 'server bundle', 'dashboard assets']) {
    const shipped = cleanShipped()
    shipped.bundles.find((bundle) => bundle.label === label).packages.add('braces')
    const result = run({ shipped })
    assert.equal(result.ok, false, label)
    assert.match(result.failures.join('\n'), new RegExp(`it is shipped \\(found in: ${label}\\)`), label)
    assert.equal(result.allowlisted.length, 0)
  }
})

test('fails when the allowlisted package is in the production dependency tree', () => {
  const result = run({ prod: new Set([...cleanProd(), 'braces']) })
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /found in: npm ls --omit=dev/)
})

test('fails when the allowlist names a different package than the advisory', () => {
  const result = run({ allowlist: [bracesEntry({ package: 'micromatch' })] })
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /names package "micromatch" but the advisory is for "braces"/)
})

test('fails closed when the dev-only claim cannot be verified', () => {
  const result = run({ shipped: undefined, prod: undefined })
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /could not be verified/)
})

test('fails a high or critical node that no advisory explains', () => {
  const result = run({
    audit: { vulnerabilities: { ghost: { name: 'ghost', severity: 'critical', via: ['nothing'], effects: [] } }, metadata: {} },
    allowlist: [],
    shipped: undefined,
    prod: undefined,
  })
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /ghost: reported high\/critical but no high\/critical advisory explains it/)
})

test('fails an advisory without a GHSA id because it cannot be allowlisted', () => {
  const audit = { vulnerabilities: { odd: { name: 'odd', severity: 'high', via: [{ source: 99, name: 'odd', title: 'odd', url: 'https://example.com/odd', severity: 'high', range: '*' }], effects: [] } }, metadata: {} }
  const result = run({ audit, allowlist: [], shipped: undefined, prod: undefined })
  assert.equal(result.ok, false)
  assert.match(result.failures[0], /npm-advisory-99 odd/)
})

test('treats an unusable npm audit report as a failure instead of "no advisories"', () => {
  assert.throws(() => parseAuditOutput('', 1), /did not print JSON/)
  assert.throws(() => parseAuditOutput('{"error":{"code":"ENOTFOUND","summary":"audit endpoint unreachable"}}', 1), /ENOTFOUND audit endpoint unreachable/)
  assert.throws(() => parseAuditOutput('{"metadata":{}}', 0), /no "vulnerabilities"/)
  assert.deepEqual(parseAuditOutput('{"vulnerabilities":{}}', 0), { vulnerabilities: {} })
})

test('reads package names from the innermost node_modules segment', () => {
  assert.equal(packageNameFromPath('node_modules/commander/esm.mjs'), 'commander')
  assert.equal(packageNameFromPath('/repo/node_modules/@radix-ui/react-dialog/dist/index.mjs'), '@radix-ui/react-dialog')
  assert.equal(packageNameFromPath('node_modules/a/node_modules/b/index.js'), 'b')
  assert.equal(packageNameFromPath('\0C:\\repo\\node_modules\\react\\index.js?commonjs-exports'), 'react')
  assert.equal(packageNameFromPath('packages/kernel/src/index.ts'), null)
})

test('collects production package names from the nested npm ls tree', () => {
  const tree = { dependencies: { commander: {}, '@tenon/cli': { dependencies: { commander: {}, react: { dependencies: { 'loose-envify': {} } } } } } }
  assert.deepEqual([...prodPackageNames(tree)].sort(), ['@tenon/cli', 'commander', 'loose-envify', 'react'])
})

test('rejects an allowlist read against an invalid today', () => {
  assert.throws(() => validateAllowlist([], 'yesterday'), /today must be an ISO date/)
})

test('check() reads tools/audit-allowlist.json and only collects bundle data when an advisory is allowlisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-check-audit-'))
  try {
    await mkdir(join(dir, 'tools'), { recursive: true })
    let shippedCalls = 0
    const collectors = (audit) => ({
      audit: async () => audit,
      shipped: async () => { shippedCalls += 1; return cleanShipped() },
      prod: async () => cleanProd(),
    })

    await writeFile(join(dir, 'tools', 'audit-allowlist.json'), '[]\n')
    const none = await check({ root: dir, today: TODAY, collectors: collectors({ vulnerabilities: {}, metadata: {} }) })
    assert.equal(none.ok, true)
    assert.equal(shippedCalls, 0)

    await writeFile(join(dir, 'tools', 'audit-allowlist.json'), `${JSON.stringify([bracesEntry()])}\n`)
    const allowed = await check({ root: dir, today: TODAY, collectors: collectors(bracesAudit()) })
    assert.equal(allowed.ok, true, allowed.failures.join('\n'))
    assert.equal(shippedCalls, 1)

    await rm(join(dir, 'tools', 'audit-allowlist.json'))
    await assert.rejects(check({ root: dir, today: TODAY, collectors: collectors(bracesAudit()) }), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the committed allowlist is well formed', async () => {
  const raw = JSON.parse(await readFile(join(root, 'tools', 'audit-allowlist.json'), 'utf8'))
  // 日期窗口相对"今天"，会随时间变化；这里固定在条目写入当天，只验结构与 scope，到期交给门禁本身。
  const { entries, problems } = validateAllowlist(raw, '2026-10-06')
  assert.deepEqual(problems, [])
  for (const entry of entries) assert.deepEqual(entry.problems, [], entry.label)
})

test('bundle entries match the esbuild scripts in package.json and the gate is wired into check:dependencies', async () => {
  const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const scriptOf = { 'cli bundle': scripts.bundle, 'server bundle': scripts['build:server'] }
  for (const bundle of BUNDLES) {
    const script = scriptOf[bundle.label]
    assert.ok(script.includes(`esbuild ${bundle.entry} --bundle`), `${bundle.label} entry`)
    assert.ok(script.includes(`--outfile=${bundle.dist}`), `${bundle.label} outfile`)
    assert.ok(script.includes('--platform=node --format=esm --target=node22'), `${bundle.label} options`)
  }
  assert.match(scripts['check:dependencies'], /node tools\/check-audit\.mjs/)
  assert.match(scripts['check:dependencies'], /npm run check:dependency-tree/)
  assert.doesNotMatch(scripts['check:dependencies'], /npm audit/)
  assert.equal(scripts['check:dependency-tree'], 'npm ls --all')
})

test('real esbuild metafile: the CLI bundle contains commander and neither shipped bundle contains braces or tinypool', async () => {
  const [cli, server] = await Promise.all(BUNDLES.map((bundle) => bundleInputs(root, bundle)))
  assert.ok(cli.has('commander'))
  for (const packages of [cli, server]) {
    assert.equal(packages.has('braces'), false)
    assert.equal(packages.has('tinypool'), false)
  }
})

// ---------------------------------------------------------------- 全新检出：工作区包没有 dist

// 仿照 npm workspace 的布局：packages/kernel 只有 src（`tsc -b` 才会产出 dist），cli 以三种方式引用它——
// 根导出、子路径导出，以及刻意不在 exports 里的"相对路径伸进 dist"。第三方包放在根 node_modules。
const CLI_BUNDLE = { label: 'fixture cli', entry: 'packages/cli/src/main.ts', dist: 'packages/cli/dist/tenon.mjs' }

const CLI_MAIN = [
  "import { kernel } from '@tenon/kernel'",
  "import { leaf } from '@tenon/kernel/sub'",
  "import { secret } from '../../kernel/dist/private/internal.js'",
  'console.log(kernel, leaf, secret)',
  '',
].join('\n')

function workspaceFiles(overrides = {}) {
  return {
    'node_modules/thirdparty/package.json': '{"name":"thirdparty","version":"1.0.0","main":"index.js"}',
    'node_modules/thirdparty/index.js': 'exports.third = 1\n',
    'node_modules/stale-decoy/package.json': '{"name":"stale-decoy","version":"1.0.0","main":"index.js"}',
    'node_modules/stale-decoy/index.js': 'exports.decoy = 1\n',
    'packages/kernel/package.json': JSON.stringify({ name: '@tenon/kernel', exports: { '.': './dist/index.js', './sub': './dist/sub/leaf.js' } }),
    'packages/kernel/src/index.ts': "import { third } from 'thirdparty'\nexport const kernel: number = third\n",
    'packages/kernel/src/sub/leaf.ts': 'export const leaf = 1\n',
    'packages/kernel/src/private/internal.ts': 'export const secret = 2\n',
    'packages/cli/package.json': '{"name":"@tenon/cli"}',
    'packages/cli/src/main.ts': CLI_MAIN,
    ...overrides,
  }
}

// canonical: 取 realpath 作根（macOS 的 tmpdir 经 /var → /private/var 符号链接；vite 的 HTML 入口要求 root 已是真实路径）。
async function withWorkspace(files, body, { canonical = false } = {}) {
  const created = await mkdtemp(join(tmpdir(), 'tenon-check-audit-ws-'))
  const dir = canonical ? await realpath(created) : created
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('workspace resolver maps exports and dist-reaching relative imports to src, and leaves everything else alone', async () => {
  await withWorkspace(workspaceFiles(), async (dir) => {
    const resolveWorkspace = createWorkspaceResolver(dir)
    const importerDir = join(dir, 'packages', 'cli', 'src')
    assert.equal(resolveWorkspace('@tenon/kernel', importerDir), join(dir, 'packages', 'kernel', 'src', 'index.ts'))
    assert.equal(resolveWorkspace('@tenon/kernel/sub', importerDir), join(dir, 'packages', 'kernel', 'src', 'sub', 'leaf.ts'))
    assert.equal(resolveWorkspace('../../kernel/dist/private/internal.js', importerDir), join(dir, 'packages', 'kernel', 'src', 'private', 'internal.ts'))
    for (const untouched of ['thirdparty', 'thirdparty/dist/x.js', '@tenon/not-a-workspace-package', '@other/kernel', './local.js', '../local.js']) {
      assert.equal(resolveWorkspace(untouched, importerDir), null, untouched)
    }
    // 不在工作区包 dist 下的相对路径也不动
    assert.equal(resolveWorkspace('../../../node_modules/thirdparty/dist/x.js', importerDir), null)
  })
})

test('workspace resolver fails instead of guessing when a workspace import has no source', async () => {
  await withWorkspace(workspaceFiles({
    'packages/kernel/package.json': JSON.stringify({ name: '@tenon/kernel', exports: { '.': './dist/index.js', './cjs': './lib/x.cjs', './cond': { import: './dist/index.js' } } }),
  }), async (dir) => {
    const resolveWorkspace = createWorkspaceResolver(dir)
    const importerDir = join(dir, 'packages', 'cli', 'src')
    assert.throws(() => resolveWorkspace('@tenon/kernel/not-exported', importerDir), /"exports" has no string target for "\.\/not-exported"/)
    assert.throws(() => resolveWorkspace('@tenon/kernel/cond', importerDir), /"exports" has no string target for "\.\/cond"/)
    assert.throws(() => resolveWorkspace('@tenon/kernel/cjs', importerDir), /not a \.\/dist\/\*\.js build output/)
    assert.throws(() => resolveWorkspace('../../kernel/dist/private/gone.js', importerDir), /private[\\/]gone\.ts does not exist/)
    await rm(join(dir, 'packages', 'kernel', 'src', 'index.ts'))
    assert.throws(() => resolveWorkspace('@tenon/kernel', importerDir), /index\.ts does not exist/)
  })
})

test('bundle analysis works on a fresh checkout where no workspace dist exists, and never reads a stale dist', async () => {
  await withWorkspace(workspaceFiles(), async (dir) => {
    assert.equal(existsSync(join(dir, 'packages', 'kernel', 'dist')), false)
    assert.deepEqual([...await sourceBundleInputs(dir, CLI_BUNDLE)], ['thirdparty'])
  })
  await withWorkspace(workspaceFiles({
    'packages/kernel/dist/index.js': "import 'stale-decoy'\nexport const kernel = 0\n",
    'packages/kernel/dist/sub/leaf.js': 'export const leaf = 0\n',
    'packages/kernel/dist/private/internal.js': "import 'stale-decoy'\nexport const secret = 0\n",
  }), async (dir) => {
    assert.deepEqual([...await sourceBundleInputs(dir, CLI_BUNDLE)], ['thirdparty'])
  })
})

test('bundle analysis still unions in the third-party modules of the tracked dist bundle', async () => {
  await withWorkspace(workspaceFiles({
    'packages/cli/dist/tenon.mjs': '// packages/cli/src/main.ts\n// node_modules/tracked-only/index.js\nexport {}\n',
  }), async (dir) => {
    assert.deepEqual([...trackedBundleInputs(dir, CLI_BUNDLE)], ['tracked-only'])
    assert.deepEqual([...await bundleInputs(dir, CLI_BUNDLE)].sort(), ['thirdparty', 'tracked-only'])
  })
})

test('bundle analysis fails closed instead of reporting an empty, clean set', async () => {
  await withWorkspace(workspaceFiles(), async (dir) => {
    await assert.rejects(sourceBundleInputs(dir, { ...CLI_BUNDLE, entry: 'packages/cli/src/missing.ts' }), /missing\.ts/)
    await writeFile(join(dir, 'packages', 'cli', 'src', 'main.ts'), "import '@tenon/kernel/not-exported'\n")
    await assert.rejects(sourceBundleInputs(dir, CLI_BUNDLE), /"exports" has no string target/)
    await writeFile(join(dir, 'packages', 'cli', 'src', 'main.ts'), "import '../../kernel/dist/private/gone.js'\n")
    await assert.rejects(sourceBundleInputs(dir, CLI_BUNDLE), /does not exist/)
    await writeFile(join(dir, 'packages', 'cli', 'src', 'main.ts'), "import 'not-installed-anywhere'\n")
    await assert.rejects(sourceBundleInputs(dir, CLI_BUNDLE), /not-installed-anywhere/)
  })
})

test('dashboard analysis resolves workspace packages from source and fails closed when it cannot', async () => {
  const dashboard = { label: 'fixture dashboard', root: 'packages/dash' }
  const files = workspaceFiles({
    'packages/dash/index.html': '<!doctype html><script type="module" src="/src/main.ts"></script>\n',
    'packages/dash/src/main.ts': "import { leaf } from '@tenon/kernel/sub'\nimport { third } from 'thirdparty'\nconsole.log(leaf, third)\n",
    // 陈旧 dist 不能被读到
    'packages/kernel/dist/sub/leaf.js': "import 'stale-decoy'\nexport const leaf = 0\n",
  })
  await withWorkspace(files, async (dir) => {
    assert.deepEqual([...await dashboardInputs(dir, dashboard)], ['thirdparty'])
    await writeFile(join(dir, 'packages', 'dash', 'src', 'main.ts'), "import '@tenon/kernel/not-exported'\n")
    await assert.rejects(dashboardInputs(dir, dashboard), /"exports" has no string target/)
  }, { canonical: true })
})

test('the source analysis reproduces the third-party packages of the tracked shipped bundles', async () => {
  // 已跟踪的 dist 由 `npm run bundle` / `build:server` 经 dist 解析构建，CI 另有新鲜度门保证它与源码一致；
  // 所以分析按源码解析出的第三方包必须与它逐个相同，才说明"按源码解析"没有偏离真实打包。
  for (const bundle of BUNDLES) {
    const fromSource = [...await sourceBundleInputs(root, bundle)].sort()
    const fromTracked = [...trackedBundleInputs(root, bundle)].sort()
    assert.deepEqual(fromSource, fromTracked, bundle.label)
  }
})

// ---------------------------------------------------------------- 分析本身的交叉验证

const SERVER_BUNDLE = BUNDLES.find((bundle) => bundle.label === 'server bundle')

test('every shipped bundle declares its own entry among the first-party modules it must contain', () => {
  for (const bundle of BUNDLES) {
    assert.ok(Array.isArray(bundle.modules) && bundle.modules.length > 0, `${bundle.label} declares modules`)
    assert.ok(bundle.modules.includes(bundle.entry), `${bundle.label} lists its entry module`)
    assert.equal(new Set(bundle.modules).size, bundle.modules.length, `${bundle.label} has no duplicate modules`)
  }
})

test('the real esbuild input list of each shipped bundle contains the first-party modules it declares', async () => {
  for (const bundle of BUNDLES) {
    const { modules } = await analyzeSourceBundle(root, bundle)
    assert.deepEqual(missingBundleModules(bundle, modules), [], bundle.label)
    // 模块是相对 root 的正斜杠路径：没有 "../" 开头，也没有 Windows 分隔符混进来。
    for (const module of modules) assert.doesNotMatch(module, /^\.\.|\\/, module)
  }
  // server 产物现在没有第三方包，包集合为空并不说明分析坏了；模块清单才是"分析确实跑过"的证据。
  const { modules } = await analyzeSourceBundle(root, SERVER_BUNDLE)
  assert.ok(modules.length >= SERVER_BUNDLE.modules.length)
})

test('a bundle with no third-party canary still fails closed on an empty or partial module list', () => {
  assert.equal(SERVER_BUNDLE.canary, null)
  assert.throws(() => assertBundleModules(SERVER_BUNDLE, []), /analysis is broken: server bundle .*packages\/server\/src\/main\.ts/)
  const partial = SERVER_BUNDLE.modules.slice(1)
  assert.throws(
    () => assertBundleModules(SERVER_BUNDLE, partial),
    (error) => error.message.includes(SERVER_BUNDLE.modules[0]) && !error.message.includes(SERVER_BUNDLE.modules[1]),
  )
  assert.doesNotThrow(() => assertBundleModules(SERVER_BUNDLE, [...SERVER_BUNDLE.modules, 'packages/server/src/other.ts']))
  // 没有声明 modules 的产物（夹具）不被要求。
  assert.doesNotThrow(() => assertBundleModules({ label: 'fixture' }, []))
})

test('the module list of a source bundle is root-relative with forward slashes and covers first-party and third-party inputs', async () => {
  await withWorkspace(workspaceFiles(), async (dir) => {
    const { packages, modules } = await analyzeSourceBundle(dir, CLI_BUNDLE)
    assert.deepEqual([...packages], ['thirdparty'])
    assert.deepEqual([...modules].sort(), [
      'node_modules/thirdparty/index.js',
      'packages/cli/src/main.ts',
      'packages/kernel/src/index.ts',
      'packages/kernel/src/private/internal.ts',
      'packages/kernel/src/sub/leaf.ts',
    ])
    assert.deepEqual(
      missingBundleModules({ modules: ['packages/cli/src/main.ts', 'packages/cli/src/gone.ts'] }, modules),
      ['packages/cli/src/gone.ts'],
    )
  })
})

test('package list diffs name what was added and what was removed', () => {
  assert.deepEqual(diffPackageLists(['a', 'b', 'c'], ['b', 'c', 'd', 'e']), { added: ['d', 'e'], removed: ['a'] })
  assert.deepEqual(diffPackageLists(['a'], ['a']), { added: [], removed: [] })
})

test('the committed Dashboard snapshot is sorted, unique and exactly what the update command writes', async () => {
  const committed = await readFile(join(root, DASHBOARD_SNAPSHOT_FILE), 'utf8')
  const packages = readDashboardSnapshot(root)
  assert.ok(packages.length > 0)
  assert.deepEqual(packages, [...new Set(packages)].sort())
  const created = await mkdtemp(join(tmpdir(), 'tenon-check-audit-snapshot-'))
  try {
    await mkdir(join(created, 'tools'))
    writeDashboardSnapshot(created, new Set(packages))
    assert.equal(await readFile(join(created, DASHBOARD_SNAPSHOT_FILE), 'utf8'), committed)
  } finally {
    await rm(created, { recursive: true, force: true })
  }
})

// 两次真实 Vite 构建各要几秒到十几秒；下面两条共用同一次 dashboardInputs 结果。
let dashboardAnalysis
const analysedDashboard = () => (dashboardAnalysis ??= dashboardInputs(root))

test('the analysed Dashboard third-party packages equal the committed snapshot', async () => {
  const analysed = await analysedDashboard()
  const { added, removed } = diffPackageLists(readDashboardSnapshot(root), analysed)
  assert.ok(
    added.length === 0 && removed.length === 0,
    `the Dashboard bundle's third-party packages changed (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}). `
      + `If that is intended, run \`${UPDATE_DASHBOARD_SNAPSHOT_COMMAND}\` and review the diff of ${DASHBOARD_SNAPSHOT_FILE}.`,
  )
})

// 有 packages/dashboard-app/dist（入库的 Dashboard 产物）的检出里，再对一次独立的真实构建交叉验证；没有时只剩上面的快照。
const dashboardDistExists = existsSync(join(root, 'packages', 'dashboard-app', 'dist', 'index.html'))

test('the analysed Dashboard packages agree with an independent real Vite build', {
  skip: dashboardDistExists ? false : 'packages/dashboard-app/dist is absent; the committed snapshot is the only cross-check here',
}, async () => {
  const analysed = await analysedDashboard()
  const { shipped, loaded } = await dashboardCrossCheckInputs(root)
  // 构建出的代码里确有的包，分析必须都看到（漏报会让 dev-only 白名单放行随产物发布的包）。
  assert.deepEqual([...shipped].filter((name) => !analysed.has(name)).sort(), [], 'shipped by the build but missing from the analysis')
  // 分析里的包必须真的进过这次构建的模块图；字体之类只作资源引入的包没有 JS 模块，不在模块图里，只放行这一类。
  const assetOnlyPackages = ['@fontsource-variable/inter']
  assert.deepEqual(
    [...analysed].filter((name) => !loaded.has(name) && !assetOnlyPackages.includes(name)).sort(),
    [],
    'analysed but never loaded by the build',
  )
  // 交叉验证本身不能退化：读到的 sourcemap 与模块图都要覆盖已知依赖。
  for (const name of ['react', 'react-dom', '@xyflow/react', 'gsap', 'lucide-react']) {
    assert.ok(shipped.has(name), `${name} shipped`)
    assert.ok(loaded.has(name), `${name} loaded`)
  }
})
