import { describe, expect, it } from 'vitest'
import type { CatalogSuite } from '@tenon/kernel'
import { escapeRegex, planCommand, planRerun, withNativeRetries } from './select.js'

function suite(overrides: Partial<CatalogSuite> = {}): CatalogSuite {
  return {
    id: 'web-unit', kind: 'unit', runner: 'vitest', command: 'npx vitest run', cwd: 'packages/web', timeout_s: 900,
    files: ['src/**/*.test.ts'], covers: ['src/**/*.ts'],
    select: { files: 'npx vitest run {files}', grep: 'npx vitest run -t {pattern}' },
    report: { format: 'vitest-json', path: 'test-results/vitest.json' },
    artifacts: [], env: [], services: [], retries: 0, parallel: false, tags: [], browsers: [],
    ...overrides,
  }
}

describe('planCommand', () => {
  it('full 直接用套件命令', () => {
    expect(planCommand(suite(), { scope: 'full' }, undefined)).toEqual({ command: 'npx vitest run', scope: 'full', selection: [] })
  })

  it('grep：模式做 shell 引用；files：文件换算成相对套件 cwd 并引用', () => {
    expect(planCommand(suite(), { scope: 'grep', pattern: "it's a (test)" }, undefined)).toMatchObject({
      command: "npx vitest run -t 'it'\\''s a (test)'", scope: 'grep', selection: ["it's a (test)"],
    })
    expect(planCommand(suite(), { scope: 'files', files: ['packages/web/src/a b.test.ts', 'packages/web/src/c.test.ts'] }, undefined)).toMatchObject({
      command: "npx vitest run 'src/a b.test.ts' src/c.test.ts", scope: 'files',
    })
  })

  it('套件没有对应的 select 模板 → 退回全量并说明，scope 如实记为 full', () => {
    const bare = suite({ select: undefined })
    expect(planCommand(bare, { scope: 'grep', pattern: 'x' }, undefined)).toMatchObject({ command: 'npx vitest run', scope: 'full', note: expect.stringContaining('select.grep') })
    expect(planCommand(bare, { scope: 'files', files: ['packages/web/src/a.test.ts'] }, undefined)).toMatchObject({ scope: 'full' })
  })

  it('changed：只改了套件自己的测试文件 → 只跑这些；改到源码、没有测试文件、读不到 diff → 全量', () => {
    expect(planCommand(suite(), { scope: 'changed' }, ['packages/web/src/a.test.ts', 'docs/x.md'])).toMatchObject({
      command: 'npx vitest run src/a.test.ts', scope: 'changed', selection: ['packages/web/src/a.test.ts'],
    })
    expect(planCommand(suite(), { scope: 'changed' }, ['packages/web/src/a.test.ts', 'packages/web/src/lib.ts'])).toMatchObject({ scope: 'full', note: expect.stringContaining('源码') })
    expect(planCommand(suite(), { scope: 'changed' }, ['docs/x.md'])).toMatchObject({ scope: 'full' })
    expect(planCommand(suite(), { scope: 'changed' }, undefined)).toMatchObject({ scope: 'full', note: expect.stringContaining('读不到') })
  })
})

describe('planRerun', () => {
  it('优先按用例名（正则转义后拼接），其次按文件；都没有就不能重跑', () => {
    const failed = [{ file: 'packages/web/src/a.test.ts', name: 'adds (1+1)' }, { file: 'packages/web/src/b.test.ts', name: 'x.y' }]
    expect(planRerun(suite(), failed)).toMatchObject({ command: "npx vitest run -t 'adds \\(1\\+1\\)|x\\.y'", scope: 'grep' })
    expect(planRerun(suite({ select: { files: 'npx vitest run {files}' } }), failed)).toMatchObject({
      command: 'npx vitest run src/a.test.ts src/b.test.ts', scope: 'files',
    })
    expect(planRerun(suite({ select: undefined }), failed)).toBeUndefined()
  })

  it('escapeRegex 把元字符当字面量', () => {
    expect(new RegExp(escapeRegex('a.b*c[d]')).test('a.b*c[d]')).toBe(true)
    expect(new RegExp(escapeRegex('a.b*c[d]')).test('aXbbbc')).toBe(false)
  })
})

describe('withNativeRetries', () => {
  it('Playwright 套件补 --retries；已经写了 / 不是 Playwright / 没配重试都不动', () => {
    const playwright = suite({ runner: 'playwright', kind: 'playwright', retries: 2 })
    expect(withNativeRetries(playwright, 'FOO=1 npx playwright test --reporter=json')).toBe('FOO=1 npx playwright test --retries=2 --reporter=json')
    expect(withNativeRetries(playwright, 'npx playwright test --retries=5')).toBe('npx playwright test --retries=5')
    expect(withNativeRetries(playwright, 'npm run e2e')).toBe('npm run e2e')
    expect(withNativeRetries(suite({ retries: 2 }), 'npx vitest run')).toBe('npx vitest run')
    expect(withNativeRetries({ ...playwright, retries: 0 }, 'npx playwright test')).toBe('npx playwright test')
  })
})
