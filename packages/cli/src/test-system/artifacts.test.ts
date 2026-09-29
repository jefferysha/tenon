import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectArtifacts, mediaOf } from './artifacts.js'

let root = ''
let runDir = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenon-artifacts-'))
  runDir = join(root, 'run')
  await mkdir(runDir, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

describe('mediaOf', () => {
  it('按扩展名与文件名分类', () => {
    expect(mediaOf('a/shot.PNG')).toBe('image')
    expect(mediaOf('a/video.webm')).toBe('video')
    expect(mediaOf('a/trace.zip')).toBe('trace')
    expect(mediaOf('a/trace-1.zip')).toBe('trace')
    expect(mediaOf('a/index.html')).toBe('html')
    expect(mediaOf('a/results.json')).toBe('json')
    expect(mediaOf('a/junit.xml')).toBe('text')
    expect(mediaOf('a/blob.bin')).toBe('other')
  })
})

describe('collectArtifacts', () => {
  it('目录逐文件展开并复制；HTML 报告入口标 entry；索引路径相对本次运行目录', async () => {
    await put(join(root, 'pkg', 'playwright-report', 'index.html'), '<html/>')
    await put(join(root, 'pkg', 'playwright-report', 'data', 'a.json'), '{}')
    await put(join(root, 'pkg', 'test-results', 'x', 'trace.zip'), 'PK')
    const result = await collectArtifacts({
      repoRoot: root, cwd: join(root, 'pkg'), suiteId: 'e2e', artifactPaths: ['playwright-report', 'test-results'], extraFiles: [], runDir, budget: { used: 0 },
    })
    expect(result.index.map((item) => [item.path, item.media, item.entry === true])).toEqual([
      ['artifacts/e2e/pkg/playwright-report/data/a.json', 'json', false],
      ['artifacts/e2e/pkg/playwright-report/index.html', 'html', true],
      ['artifacts/e2e/pkg/test-results/x/trace.zip', 'trace', false],
    ])
    expect(await readFile(join(runDir, 'artifacts/e2e/pkg/playwright-report/index.html'), 'utf8')).toBe('<html/>')
    expect(result.index[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.truncated).toBe(false)
  })

  it('附件（可在声明的产物目录之外）按真实路径挂接；软链、仓库外文件、缺失文件不进索引', async () => {
    await put(join(root, 'elsewhere', 'shot.png'), 'png')
    await put(join(root, 'outside', 'secret.txt'), 's')
    await symlink(join(root, 'outside'), join(root, 'test-results'), 'dir').catch(() => undefined)
    const repo = join(root, 'repo')
    await mkdir(repo, { recursive: true })
    await put(join(repo, 'shot.png'), 'png')
    await symlink(join(root, 'outside'), join(repo, 'linked'), 'dir')
    const result = await collectArtifacts({
      repoRoot: repo, cwd: repo, suiteId: 'unit', artifactPaths: ['linked'],
      extraFiles: [join(repo, 'shot.png'), join(root, 'elsewhere', 'shot.png'), join(repo, 'missing.png')], runDir, budget: { used: 0 },
    })
    expect(result.index.map((item) => item.path)).toEqual(['artifacts/unit/shot.png'])
    expect([...result.mapped.values()]).toEqual(['artifacts/unit/shot.png'])
  })

  it('单次运行的总量上限：超出的文件跳过并报 truncated', async () => {
    await put(join(root, 'test-results', 'a.bin'), 'x'.repeat(100))
    await put(join(root, 'test-results', 'b.bin'), 'y'.repeat(100))
    const result = await collectArtifacts({
      repoRoot: root, cwd: root, suiteId: 'unit', artifactPaths: ['test-results'], extraFiles: [], runDir, budget: { used: 256 * 1024 * 1024 - 150 },
    })
    expect(result.index).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })
})
