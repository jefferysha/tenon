import { closeSync, constants, lstatSync, openSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  fingerprintWorkspace, isWorkspaceBaseline, TEST_OUTPUT_DIR_SEGMENTS, WORKSPACE_BASELINE_PREFIX,
} from './fingerprint.js'

const roots: string[] = []

async function freshWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-workspace-baseline-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fingerprintWorkspace', () => {
  test('稳定编码实现树，源码、模式与链接目标都是内容基线的一部分', async () => {
    const root = await freshWorkspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.js'), 'export const answer = 42\n', { mode: 0o644 })
    await symlink('src/app.js', join(root, 'app-link'))

    const first = await fingerprintWorkspace(root)
    const second = await fingerprintWorkspace(root)
    expect(first).toBe(second)
    expect(first).toMatch(new RegExp(`^${WORKSPACE_BASELINE_PREFIX}[a-f0-9]{64}$`))
    expect(isWorkspaceBaseline(first)).toBe(true)

    await writeFile(join(root, 'src', 'app.js'), 'export const answer = 43\n', { mode: 0o644 })
    expect(await fingerprintWorkspace(root)).not.toBe(first)

    await chmod(join(root, 'src', 'app.js'), 0o755)
    expect(await fingerprintWorkspace(root)).not.toBe(first)

    await writeFile(join(root, 'src', 'app.js'), 'export const answer = 42\n', { mode: 0o644 })
    await rm(join(root, 'app-link'))
    await symlink('src/missing.js', join(root, 'app-link'))
    expect(await fingerprintWorkspace(root)).not.toBe(first)
  })

  test('工作流证据、控制状态、依赖和缓存不会让 Verify 改写自己的 in-place 基线', async () => {
    const root = await freshWorkspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'packages', 'web'), { recursive: true })
    await mkdir(join(root, '.github'), { recursive: true })
    await writeFile(join(root, 'src', 'app.js'), 'export const pet = true\n')
    const first = await fingerprintWorkspace(root)

    await mkdir(join(root, 'openspec', 'changes', 'catalog-flow'), { recursive: true })
    await mkdir(join(root, 'docs', 'superpowers', 'reports'), { recursive: true })
    await mkdir(join(root, '.pipeline', 'cache'), { recursive: true })
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await mkdir(join(root, '.codex'), { recursive: true })
    await mkdir(join(root, '.impeccable'), { recursive: true })
    await mkdir(join(root, '.superpowers', 'sdd'), { recursive: true })
    await mkdir(join(root, '.worktrees', 'verify-copy'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'fixture'), { recursive: true })
    await mkdir(join(root, 'packages', 'web', 'node_modules', '.vite', 'vitest'), { recursive: true })
    await mkdir(join(root, '.playwright-mcp', 'runs'), { recursive: true })
    await mkdir(join(root, '.playwright-tmp', 'shots'), { recursive: true })
    await mkdir(join(root, 'e2e-runs', 'simple'), { recursive: true })
    await mkdir(join(root, '.github', 'hooks'), { recursive: true })
    await writeFile(join(root, 'openspec', 'changes', 'catalog-flow', '.pipeline.yaml'), 'phase: verify\n')
    await writeFile(join(root, 'docs', 'superpowers', 'reports', 'catalog-flow.md'), '# verification\n')
    await writeFile(join(root, '.pipeline', 'codex-skill-receipts.jsonl'), '{"skill":"tenon-verify"}\n')
    await writeFile(join(root, '.pipeline', 'cache', 'router.v5.data'), 'control cache\n')
    await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), '{}\n')
    await writeFile(join(root, '.codex', 'config.toml'), 'approval_policy = "never"\n')
    await writeFile(join(root, '.impeccable', 'state.json'), '{}\n')
    await writeFile(join(root, '.superpowers', 'sdd', 'progress.md'), '# progress\n')
    await writeFile(join(root, '.worktrees', 'verify-copy', 'receipt.log'), 'temporary worktree\n')
    await writeFile(join(root, 'node_modules', 'fixture', 'index.js'), 'ignored\n')
    await writeFile(join(root, 'packages', 'web', 'node_modules', '.vite', 'vitest', 'results.json'), '{}\n')
    await writeFile(join(root, '.playwright-mcp', 'runs', 'network.json'), '{}\n')
    await writeFile(join(root, '.playwright-tmp', 'shots', 'acceptance.png'), 'ignored\n')
    await writeFile(join(root, 'e2e-runs', 'simple', 'screenshot.png'), 'ignored\n')
    await writeFile(join(root, '.github', 'hooks', 'verify.sh'), '#!/bin/sh\n')
    await writeFile(join(root, 'dashboard-progress-custom-spec.png'), 'ignored\n')
    await writeFile(join(root, 'dashboard-acceptance-mobile.png'), 'ignored\n')
    await writeFile(join(root, 'workbench-current.png'), 'ignored\n')
    await mkdir(join(root, '.tenon', 'users', 'a-at-x.io', 'local'), { recursive: true })
    await mkdir(join(root, '.tenon', 'users', 'a-at-x.io', 'tests', 'catalog-flow'), { recursive: true })
    await writeFile(join(root, '.tenon', '.gitignore'), 'users/*/local/\n')
    await writeFile(join(root, '.tenon', 'users', 'a-at-x.io', 'local', 'active-change'), 'catalog-flow\n')
    await writeFile(join(root, '.tenon', 'users', 'a-at-x.io', 'tests', 'catalog-flow', 'run-1.json'), '{}\n')
    await writeFile(join(root, '.pipeline-pending-review'), 'transient\n')

    expect(await fingerprintWorkspace(root)).toBe(first)

    // 宿主 agent 文件与所有权清单：其它任务在途时 Tenon 会生成 / 回收它们。
    await mkdir(join(root, '.github', 'agents'), { recursive: true })
    const withGithubDir = await fingerprintWorkspace(root)
    await mkdir(join(root, '.claude', 'agents'), { recursive: true })
    // 第一次生成宿主 agent 文件才新建 .claude/：只装着被排除内容的外壳目录不动候选。
    expect(await fingerprintWorkspace(root)).toBe(withGithubDir)
    await writeFile(join(root, '.claude', 'agents', 'tenon-builder.md'), '---\nname: tenon-builder\n---\n')
    await writeFile(join(root, '.pipeline-owned.json'), '{}\n')
    expect(await fingerprintWorkspace(root)).toBe(withGithubDir)
    expect(withGithubDir).not.toBe(first)
    // .claude/ 里有别的内容（例如设置）就是实现的一部分。
    await writeFile(join(root, '.claude', 'settings.json'), '{}\n')
    expect(await fingerprintWorkspace(root)).not.toBe(withGithubDir)
    await rm(join(root, '.claude', 'settings.json'))

    await mkdir(join(root, 'design-demos', 'shots'), { recursive: true })
    await writeFile(join(root, 'design-demos', 'shots', 'delivery.png'), 'shipped image\n')
    expect(await fingerprintWorkspace(root)).not.toBe(first)
  })

  test('未声明的 coverage / test-results / playwright-report / .cache 目录属于候选：任意层级都不再整体忽略', async () => {
    const root = await freshWorkspace()
    await mkdir(join(root, 'frontend'))
    await writeFile(join(root, 'frontend', 'src.ts'), 'export const a = 1\n')
    const first = await fingerprintWorkspace(root)
    for (const segment of [...TEST_OUTPUT_DIR_SEGMENTS, '.cache']) {
      const before = await fingerprintWorkspace(root)
      await mkdir(join(root, 'frontend', segment), { recursive: true })
      await writeFile(join(root, 'frontend', segment, 'payload.js'), 'export const smuggled = true\n')
      expect(await fingerprintWorkspace(root), `${segment} 里的未声明文件必须动候选`).not.toBe(before)
    }
    expect(await fingerprintWorkspace(root)).not.toBe(first)
  })

  test('只忽略声明的产物路径：声明的文件与目录不动候选，同目录下未声明的文件仍动候选', async () => {
    const root = await freshWorkspace()
    await mkdir(join(root, 'frontend', 'src'), { recursive: true })
    await writeFile(join(root, 'frontend', 'src', 'app.ts'), 'export const a = 1\n')
    const declaredOutputs = ['frontend/test-results/report.xml', 'frontend/coverage', 'playwright-report']
    const first = await fingerprintWorkspace(root, { declaredOutputs })
    // 第一次产出报告才新建 test-results/ 与 coverage/：只装着声明产物的外壳目录不动候选。
    await mkdir(join(root, 'frontend', 'test-results'), { recursive: true })
    await writeFile(join(root, 'frontend', 'test-results', 'report.xml'), '<testsuite/>\n')
    await mkdir(join(root, 'frontend', 'coverage', 'lcov-report'), { recursive: true })
    await writeFile(join(root, 'frontend', 'coverage', 'lcov-report', 'index.html'), '<html/>\n')
    await mkdir(join(root, 'playwright-report', 'data'), { recursive: true })
    await writeFile(join(root, 'playwright-report', 'data', 'trace.zip'), 'zip\n')
    expect(await fingerprintWorkspace(root, { declaredOutputs })).toBe(first)
    // 不带声明时同一棵树是另一个候选。
    expect(await fingerprintWorkspace(root)).not.toBe(await fingerprintWorkspace(root, { declaredOutputs }))
    // 声明的是 report.xml，同目录的别的文件不在声明里。
    await writeFile(join(root, 'frontend', 'test-results', 'notes.txt'), 'not declared\n')
    expect(await fingerprintWorkspace(root, { declaredOutputs })).not.toBe(first)
    // 声明不是通配：另一个包里的 coverage/ 不受影响。
    const withNotes = await fingerprintWorkspace(root, { declaredOutputs })
    await mkdir(join(root, 'other', 'coverage'), { recursive: true })
    await writeFile(join(root, 'other', 'coverage', 'x.js'), 'export {}\n')
    expect(await fingerprintWorkspace(root, { declaredOutputs })).not.toBe(withNotes)
  })

  test('声明里的绝对路径、.. 段与反斜杠被忽略，不能借声明把源码排除出候选', async () => {
    const root = await freshWorkspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'export const a = 1\n')
    const first = await fingerprintWorkspace(root)
    const hostile = ['/src', '../src', 'src/../src', 'a\\b', '', '.']
    expect(await fingerprintWorkspace(root, { declaredOutputs: hostile })).toBe(first)
    await writeFile(join(root, 'src', 'app.ts'), 'export const a = 2\n')
    expect(await fingerprintWorkspace(root, { declaredOutputs: hostile })).not.toBe(first)
  })

  // 服务端把已注册的项目根按打开的目录句柄读取。Linux 上那是 /proc/self/fd/<n>，叶子是符号链接，lstat 只看到链接本身；
  // 这条曾让 Linux 上的 Dashboard 把每条测试记录都判成「候选未知」而过期，本机 macOS 却毫无症状——
  // macOS 上 /dev/fd/<n> 列不出目录内容，锚点根本不产出句柄别名（见 server 的 traversableDirectoryFdPath），所以只在 Linux 上有可验证的别名。
  test.skipIf(process.platform !== 'linux')('进程内目录句柄别名 /proc/self/fd/<n> 与真实路径得到同一份指纹', async () => {
    const root = await freshWorkspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.js'), 'export const answer = 42\n')
    const real = await fingerprintWorkspace(root)

    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      const alias = `/proc/self/fd/${fd}`
      expect(lstatSync(alias).isSymbolicLink(), '别名的叶子是符号链接，这正是曾经的故障点').toBe(true)
      expect(await fingerprintWorkspace(alias)).toBe(real)

      await writeFile(join(root, 'src', 'app.js'), 'export const answer = 43\n')
      expect(await fingerprintWorkspace(alias)).toBe(await fingerprintWorkspace(root))
      expect(await fingerprintWorkspace(alias)).not.toBe(real)
    } finally {
      closeSync(fd)
    }
  })

  test('指向目录的符号链接不是工作区根：仍然拒绝，只有进程内句柄别名走「/.」遍历', async () => {
    const root = await freshWorkspace()
    const link = join(await freshWorkspace(), 'root-link')
    await symlink(root, link)
    await expect(fingerprintWorkspace(link)).rejects.toThrow(/workspace root is not a directory/)
  })
})
