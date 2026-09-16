import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { fingerprintWorkspace, isWorkspaceBaseline, WORKSPACE_BASELINE_PREFIX } from './fingerprint.js'

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
    await mkdir(join(root, 'coverage'), { recursive: true })
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
    await writeFile(join(root, 'coverage', 'coverage-final.json'), '{}\n')
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

    await mkdir(join(root, 'design-demos', 'shots'), { recursive: true })
    await writeFile(join(root, 'design-demos', 'shots', 'delivery.png'), 'shipped image\n')
    expect(await fingerprintWorkspace(root)).not.toBe(first)
  })
})
