import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DELETED_DIGEST, protectedChangesSinceChangeStart, protectedFileBlockers, protectedKindOf, protectedOrigin,
  readProtectedChanges, type ProtectedChange,
} from './protected-files.js'
import { EMPTY_TEST_SEAL, type TestSeal } from './seal.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function git(root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync('git', [...args], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  })
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

/** 起点提交（2026-01-01）已含目录、一份基线、已知失败清单和默认工作流；任务创建于 2026-06-01。 */
async function projectAtStart(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-protected-'))
  roots.push(root)
  git(root, ['init', '-q', '-b', 'main'])
  await put(root, '.tenon/tests/catalog.yaml', 'schema: tenon-test-catalog/v1\nsuites: []\n')
  await put(root, '.tenon/tests/baselines/bench/darwin.json', '{"v":1}\n')
  await put(root, '.tenon/tests/known-failures.yaml', 'schema: tenon-known-failures/v1\nentries: []\n')
  await put(root, '.pipeline/workflows/default.yaml', 'id: default\n')
  await put(root, 'src/app.ts', 'export const a = 1\n')
  const date = '2026-01-01T00:00:00Z'
  git(root, ['add', '-A'])
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@x.io', 'commit', '-q', '-m', 'base'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  return root
}

const START = { baseBranch: '', createdAt: '2026-06-01T00:00:00Z' }

describe('protectedKindOf', () => {
  it.each([
    ['.tenon/tests/catalog.yaml', 'catalog'],
    ['.tenon/tests/known-failures.yaml', 'known-failures'],
    ['.tenon/tests/baselines/bench/darwin.json', 'baseline'],
    ['.pipeline/workflows/default.yaml', 'workflow'],
    ['.pipeline/workflows/custom.yml', 'workflow'],
  ])('%s → %s', (path, kind) => {
    expect(protectedKindOf(path)).toBe(kind)
  })

  it.each([
    'src/app.ts', '.tenon/tests/other.yaml', '.pipeline/workflows/nested/x.yaml', '.pipeline/tracks.yaml',
    '.pipeline/workflows/default.md', 'docs/known-failures.yaml',
  ])('%s 不是受保护配置', (path) => {
    expect(protectedKindOf(path)).toBeUndefined()
  })
})

describe('本任务 diff 里的受保护改动', () => {
  it('新增、修改、删除都列出；无关文件与没变的文件不列', async () => {
    const root = await projectAtStart()
    await put(root, '.tenon/tests/known-failures.yaml', 'schema: tenon-known-failures/v1\nentries:\n  - suite: u\n')
    await put(root, '.tenon/tests/baselines/bench/linux.json', '{"v":2}\n')
    await rm(join(root, '.tenon/tests/baselines/bench/darwin.json'))
    await put(root, '.pipeline/workflows/extra.yaml', 'id: extra\n')
    await put(root, 'src/app.ts', 'export const a = 2\n')
    const changes = await protectedChangesSinceChangeStart(root, START)
    expect(changes.map((item) => [item.path, item.kind, item.status])).toEqual([
      ['.pipeline/workflows/extra.yaml', 'workflow', 'added'],
      ['.tenon/tests/baselines/bench/darwin.json', 'baseline', 'deleted'],
      ['.tenon/tests/baselines/bench/linux.json', 'baseline', 'added'],
      ['.tenon/tests/known-failures.yaml', 'known-failures', 'modified'],
    ])
    expect(changes.find((item) => item.status === 'deleted')?.digest).toBe(DELETED_DIGEST)
    expect(changes.find((item) => item.path.endsWith('linux.json'))?.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('没有改动就没有条目；新增又删掉不算改动', async () => {
    const root = await projectAtStart()
    expect(await protectedChangesSinceChangeStart(root, START)).toEqual([])
    await put(root, '.tenon/tests/baselines/tmp.json', '{}\n')
    await rm(join(root, '.tenon/tests/baselines/tmp.json'))
    expect(await protectedChangesSinceChangeStart(root, START)).toEqual([])
  })

  it('不是 git 仓库：抛错（调用方失败关闭）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-protected-nogit-'))
    roots.push(root)
    await expect(protectedChangesSinceChangeStart(root, START)).rejects.toThrow(/git/)
  })

  it('readProtectedChanges 对相同内容给相同摘要，内容变了摘要就变', async () => {
    const root = await projectAtStart()
    const path = '.tenon/tests/known-failures.yaml'
    const [first] = await readProtectedChanges(root, [{ path, status: 'modified' }])
    await put(root, path, 'x\n')
    const [second] = await readProtectedChanges(root, [{ path, status: 'modified' }])
    expect(first?.digest).not.toBe(second?.digest)
    expect((await readProtectedChanges(root, [{ path: 'src/app.ts', status: 'modified' }]))).toEqual([])
  })
})

describe('人工确认判定', () => {
  const kf: ProtectedChange = { path: '.tenon/tests/known-failures.yaml', kind: 'known-failures', status: 'modified', digest: 'sha256:aaa' }
  const catalog: ProtectedChange = { path: '.tenon/tests/catalog.yaml', kind: 'catalog', status: 'modified', digest: 'sha256:ccc' }
  const sealWith = (patch: Partial<TestSeal>): TestSeal => ({ ...EMPTY_TEST_SEAL, ...patch })
  const input = (changes: readonly ProtectedChange[], seal: TestSeal) => protectedFileBlockers({
    change: 'demo', changes, seal, reviewFix: 'tenon review request demo --event verify-pass',
  })

  it('没有批准就挡，修复命令指向评审请求；批准绑定 change + 路径 + 摘要', () => {
    const blockers = input([kf, catalog], EMPTY_TEST_SEAL)
    expect(blockers.map((item) => [item.code, item.subject])).toEqual([
      ['protected-file-unapproved', kf.path],
      ['protected-file-unapproved', catalog.path],
    ])
    expect(blockers[0]?.fix).toBe('tenon review request demo --event verify-pass')
    const approved = sealWith({ approvals: [{ change: 'demo', path: kf.path, digest: 'sha256:aaa', by: 'a', at: 't' }] })
    expect(input([kf], approved)).toEqual([])
    expect(input([{ ...kf, digest: 'sha256:bbb' }], approved).map((item) => item.code)).toEqual(['protected-file-unapproved'])
    expect(input([kf], sealWith({ approvals: [{ change: 'other', path: kf.path, digest: 'sha256:aaa', by: 'a', at: 't' }] }))).toHaveLength(1)
  })

  it('共享文件在 Tenon 命令写出之后又被改：标为台账外改动；目录 / 工作流没有写入记录，只是待确认', () => {
    const written = sealWith({ writes: { [kf.path]: { digest: 'sha256:aaa', at: 't' } } })
    expect(protectedOrigin(written, 'demo', kf)).toBe('pending')
    expect(protectedOrigin(written, 'demo', { ...kf, digest: 'sha256:zzz' })).toBe('outside-command')
    expect(protectedOrigin(written, 'demo', catalog)).toBe('pending')
    const blockers = input([{ ...kf, digest: 'sha256:zzz' }], written)
    expect(blockers.map((item) => item.code)).toEqual(['protected-file-tampered'])
    expect(blockers[0]?.message).toContain('台账外改动')
    expect(protectedOrigin(sealWith({
      writes: written.writes,
      approvals: [{ change: 'demo', path: kf.path, digest: 'sha256:zzz', by: 'a', at: 't' }],
    }), 'demo', { ...kf, digest: 'sha256:zzz' })).toBe('approved')
  })
})
