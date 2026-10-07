import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectDir } from './discover-support.js'
import { detectVitestVersion, majorOfDeclaredRange, majorOfInstalledVersion } from './vitest-version.js'

let repo = ''
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-vitest-version-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

async function put(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text, 'utf8')
  }
}

const manifest = (field: string, range: string): string => JSON.stringify({ [field]: { vitest: range } })
const installed = (version: string, name = 'vitest'): string => JSON.stringify({ name, version })

function projectDir(rel: string): ProjectDir {
  return { rel, abs: rel === '.' ? repo : join(repo, rel), names: new Set() }
}

describe('majorOfInstalledVersion', () => {
  it.each([
    ['5.0.3', 5], ['4.1.11', 4], ['3.2.7', 3], ['v5.0.0', 5], ['5.0.0-beta.7', 5], ['5.0.0-rc.4', 5], ['10.2.0', 10], [' 3.2.7 ', 3], ['0.34.6', 0],
  ])('%s → %s', (version, major) => { expect(majorOfInstalledVersion(version)).toBe(major) })
  it.each(['', 'latest', '5', '5.0', '^5.0.3', 'x.y.z'])('%j 不是一个确切的版本号 → undefined', (version) => {
    expect(majorOfInstalledVersion(version)).toBeUndefined()
  })
})

describe('majorOfDeclaredRange', () => {
  it.each([
    ['5', 5], ['5.0', 5], ['5.0.3', 5], ['^5.0.3', 5], ['~4.1.0', 4], ['=3.2.7', 3], ['v5', 5], ['5.x', 5], ['5.*', 5], ['^5.0.0-beta.7', 5],
    ['^3', 3], ['npm:vitest@^5.0.0', 5], ['^5.0.0 || ~5.1.0', 5], [' ^4.1.11 ', 4], ['^3.0.0 || ^3.1.0', 3],
  ])('%s → %s', (range, major) => { expect(majorOfDeclaredRange(range)).toBe(major) })
  it.each([
    '', '*', 'x', 'latest', 'next', 'beta', 'workspace:*', 'workspace:^5.0.0', 'catalog:', 'catalog:testing', 'github:vitest-dev/vitest',
    'file:../vitest', 'git+https://github.com/vitest-dev/vitest.git', '>=5', '>=3 <6', '>3', '<5', '3 - 5', '^4 || ^5', '^4.0.0 || ^5.0.0', 'npm:other@^5',
  ])('%j 落不到唯一的主版本 → undefined（宁可不知道，也不猜）', (range) => {
    expect(majorOfDeclaredRange(range)).toBeUndefined()
  })
})

describe('detectVitestVersion', () => {
  it('装了的版本：读 node_modules/vitest/package.json', async () => {
    await put({ 'node_modules/vitest/package.json': installed('5.0.3') })
    expect(await detectVitestVersion(projectDir('.'))).toEqual({ major: 5, source: 'installed', raw: '5.0.3' })
  })

  it('装的版本压过声明：声明 ^4.1 装了 5 就按 5', async () => {
    await put({ 'package.json': manifest('devDependencies', '^4.1.0'), 'node_modules/vitest/package.json': installed('5.0.3') })
    expect(await detectVitestVersion(projectDir('.'))).toMatchObject({ major: 5, source: 'installed' })
  })

  it('没装：读 package.json 声明的范围（devDependencies / dependencies / peerDependencies 都认）', async () => {
    for (const field of ['devDependencies', 'dependencies', 'optionalDependencies', 'peerDependencies']) {
      await put({ 'package.json': manifest(field, '^5.0.3') })
      expect(await detectVitestVersion(projectDir('.')), field).toEqual({ major: 5, source: 'declared', raw: '^5.0.3' })
    }
  })

  it('monorepo：子包没有自己的 node_modules 时用提升到仓库根的那份', async () => {
    await put({ 'node_modules/vitest/package.json': installed('4.1.11'), 'packages/app/package.json': '{ "name": "app" }' })
    expect(await detectVitestVersion(projectDir('packages/app'))).toEqual({ major: 4, source: 'installed', raw: '4.1.11' })
  })

  it('monorepo：子包自己的 node_modules 比仓库根的近，近的说了算', async () => {
    await put({
      'node_modules/vitest/package.json': installed('3.2.7'),
      'packages/app/node_modules/vitest/package.json': installed('5.0.3'),
    })
    expect(await detectVitestVersion(projectDir('packages/app'))).toMatchObject({ major: 5 })
    expect(await detectVitestVersion(projectDir('.'))).toMatchObject({ major: 3 })
  })

  it('monorepo：依赖只声明在根 package.json、哪里都没装，子包按根的声明算', async () => {
    await put({ 'package.json': manifest('devDependencies', '^5.0.0'), 'packages/app/package.json': '{ "name": "app" }' })
    expect(await detectVitestVersion(projectDir('packages/app'))).toEqual({ major: 5, source: 'declared', raw: '^5.0.0' })
  })

  it('子包自己的声明比根的近；子包写的是读不出主版本的写法时，不往上借根的版本凑数', async () => {
    await put({ 'package.json': manifest('devDependencies', '^3.0.0'), 'packages/a/package.json': manifest('devDependencies', '^5.0.0'), 'packages/b/package.json': manifest('devDependencies', 'latest') })
    expect(await detectVitestVersion(projectDir('packages/a'))).toMatchObject({ major: 5 })
    expect(await detectVitestVersion(projectDir('packages/b'))).toBeUndefined()
  })

  it('什么线索都没有 → undefined', async () => {
    await put({ 'package.json': '{ "name": "bare" }' })
    expect(await detectVitestVersion(projectDir('.'))).toBeUndefined()
  })

  it('声明的是 latest / workspace: / catalog: / 开区间 → undefined', async () => {
    for (const range of ['latest', 'workspace:*', 'catalog:', '>=3']) {
      await put({ 'package.json': manifest('devDependencies', range) })
      expect(await detectVitestVersion(projectDir('.')), range).toBeUndefined()
    }
  })

  it('node_modules/vitest 不是 vitest（name 不对）/ 版本号坏了 / JSON 坏了 → 忽略它，退回声明', async () => {
    const declared = { 'package.json': manifest('devDependencies', '^3.2.0') }
    for (const text of [installed('5.0.3', 'not-vitest'), installed('latest'), '{ not json', '[]', JSON.stringify({ name: 'vitest' })]) {
      await put({ ...declared, 'node_modules/vitest/package.json': text })
      expect(await detectVitestVersion(projectDir('.')), text).toEqual({ major: 3, source: 'declared', raw: '^3.2.0' })
    }
  })

  it('node_modules 是软链（pnpm / 测试夹具共用 node_modules）也能读到', async () => {
    await put({ 'shared/node_modules/vitest/package.json': installed('5.0.3'), 'proj/package.json': '{}' })
    await symlink(join(repo, 'shared', 'node_modules'), join(repo, 'proj', 'node_modules'), 'dir')
    expect(await detectVitestVersion(projectDir('proj'))).toMatchObject({ major: 5, source: 'installed' })
  })

  it('不越过仓库根往上找：仓库根之外的 node_modules 不算', async () => {
    await put({ 'node_modules/vitest/package.json': installed('5.0.3'), 'inner/package.json': '{}', 'inner/pkg/package.json': '{}' })
    expect(await detectVitestVersion({ rel: '.', abs: join(repo, 'inner'), names: new Set() })).toBeUndefined()
    expect(await detectVitestVersion({ rel: 'pkg', abs: join(repo, 'inner', 'pkg'), names: new Set() })).toBeUndefined()
  })
})
