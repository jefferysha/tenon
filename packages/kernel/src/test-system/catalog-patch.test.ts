import { describe, expect, it } from 'vitest'
import { parseTestCatalog } from './catalog.js'
import type { CatalogSuite, TestCatalog } from './catalog-types.js'
import { patchCatalogText } from './catalog-patch.js'

/**
 * 夹具是本仓库 `.tenon/tests/catalog.yaml` 原文的逐字节选（开头说明、分节注释、`profile` 前的多行注释、
 * 带 `${…}` 的命令、flow 字符串、exit-code 报告、基准指标、大段说明注释、服务），复制进测试而不是读真实文件。
 */
const REPO_CATALOG = `# Tenon 仓库自己的测试目录：\`tenon test discover\` 起草，再按仓库真实的验收入口细化。
# 报告、覆盖率与产物只写 test-results/、playwright-report/、coverage/（目录校验强制；这样跑测试不会让候选版本失效）。
# 种类：unit / integration / regression / smoke / typecheck / lint / playwright / benchmark 计入默认策略；
# custom 与带 slow 标签的套件不在默认 verify 里，需要时用 --suite 点名运行。
schema: tenon-test-catalog/v1
# 机器画像口径 coarse = OS + 架构 + 核数 + Node 主版本 + profiles_env（CPU 型号与内存档位不参与）：CI 上同规格的托管运行器
# 会落在不同代的 CPU 上，细口径下每换一代就是一个新画像，已提交的基线永远对不上；粗口径让它们共用 .tenon/tests/baselines/ 里的一份。
profile: coarse
profiles_env:
  - CI
suites:
  # ── 单测 ────────────────────────────────────────────────────────────
  - id: unit
    label: 单测 · packages
    kind: unit
    runner: vitest
    command: npm test -- --reporter=default --reporter=json --outputFile.json=test-results/vitest.json
    timeout_s: 3600
    files:
      - packages/*/src/**/*.test.ts
    covers:
      - packages/*/src/**
      - templates/**
    select:
      files: "npx vitest run {files} --reporter=default --reporter=json --outputFile.json=test-results/vitest.json"
      grep: "npx vitest run -t {pattern} --reporter=default --reporter=json --outputFile.json=test-results/vitest.json"
    report:
      format: vitest-json
      path: test-results/vitest.json
    artifacts:
      - test-results/vitest.json
    tags:
      - vitest
  - id: tools-node
    label: 单测 · tools 脚本
    kind: unit
    runner: node-test
    command: node --test --test-reporter="\${TENON_NODE_TEST_REPORTER:-junit}" --test-reporter-destination=test-results/tools-node.xml $(ls tools/*.node-test.mjs | grep -v -e build-npx-package)
    timeout_s: 1800
    files:
      - tools/*.node-test.mjs
    report:
      format: junit
      path: test-results/tools-node.xml
  # ── 集成 / 冒烟 ─────────────────────────────────────────────────────
  - id: hooks
    label: hook 脚本
    kind: integration
    runner: custom
    command: TENON_TAP_OUT=test-results/hooks.tap bash tools/test-hooks.sh
    timeout_s: 1800
    files:
      - tools/test-hooks.sh
    covers:
      - hooks/**
    report:
      format: tap
      path: test-results/hooks.tap
    artifacts:
      - test-results/hooks.tap
    tags:
      - bash
  - id: adapters
    label: 适配器 conformance
    kind: integration
    runner: custom
    command: TENON_TAP_OUT=test-results/adapters.tap bash tools/test-adapters.sh
    timeout_s: 1800
    files:
      - tools/test-adapters.sh
    report:
      format: tap
      path: test-results/adapters.tap
    artifacts:
      - test-results/adapters.tap
  # ── 类型检查 ────────────────────────────────────────────────────────
  - id: typecheck-packages
    label: 类型检查 · packages
    kind: typecheck
    runner: tsc
    command: npx tsc -b packages/kernel packages/cli
    timeout_s: 1800
    covers:
      - packages/*/src/**
    report:
      format: exit-code
  # ── 基准 ────────────────────────────────────────────────────────────
  - id: bench-status
    label: 基准 · tenon status 耗时
    kind: benchmark
    runner: custom
    command: node tools/bench/status.mjs --json test-results/bench-status.json
    timeout_s: 900
    report:
      format: benchmark-json
      path: test-results/bench-status.json
    artifacts:
      - test-results/bench-status.json
    benchmark:
      runs: 1
      warmup: 0
      metrics:
        - name: status_ms
          unit: ms
          better: lower
          max_regression_pct: 15
          max: 3000
  # 大规模夹具：30 个项目 × 每个 30 个任务（900 个 change，量级取自审计里的真实机器）。三个场景：
  #   snapshot_write_ms  终端里动了一个项目的一个任务之后，页面取到新列表快照要多久。
  #   change_detail_ms   打开一个任务时读它的全部证据。
  - id: bench-snapshot-large
    label: 基准 · dashboard 快照规模
    kind: benchmark
    runner: custom
    command: node tools/bench/snapshot.mjs --json test-results/bench-snapshot-large.json --projects 30
    timeout_s: 1800
    report:
      format: benchmark-json
      path: test-results/bench-snapshot-large.json
    benchmark:
      runs: 1
      warmup: 0
      metrics:
        - name: snapshot_write_ms
          unit: ms
          better: lower
          max: 1500
services:
  - id: dashboard-e2e
    start: node e2e/dashboard/support/serve.mjs
    ready:
      log: dashboard-e2e ready
      timeout_s: 240
    stop: SIGTERM
`

