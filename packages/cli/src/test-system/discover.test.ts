import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatCatalogIssues, parseTestCatalog, serializeTestCatalog } from '@tenon/kernel'
import { discoverTests } from './discover.js'
import { emptyCatalog } from './project-files.js'

let repo = ''
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-discover-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

async function put(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text, 'utf8')
  }
}

async function ids(): Promise<string[]> {
  return (await discoverTests(repo)).suites.map((item) => item.suite.id)
}

describe('discoverTests', () => {
  it('空项目：没有建议，提示手工登记', async () => {
    const result = await discoverTests(repo)
    expect(result.suites).toEqual([])
    expect(result.notes.join('\n')).toContain('tenon test catalog add')
  })

  it('vitest + Playwright + tsc + lint：每个建议的套件都能通过目录校验（写出再解析）', async () => {
    await put({
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', bench: 'node bench.mjs' }, devDependencies: { vitest: '3', typescript: '5' } }),
      'vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts', 'lib/**/*.test.ts'] } }",
      'playwright.config.ts': "export default { testDir: './e2e', projects: [{ name: 'chromium' }, { name: 'webkit' }] }",
    })
    const result = await discoverTests(repo)
    expect(result.suites.map((item) => item.suite.id).sort()).toEqual(['e2e', 'lint', 'typecheck', 'unit'])
    const unit = result.suites.find((item) => item.suite.id === 'unit')?.suite
    expect(unit).toMatchObject({ runner: 'vitest', files: ['src/**/*.test.ts', 'lib/**/*.test.ts'], report: { format: 'vitest-json' } })
    expect(unit?.command).toContain('--outputFile.json=test-results/vitest.json')
    const e2e = result.suites.find((item) => item.suite.id === 'e2e')?.suite
    expect(e2e).toMatchObject({ kind: 'playwright', browsers: ['chromium', 'webkit'], files: ['e2e/**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'] })
    expect(e2e?.command).toContain('PLAYWRIGHT_HTML_OPEN=never')
    expect(result.notes.join('\n')).toContain('基准脚本')
    const text = serializeTestCatalog({ ...emptyCatalog(), suites: result.suites.map((item) => item.suite) })
    const parsed = parseTestCatalog(text)
    expect(parsed.ok, parsed.ok ? '' : formatCatalogIssues(parsed.issues).join('\n')).toBe(true)
  })

  it('Playwright 自带 webServer：给提示，不重复启动', async () => {
    await put({ 'playwright.config.ts': "export default { webServer: { command: 'npm run dev', url: 'http://localhost:5173' } }" })
    const result = await discoverTests(repo)
    expect(result.notes.join('\n')).toContain('webServer')
  })

  it('monorepo：子包各自识别，id 带目录前缀；纯工作区根不产出套件', async () => {
    await put({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/web/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'packages/web/vitest.config.ts': 'export default {}',
      'packages/api/package.json': JSON.stringify({ devDependencies: { jest: '29' } }),
    })
    expect((await ids()).sort()).toEqual(['api-unit', 'web-unit'])
    const web = (await discoverTests(repo)).suites.find((item) => item.suite.id === 'web-unit')?.suite
    expect(web?.cwd).toBe('packages/web')
  })

  it('jest / mocha / node:test / pytest / go 各识别一个；cargo 与 cypress 只给提示', async () => {
    await put({
      'jest/package.json': JSON.stringify({ devDependencies: { jest: '29' } }),
      'mocha/package.json': JSON.stringify({ devDependencies: { mocha: '10' } }),
      'nodetest/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'py/pytest.ini': '[pytest]\n',
      'go/go.mod': 'module example.com/x\n',
      'rs/Cargo.toml': '[package]\nname = "x"\n',
      'cy/package.json': '{}',
      'cy/cypress.config.ts': 'export default {}',
    })
    const result = await discoverTests(repo)
    expect(result.suites.map((item) => [item.suite.id, item.suite.runner, item.suite.report.format]).sort()).toEqual([
      ['go-go-test', 'go', 'go-json'], ['jest-unit', 'jest', 'jest-json'], ['mocha-unit', 'mocha', 'junit'],
      ['nodetest-unit', 'node-test', 'junit'], ['py-pytest', 'pytest', 'junit'],
    ])
    expect(result.notes.join('\n')).toContain('cargo-nextest')
    expect(result.notes.join('\n')).toContain('Cypress')
    const text = serializeTestCatalog({ ...emptyCatalog(), suites: result.suites.map((item) => item.suite) })
    expect(parseTestCatalog(text).ok).toBe(true)
  })

  it('跳过 node_modules / dist / .tenon 等目录；同 id 冲突自动加序号', async () => {
    await put({
      'node_modules/pkg/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'dist/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'a/x/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
      'b/x/package.json': JSON.stringify({ devDependencies: { vitest: '3' } }),
    })
    expect((await ids()).sort()).toEqual(['x-unit', 'x-unit-2'])
  })
})
