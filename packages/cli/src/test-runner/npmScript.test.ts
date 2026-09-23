import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { npmScriptOf, unconfiguredMessage, unconfiguredNpmScript } from './npmScript.js'

describe('npmScriptOf：只认得出的 npm 脚本调用', () => {
  test.each([
    ['npm test', 'test'],
    ['npm t', 'test'],
    ['npm run test:integration', 'test:integration'],
    ['npm run-script bench -- --json', 'bench'],
    ['  npm run typecheck  ', 'typecheck'],
  ])('%s → %s', (command, script) => {
    expect(npmScriptOf(command)).toBe(script)
  })

  test.each([
    'npx playwright test',
    'npm run',
    'npm run --silent test',
    'npm ci',
    'npm run test && npm run lint',
    'pytest -q',
    'npm run test | tee log',
  ])('%s → 不判', (command) => {
    expect(npmScriptOf(command)).toBeUndefined()
  })
})

describe('unconfiguredNpmScript', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenon-npm-script-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const probe = (command: string, cwd = '.') => unconfiguredNpmScript(root, { command, cwd })

  test('脚本存在 → 已配置', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    expect(await probe('npm test')).toBeUndefined()
  })

  test('脚本缺失 → 未配置（点名脚本与 package.json）', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    const gap = await probe('npm run test:integration')
    expect(gap).toEqual({ script: 'test:integration', packageJson: 'package.json', missingPackageJson: false })
    const message = unconfiguredMessage('integration', 'npm run test:integration', gap!)
    expect(message).toContain('test-unconfigured，不是失败')
    expect(message).toContain("package.json 的 scripts 里没有 'test:integration'")
    expect(message).toContain('不要复制其它测试的命令凑数')
    expect(message).toContain('只对之后新建的任务生效')
  })

  test('没有 package.json → 未配置；按测试 cwd 找', async () => {
    await mkdir(join(root, 'web'))
    expect(await probe('npm test', 'web')).toEqual({ script: 'test', packageJson: 'web/package.json', missingPackageJson: true })
    await writeFile(join(root, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
    expect(await probe('npm test', 'web')).toBeUndefined()
  })

  test('package.json 坏掉或命令不是 npm 脚本 → 不判（照常执行，由执行结果说话）', async () => {
    await writeFile(join(root, 'package.json'), '{ not json')
    expect(await probe('npm run test:integration')).toBeUndefined()
    expect(await probe('npx playwright test')).toBeUndefined()
  })
})