function load(text: string): TestCatalog {
  const parsed = parseTestCatalog(text)
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.line}: ${issue.message}`).join('\n'))
  return parsed.catalog
}

function editSuite(catalog: TestCatalog, id: string, change: Partial<CatalogSuite>): TestCatalog {
  return { ...catalog, suites: catalog.suites.map((suite) => (suite.id === id ? { ...suite, ...change } : suite)) }
}

function suiteOf(catalog: TestCatalog, id: string): CatalogSuite {
  const found = catalog.suites.find((suite) => suite.id === id)
  if (found === undefined) throw new Error(`夹具里没有套件 ${id}`)
  return found
}

const comments = (text: string): string[] => text.split('\n').filter((line) => line.trimStart().startsWith('#'))
const NEW_SUITE: CatalogSuite = {
  id: 'lint-extra', label: '额外检查', kind: 'lint', runner: 'custom', command: 'npm run check:extra', cwd: '.', timeout_s: 600,
  files: [], covers: ['docs/**'], report: { format: 'exit-code' }, artifacts: [], env: [], services: [], retries: 0,
  parallel: false, tags: ['static'], browsers: [],
}

describe('patchCatalogText：夹具本身', () => {
  it('夹具是合法目录，且不改动时原样返回', () => {
    const catalog = load(REPO_CATALOG)
    expect(catalog.suites.map((suite) => suite.id)).toEqual(['unit', 'tools-node', 'hooks', 'adapters', 'typecheck-packages', 'bench-status', 'bench-snapshot-large'])
    expect(patchCatalogText(REPO_CATALOG, catalog, catalog)).toBe(REPO_CATALOG)
  })
})

describe('patchCatalogText：保留未改动的内容', () => {
  it('1. 改 unit.command：逐行比较只有这一行不同，所有 # 注释行保留', () => {
    const before = load(REPO_CATALOG)
    const patched = patchCatalogText(REPO_CATALOG, before, editSuite(before, 'unit', { command: 'npm test' }))
    const old = REPO_CATALOG.split('\n')
    const next = patched.split('\n')
    expect(next).toHaveLength(old.length)
    const differing = old.flatMap((line, index) => (line === next[index] ? [] : [index]))
    expect(differing).toHaveLength(1)
    expect(next[differing[0] ?? -1]).toBe('    command: npm test')
    expect(comments(patched)).toEqual(comments(REPO_CATALOG))
  })

  it('2. 新增套件：出现在 suites 末尾，新增行之前与之后的原文逐字都在', () => {
    const before = load(REPO_CATALOG)
    const after: TestCatalog = { ...before, suites: [...before.suites, NEW_SUITE] }
    const patched = patchCatalogText(REPO_CATALOG, before, after)
    const head = REPO_CATALOG.slice(0, REPO_CATALOG.indexOf('services:\n'))
    const tail = REPO_CATALOG.slice(REPO_CATALOG.indexOf('services:\n'))
    expect(patched.startsWith(head)).toBe(true)
    expect(patched.endsWith(tail)).toBe(true)
    expect(patched.slice(head.length, patched.length - tail.length)).toBe([
      '  - id: lint-extra', '    label: 额外检查', '    kind: lint', '    runner: custom', '    command: npm run check:extra',
      '    timeout_s: 600', '    covers:', '      - docs/**', '    report:', '      format: exit-code', '    tags:', '      - static', '',
    ].join('\n'))
    expect(load(patched).suites.at(-1)).toEqual(NEW_SUITE)
  })

  it('3. 删除中间的套件：分节注释保留，只少了它自己的行', () => {
    const before = load(REPO_CATALOG)
    const after: TestCatalog = { ...before, suites: before.suites.filter((suite) => suite.id !== 'hooks') }
    const patched = patchCatalogText(REPO_CATALOG, before, after)
    const old = REPO_CATALOG.split('\n')
    const start = old.indexOf('  - id: hooks')
    const end = old.indexOf('  - id: adapters')
    expect(patched.split('\n')).toEqual([...old.slice(0, start), ...old.slice(end)])
    expect(patched).toContain('  # ── 集成 / 冒烟 ')
    expect(load(patched).suites.map((suite) => suite.id)).not.toContain('hooks')
  })

  it('删除套件时它后面的分节注释留给下一个节点，不被一起删掉', () => {
    const before = load(REPO_CATALOG)
    const after: TestCatalog = { ...before, suites: before.suites.filter((suite) => suite.id !== 'adapters') }
    const patched = patchCatalogText(REPO_CATALOG, before, after)
    expect(comments(patched)).toEqual(comments(REPO_CATALOG))
    expect(patched).not.toContain('id: adapters')
  })

  it('4. 给 unit.files 追加一项：只多一行，原有行一行不少', () => {
    const before = load(REPO_CATALOG)
    const unit = suiteOf(before, 'unit')
    const patched = patchCatalogText(REPO_CATALOG, before, editSuite(before, 'unit', { files: [...unit.files, 'tools/x.test.mjs'] }))
    const old = REPO_CATALOG.split('\n')
    const next = patched.split('\n')
    expect(next).toHaveLength(old.length + 1)
    const at = old.indexOf('      - packages/*/src/**/*.test.ts') + 1
    expect(next).toEqual([...old.slice(0, at), '      - tools/x.test.mjs', ...old.slice(at)])
  })

  it('5. 加 not_applicable / levels 顶层键：追加在文件末尾，原文不变', () => {
    const before = load(REPO_CATALOG)
    const after: TestCatalog = {
      ...before,
      not_applicable: [{ kind: 'e2e', reason: '没有前端', approved_by: null }],
      levels: { full: { coverage: { lines: 80 } } },
    }
    const patched = patchCatalogText(REPO_CATALOG, before, after)
    expect(patched.startsWith(REPO_CATALOG)).toBe(true)
    expect(patched.slice(REPO_CATALOG.length)).toBe([
      'not_applicable:', '  - kind: e2e', '    reason: 没有前端', '    approved_by: null', 'levels:', '  full:', '    coverage:', '      lines: 80', '',
    ].join('\n'))
    expect(load(patched)).toEqual(after)
  })

  it('改套件里嵌套的基准指标：只替换 benchmark 这个键的行区间', () => {
    const before = load(REPO_CATALOG)
    const bench = suiteOf(before, 'bench-status')
    const metric = bench.benchmark?.metrics[0]
    if (bench.benchmark === undefined || metric === undefined) throw new Error('夹具缺基准')
    const after = editSuite(before, 'bench-status', { benchmark: { ...bench.benchmark, metrics: [{ ...metric, max: 5000 }] } })
    const patched = patchCatalogText(REPO_CATALOG, before, after)
    expect(patched.split('\n')).toEqual(REPO_CATALOG.split('\n').map((line) => (line === '          max: 3000' ? '          max: 5000' : line)))
  })

  it('删除一个键：只去掉它自己的行（套件的 tags）', () => {
    const before = load(REPO_CATALOG)
    const patched = patchCatalogText(REPO_CATALOG, before, editSuite(before, 'hooks', { tags: [] }))
    const old = REPO_CATALOG.split('\n')
    const at = old.indexOf('  - id: hooks')
    const tags = old.indexOf('    tags:', at)
    expect(patched.split('\n')).toEqual([...old.slice(0, tags), ...old.slice(tags + 2)])
  })

  it('给没有的键新增：追加在套件条目末尾（adapters 的 covers）', () => {
    const before = load(REPO_CATALOG)
    const patched = patchCatalogText(REPO_CATALOG, before, editSuite(before, 'adapters', { covers: ['adapters/**'] }))
    const old = REPO_CATALOG.split('\n')
    const at = old.indexOf('      - test-results/adapters.tap') + 1
    expect(patched.split('\n')).toEqual([...old.slice(0, at), '    covers:', '      - adapters/**', ...old.slice(at)])
  })

  it('原文显式写着等于默认值的键（cwd: .）：改别的键不动它；改它自己则只替换那一行', () => {
    const text = 'schema: tenon-test-catalog/v1\nsuites:\n  - id: a\n    kind: unit\n    runner: vitest\n    command: npm test\n    cwd: .\n    report:\n      format: junit\n      path: test-results/a.xml\n'
    const before = load(text)
    expect(patchCatalogText(text, before, editSuite(before, 'a', { command: 'npm run t' }))).toBe(text.replace('command: npm test', 'command: npm run t'))
    expect(patchCatalogText(text, before, editSuite(before, 'a', { cwd: 'sub' }))).toBe(text.replace('cwd: .', 'cwd: sub'))
  })

  it('行内 flow 写法：flow 列表追加项时整个键换成块式；flow 的 not_applicable 条目被改时只换这一条', () => {
    const text = [
      'schema: tenon-test-catalog/v1', '# 套件', 'suites:',
      '  - id: a', '    kind: unit', '    runner: vitest', '    command: npm test', '    files: ["src/**/*.test.ts"]',
      '    report: { format: junit, path: test-results/a.xml }',
      '# 不适用', 'not_applicable:',
      '  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }',
      '  - { kind: e2e, reason: 没有前端, approved_by: null }', '',
    ].join('\n')
    const before = load(text)
    const files = patchCatalogText(text, before, editSuite(before, 'a', { files: ['src/**/*.test.ts', 'tools/x.test.mjs'] }))
    expect(files).toBe(text.replace('    files: ["src/**/*.test.ts"]', '    files:\n      - src/**/*.test.ts\n      - tools/x.test.mjs'))
    const approved: TestCatalog = { ...before, not_applicable: before.not_applicable?.map((entry) => (entry.kind === 'typecheck' ? { ...entry, approved_by: 'a@x.io' } : entry)) }
    const patched = patchCatalogText(text, before, approved)
    expect(patched).toBe(text.replace('  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }', '  - kind: typecheck\n    reason: 纯 JavaScript 项目\n    approved_by: a@x.io'))
  })

  it('空 suites: [] 里加第一个套件；原来没有 suites 键也行', () => {
    const empty = 'schema: tenon-test-catalog/v1\n# 还没有套件\nsuites: []\n'
    const patched = patchCatalogText(empty, load(empty), { ...load(empty), suites: [NEW_SUITE] })
    expect(patched.startsWith('schema: tenon-test-catalog/v1\n# 还没有套件\nsuites:\n  - id: lint-extra\n')).toBe(true)
    expect(load(patched).suites).toEqual([NEW_SUITE])
    const bare = 'schema: tenon-test-catalog/v1\n'
    const added = patchCatalogText(bare, load(bare), { ...load(bare), suites: [NEW_SUITE] })
    expect(added.startsWith(bare)).toBe(true)
    expect(load(added).suites).toEqual([NEW_SUITE])
  })

  it('套件顺序变了：退回整个 suites 键重写，仍与预期一致', () => {
    const before = load(REPO_CATALOG)
    const after: TestCatalog = { ...before, suites: [...before.suites].reverse() }
    const patched = patchCatalogText(REPO_CATALOG, before, after)
    expect(load(patched).suites.map((suite) => suite.id)).toEqual([...before.suites].reverse().map((suite) => suite.id))
    expect(patched.startsWith(REPO_CATALOG.slice(0, REPO_CATALOG.indexOf('suites:\n')))).toBe(true)
    expect(patched.endsWith(REPO_CATALOG.slice(REPO_CATALOG.indexOf('services:\n')))).toBe(true)
  })

  it('同时新增、修改、删除多个节点：互不干扰', () => {
    const before = load(REPO_CATALOG)
    const unit = suiteOf(before, 'unit')
    const edited = editSuite(before, 'unit', { command: 'npm run unit', files: [...unit.files, 'tools/x.test.mjs'] })
    const after: TestCatalog = {
      ...edited,
      suites: [...edited.suites.filter((suite) => suite.id !== 'tools-node'), NEW_SUITE],
      profiles_env: ['CI', 'GITHUB_ACTIONS'],
    }
    const patched = patchCatalogText(REPO_CATALOG, before, after)
    expect(load(patched)).toEqual(after)
    expect(comments(patched)).toEqual(comments(REPO_CATALOG))
    expect(patched).toContain('  - GITHUB_ACTIONS\n')
  })
})

describe('patchCatalogText：字节级保留（Review Focus 1）', () => {
  const BASE = [
    '# 说明', 'schema: tenon-test-catalog/v1', 'suites:', '  # 单测',
    '  - id: a', '    kind: unit', '    runner: vitest', '    command: npm test', '    files:', '      - src/**/*.test.ts',
    '    report:', '      format: junit', '      path: test-results/a.xml', '  - id: b', '    kind: lint', '    runner: custom',
    '    command: npm run lint', '    report:', '      format: exit-code',
  ]
  const change = (catalog: TestCatalog): TestCatalog => editSuite(catalog, 'a', { command: 'npm run unit' })

  it('CRLF：改一行与追加行都沿用 \\r\\n，其余字节不变', () => {
    const text = `${BASE.join('\r\n')}\r\n`
    const before = load(text)
    expect(patchCatalogText(text, before, change(before))).toBe(text.replace('command: npm test\r\n', 'command: npm run unit\r\n'))
    const appended = patchCatalogText(text, before, editSuite(before, 'a', { files: ['src/**/*.test.ts', 'tools/x.test.mjs'] }))
    expect(appended).toBe(text.replace('      - src/**/*.test.ts\r\n', '      - src/**/*.test.ts\r\n      - tools/x.test.mjs\r\n'))
    expect(appended.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('行尾空格：没动的行连同尾部空格原样保留', () => {
    const text = `${BASE.map((line) => `${line}  `).join('\n')}\n`
    const before = load(text)
    const patched = patchCatalogText(text, before, change(before))
    expect(patched).toBe(text.replace('command: npm test  \n', 'command: npm run unit\n'))
  })

  it('没有结尾换行：改最后一个套件的键后仍没有结尾换行；在末尾追加也不多出换行', () => {
    const text = BASE.join('\n')
    const before = load(text)
    const lastEdit = patchCatalogText(text, before, editSuite(before, 'b', { command: 'npm run lint:all' }))
    expect(lastEdit).toBe(text.replace('command: npm run lint', 'command: npm run lint:all'))
    expect(lastEdit.endsWith('\n')).toBe(false)
    const withKey = patchCatalogText(text, before, { ...before, profiles_env: ['CI'] })
    expect(withKey).toBe(`${text}\nprofiles_env:\n  - CI`)
    const added = patchCatalogText(text, before, { ...before, suites: [...before.suites, NEW_SUITE] })
    expect(added.startsWith(`${text}\n  - id: lint-extra\n`)).toBe(true)
    expect(added.endsWith('\n')).toBe(false)
    expect(load(added).suites.at(-1)).toEqual(NEW_SUITE)
  })

  it('没有结尾换行时，被改的恰好是最后一行：新的最后一行仍然没有换行（CRLF 文件同理）', () => {
    const lines = ['schema: tenon-test-catalog/v1', 'suites:', '  - id: a', '    kind: unit', '    runner: vitest', '    report:', '      format: junit', '      path: test-results/a.xml', '    command: npm test']
    for (const eol of ['\n', '\r\n']) {
      const text = lines.join(eol)
      const before = load(text)
      const patched = patchCatalogText(text, before, editSuite(before, 'a', { command: 'npm run unit' }))
      expect(patched).toBe(text.replace('command: npm test', 'command: npm run unit'))
      expect(patched.endsWith(eol)).toBe(false)
    }
  })

  it('--- 开头的目录：文档起始标记与其余字节不变', () => {
    const text = `---\n${BASE.join('\n')}\n`
    const before = load(text)
    expect(patchCatalogText(text, before, change(before))).toBe(text.replace('command: npm test', 'command: npm run unit'))
  })
})

describe('patchCatalogText：边界写法', () => {
  const HEAD = 'schema: tenon-test-catalog/v1\n'
  const suiteLines = (id: string, extra: readonly string[] = []): string[] => [
    `  - id: ${id}`, '    kind: unit', '    runner: vitest', '    command: npm test', ...extra, '    report:', '      format: junit', `      path: test-results/${id}.xml`,
  ]

  it('列表与键同列（suites: 下一行就是 - id:）：新增条目与新键沿用原有缩进', () => {
    const text = `${HEAD}suites:\n- id: a\n  kind: unit\n  runner: vitest\n  command: npm test\n  report:\n    format: junit\n    path: test-results/a.xml\n`
    const before = load(text)
    const edited = editSuite(before, 'a', { retries: 1 })
    const after: TestCatalog = { ...edited, suites: [...edited.suites, NEW_SUITE] }
    const patched = patchCatalogText(text, before, after)
    expect(patched).toBe(`${text}  retries: 1\n${[
      '- id: lint-extra', '  label: 额外检查', '  kind: lint', '  runner: custom', '  command: npm run check:extra', '  timeout_s: 600',
      '  covers:', '    - docs/**', '  report:', '    format: exit-code', '  tags:', '    - static', '',
    ].join('\n')}`)
    expect(load(patched)).toEqual(after)
  })

  it('第一个键不是 id：改它保住 "- " 前缀；删掉它则这一条整条重写，其余套件不动', () => {
    const text = `${HEAD}suites:\n  # 单测\n  - label: 单测\n    id: a\n    kind: unit\n    runner: vitest\n    command: npm test\n    report:\n      format: junit\n      path: test-results/a.xml\n${suiteLines('b').join('\n')}\n`
    const before = load(text)
    expect(patchCatalogText(text, before, editSuite(before, 'a', { label: '全部单测' }))).toBe(text.replace('- label: 单测', '- label: 全部单测'))
    const dropped = patchCatalogText(text, before, editSuite(before, 'a', { label: undefined }))
    expect(dropped.startsWith(`${HEAD}suites:\n  # 单测\n  - id: a\n    kind: unit\n`)).toBe(true)
    expect(dropped.endsWith(`${suiteLines('b').join('\n')}\n`)).toBe(true)
    expect(load(dropped)).toEqual(editSuite(before, 'a', { label: undefined }))
  })

  it('条目内部夹着注释：改别的键不动这些注释；删除整条则带走它们', () => {
    const text = `${HEAD}suites:\n${suiteLines('a', ['    # 为什么这样跑', '    timeout_s: 60']).join('\n')}\n  # 下一节\n${suiteLines('b').join('\n')}\n`
    const before = load(text)
    expect(patchCatalogText(text, before, editSuite(before, 'a', { command: 'npm run t' }))).toBe(text.replace('command: npm test\n    # 为什么', 'command: npm run t\n    # 为什么'))
    const removed = patchCatalogText(text, before, { ...before, suites: before.suites.filter((suite) => suite.id !== 'a') })
    expect(removed).toBe(`${HEAD}suites:\n  # 下一节\n${suiteLines('b').join('\n')}\n`)
  })

  it('删除最后一个套件的同时新增一个：相邻的两处改动互不覆盖', () => {
    const text = `${HEAD}suites:\n${suiteLines('a').join('\n')}\n${suiteLines('b').join('\n')}\n# 服务\nservices: []\n`
    const before = load(text)
    const after: TestCatalog = { ...before, suites: [...before.suites.filter((suite) => suite.id !== 'b'), NEW_SUITE] }
    const patched = patchCatalogText(text, before, after)
    expect(patched.startsWith(`${HEAD}suites:\n${suiteLines('a').join('\n')}\n  - id: lint-extra\n`)).toBe(true)
    expect(patched.endsWith('# 服务\nservices: []\n')).toBe(true)
    expect(load(patched)).toEqual(after)
  })

  it('files 不是单纯在末尾追加（删了一项 / 插在中间）：只换 files 这个键，条目其余行不动', () => {
    const lines = suiteLines('a', ['    files:', '      - a/**/*.test.ts', '      - "b/**/*.test.ts"', '    timeout_s: 60'])
    const text = `${HEAD}suites:\n${lines.join('\n')}\n`
    const before = load(text)
    const removed = patchCatalogText(text, before, editSuite(before, 'a', { files: ['b/**/*.test.ts'] }))
    expect(removed).toBe(text.replace('      - a/**/*.test.ts\n      - "b/**/*.test.ts"\n', '      - b/**/*.test.ts\n'))
    const inserted = patchCatalogText(text, before, editSuite(before, 'a', { files: ['a/**/*.test.ts', 'c/**/*.test.ts', 'b/**/*.test.ts'] }))
    expect(inserted).toBe(text.replace('      - a/**/*.test.ts\n      - "b/**/*.test.ts"\n', '      - a/**/*.test.ts\n      - c/**/*.test.ts\n      - b/**/*.test.ts\n'))
  })

  it('services 里的条目与它的 env 列表同样只改变化的行', () => {
    const text = `${HEAD}services:\n  # 前端服务\n  - id: web\n    start: node web.mjs\n    ready:\n      port: 3000\n    env:\n      - A\n  - id: api\n    start: node api.mjs\n    ready:\n      port: 4000\n`
    const before = load(text)
    const web = before.services[0]
    if (web === undefined) throw new Error('夹具缺服务')
    const after: TestCatalog = { ...before, services: [{ ...web, env: ['A', 'B'] }, ...before.services.slice(1)] }
    expect(patchCatalogText(text, before, after)).toBe(text.replace('      - A\n', '      - A\n      - B\n'))
  })

  it('混合换行符：没动的行保持各自的换行符，新增行用文件开头那种', () => {
    const text = `schema: tenon-test-catalog/v1\r\nsuites:\r\n  - id: a\n    kind: unit\r\n    runner: vitest\n    command: npm test\r\n    report:\n      format: junit\r\n      path: test-results/a.xml\n`
    const before = load(text)
    const patched = patchCatalogText(text, before, editSuite(before, 'a', { retries: 2 }))
    expect(patched).toBe(`${text}    retries: 2\r\n`)
  })
})

describe('patchCatalogText：写回后重新解析并与预期一致', () => {
  it('7. 各种改动写回后的文本解析出来与 after 深相等', () => {
    const before = load(REPO_CATALOG)
    const unit = suiteOf(before, 'unit')
    const variants: TestCatalog[] = [
      editSuite(before, 'unit', { command: 'npm run unit', timeout_s: 120, retries: 2, parallel: true }),
      editSuite(before, 'unit', { files: [...unit.files, 'a/b.test.ts'], covers: [] }),
      { ...before, suites: before.suites.filter((suite) => suite.id !== 'unit') },
      { ...before, suites: [], services: [] },
      { ...before, profile: undefined, profiles_env: [] },
      { ...before, services: [...before.services, { id: 'api', start: 'node api.mjs', cwd: '.', ready: { port: 3000, timeout_s: 60 }, stop: 'SIGTERM', env: ['API_KEY'] }] },
    ]
    for (const after of variants) expect(load(patchCatalogText(REPO_CATALOG, before, after))).toEqual(after)
  })

  it('改出不合法的目录：抛错（调用方不写盘）', () => {
    const before = load(REPO_CATALOG)
    const bad = editSuite(before, 'unit', { report: { format: 'vitest-json', path: 'src/escape.json' } })
    expect(() => patchCatalogText(REPO_CATALOG, before, bad)).toThrow(/目录|test-results/)
  })

  it('before 与原文对不上：抛错，不凭猜测改文件', () => {
    const before = load(REPO_CATALOG)
    const stale = editSuite(before, 'unit', { command: '别人刚改过的命令' })
    expect(() => patchCatalogText(REPO_CATALOG, stale, editSuite(before, 'unit', { command: 'x' }))).toThrow(/不一致/)
  })

  it('原文本身不合法：抛错', () => {
    const before = load(REPO_CATALOG)
    expect(() => patchCatalogText('schema: nope\n', before, before)).toThrow(/无法解析/)
  })
})
