import { execFileSync } from 'node:child_process'
import { closeSync, constants, lstatSync, openSync, promises as fsPromises } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  fingerprintWorkspace, fingerprintWorkspaceTwins, isHostLocalPath, isWorkspaceBaseline, isWorkspaceCandidatePath, portableModeOf, TEST_OUTPUT_DIR_SEGMENTS,
  trackedHostLocalPaths,
  WORKSPACE_BASELINE_PREFIX,
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

/**
 * 宿主本地文件（`.claude/settings.local.json`、`CLAUDE.local.md`、`.claude/worktrees/`）：不提交、每台机器不同。
 * 完整指纹（≤ 0.3.0 绑进每条记录的值）照旧把它们算进去；可移植指纹不算，所以干净检出也能复现。
 */
describe('host-local files', () => {
  /** 固定权限位的夹具树：所有目录 755、文件 644（可执行 755），指纹因此与 umask 无关。 */
  async function fixture(options: { readonly hostLocal: boolean; readonly sharedSettings?: boolean; readonly symlink?: boolean }): Promise<string> {
    const root = await freshWorkspace()
    const dir = async (rel: string): Promise<void> => { await mkdir(join(root, rel), { recursive: true }); await chmod(join(root, rel), 0o755) }
    const file = async (rel: string, text: string, mode = 0o644): Promise<void> => { await writeFile(join(root, rel), text); await chmod(join(root, rel), mode) }
    await chmod(root, 0o755)
    for (const rel of ['src', 'test', '.claude', '.claude/agents', 'test-results']) await dir(rel)
    await file('src/a.js', 'export const a = 1\n')
    await file('src/run.sh', '#!/bin/sh\necho hi\n', 0o755)
    await file('test/a.test.js', 'export {}\n')
    await file('package.json', '{ "name": "g" }\n')
    await file('.claude/agents/tenon-x.md', 'agent\n')
    await file('test-results/unit.xml', '<x/>')
    if (options.symlink !== false) await symlink('src/a.js', join(root, 'link.js'))
    if (options.sharedSettings === true) await file('.claude/settings.json', '{ "shared": true }\n')
    if (options.hostLocal) {
      await file('.claude/settings.local.json', '{ "permissions": { "allow": ["Bash(ls)"] } }\n')
      await file('CLAUDE.local.md', 'private\n')
      await dir('.claude/worktrees')
      await dir('.claude/worktrees/x')
      await file('.claude/worktrees/x/y.js', 'copy\n')
    }
    return root
  }
  const DECLARED = { declaredOutputs: ['test-results/unit.xml'] }

  /**
   * 这些值是真正的 0.3.0 实现（v0.3.0 提交里的 fingerprint.ts 原样打包）在同一棵夹具树上算出来的，每个平台各一份。
   * 完整指纹记录原始权限位，而符号链接的权限位在 macOS 是 0755、在 Linux 恒为 0777，所以两个平台的 0.3.0 值本来就不同；
   * 夹具树里有一个符号链接，其余的权限位都用 chmod 钉死。0.3.0 写下的记录绑的就是完整指纹，升级后它们在本机不能因此全部过期，
   * 所以完整指纹必须在每个平台上逐位等于 0.3.0 自己算的值。
   */
  const V030_BY_PLATFORM: Partial<Record<NodeJS.Platform, Readonly<Record<'plain:without' | 'plain:with' | 'settings:without' | 'settings:with', string>>>> = {
    darwin: {
      'plain:without': 'workspace:sha256:7b858207f7bedfe5ed6a389f68e573e831c98f64e2afea81f78208779ae133c9',
      'plain:with': 'workspace:sha256:81190397c3551da82ecc1d5799fbbbeb1f7a5d4fcf512e684c87509168eb839a',
      'settings:without': 'workspace:sha256:7c79a73370d2335591207303db56ce098302008252d6ac9ddd915fa369ce5298',
      'settings:with': 'workspace:sha256:626c83e0ccebddee4839787267da798fe3ff16abf30fd71044cfd7aa9b5cb58f',
    },
    linux: {
      'plain:without': 'workspace:sha256:180c3bd96463066f17f47b46f68c7f2d4970fea81995dc2ea355755c69a282bf',
      'plain:with': 'workspace:sha256:fe982be20824a00bc9b000e4f4e57f0264756185d68accff41bf9e0199c2bd32',
      'settings:without': 'workspace:sha256:83e34b80fabdb14e4c9554c9ca2c2398be675f27e1b4b6416f23f694683fd6ab',
      'settings:with': 'workspace:sha256:77d61d19290121483b9eff243d50c63cb306845d2e1c6664b3bc637ac3504617',
    },
  }
  const V030 = V030_BY_PLATFORM[process.platform]

  test.skipIf(V030 === undefined)('完整指纹与 0.3.0 逐位相同（有无宿主本地文件、有无共享的 .claude/settings.json 都一样；按平台钉死）', async () => {
    if (V030 === undefined) return
    expect(await fingerprintWorkspace(await fixture({ hostLocal: false }), DECLARED)).toBe(V030['plain:without'])
    expect(await fingerprintWorkspace(await fixture({ hostLocal: true }), DECLARED)).toBe(V030['plain:with'])
    expect(await fingerprintWorkspace(await fixture({ hostLocal: false, sharedSettings: true }), DECLARED)).toBe(V030['settings:without'])
    expect(await fingerprintWorkspace(await fixture({ hostLocal: true, sharedSettings: true }), DECLARED)).toBe(V030['settings:with'])
  })

  test('可移植指纹：作者的工作区（有宿主本地文件）与干净克隆（没有）算出同一个值，在任何平台上', async () => {
    const author = await fingerprintWorkspaceTwins(await fixture({ hostLocal: true }), DECLARED)
    const clone = await fingerprintWorkspaceTwins(await fixture({ hostLocal: false }), DECLARED)
    expect(author.portable).toBe(clone.portable)
    expect(author.full, '完整指纹把宿主本地文件算进去，所以作者与克隆的完整指纹不同').not.toBe(clone.full)
    const authorShared = await fingerprintWorkspaceTwins(await fixture({ hostLocal: true, sharedSettings: true }), DECLARED)
    const cloneShared = await fingerprintWorkspaceTwins(await fixture({ hostLocal: false, sharedSettings: true }), DECLARED)
    expect(authorShared.portable).toBe(cloneShared.portable)
    expect(authorShared.portable, '共享的 .claude/settings.json 是候选的一部分').not.toBe(author.portable)
  })

  test('没有符号链接、权限位是常见的 755/644 的普通树：可移植指纹等于完整指纹，所以只认完整指纹的 0.3.0 读 0.3.1 的记录照样新鲜（每个平台都一样）', async () => {
    const twins = await fingerprintWorkspaceTwins(await fixture({ hostLocal: false, symlink: false }), DECLARED)
    expect(twins.portable).toBe(twins.full)
  })

  test('改、加、删宿主本地文件不动可移植指纹，动完整指纹；清单之外的同类文件仍属于候选', async () => {
    const root = await fixture({ hostLocal: true })
    const before = await fingerprintWorkspaceTwins(root, DECLARED)
    await writeFile(join(root, '.claude', 'settings.local.json'), '{ "permissions": { "allow": ["Bash(rm:*)"] } }\n')
    await writeFile(join(root, 'CLAUDE.local.md'), 'something else\n')
    await writeFile(join(root, '.claude', 'worktrees', 'x', 'y.js'), 'edited copy\n')
    await mkdir(join(root, '.claude', 'worktrees', 'z'), { recursive: true })
    await writeFile(join(root, '.claude', 'worktrees', 'z', 'new.js'), 'another worktree\n')
    const after = await fingerprintWorkspaceTwins(root, DECLARED)
    expect(after.portable).toBe(before.portable)
    expect(after.full).not.toBe(before.full)

    await rm(join(root, '.claude', 'settings.local.json'))
    await rm(join(root, 'CLAUDE.local.md'))
    await rm(join(root, '.claude', 'worktrees'), { recursive: true })
    const removed = await fingerprintWorkspaceTwins(root, DECLARED)
    expect(removed.portable, '删光之后与有宿主本地文件时的可移植指纹相同').toBe(before.portable)
    expect(removed.full, '完整指纹不再有宿主本地文件的内容').not.toBe(before.full)

    // 只排除清单里的路径：相似的名字、别处的同名文件、共享的配置都是实现的一部分。
    const lookalikes: readonly (readonly [string, string])[] = [
      ['.claude/settings.json', '{}\n'],
      ['.claude/settings.local.json.bak', '{}\n'],
      ['.claude/commands/review.md', '# review\n'],
      ['packages/app/.claude/settings.local.json', '{}\n'],
      ['packages/app/CLAUDE.local.md', 'nested\n'],
      ['CLAUDE.md', '# shared memory\n'],
      ['notes.local.md', 'local notes\n'],
      ['.mcp.json', '{}\n'],
    ]
    for (const [path, text] of lookalikes) {
      await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true })
      const base = await fingerprintWorkspaceTwins(root, DECLARED)
      await writeFile(join(root, ...path.split('/')), text)
      const next = await fingerprintWorkspaceTwins(root, DECLARED)
      expect(next.portable, path).not.toBe(base.portable)
      expect(next.full, path).not.toBe(base.full)
    }
  })

  test('只装着被排除内容的 .claude/ 外壳不动可移植指纹：宿主本地文件是第一个出现的 .claude/ 内容也一样', async () => {
    const root = await freshWorkspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.js'), 'export const answer = 42\n')
    const bare = await fingerprintWorkspaceTwins(root)
    // Claude Code 第一次保存权限选择：新建 .claude/ 与 settings.local.json。
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), '{}\n')
    const saved = await fingerprintWorkspaceTwins(root)
    expect(saved.portable).toBe(bare.portable)
    expect(saved.full).not.toBe(bare.full)
    // 再生成宿主 agent 文件：外壳里装的仍然全是被排除的内容。
    await mkdir(join(root, '.claude', 'agents'), { recursive: true })
    await writeFile(join(root, '.claude', 'agents', 'tenon-builder.md'), 'agent\n')
    expect((await fingerprintWorkspaceTwins(root)).portable).toBe(bare.portable)
    // 共享的 .claude/ 内容一出现，外壳就是实现的一部分。
    await writeFile(join(root, '.claude', 'settings.json'), '{}\n')
    expect((await fingerprintWorkspaceTwins(root)).portable).not.toBe(bare.portable)
  })

  test('代码度量与线索文件的路径范围来自 git diff：被跟踪的宿主本地路径照常算，名单只用于判断指纹', () => {
    expect(isWorkspaceCandidatePath('.claude/worktrees/x.js')).toBe(true)
    expect(isWorkspaceCandidatePath('.claude/settings.json')).toBe(true)
    expect(isWorkspaceCandidatePath('src/a.js')).toBe(true)
    expect(isWorkspaceCandidatePath('docs/readme.md')).toBe(false)
    expect(isHostLocalPath('.claude/settings.local.json')).toBe(true)
    expect(isHostLocalPath('CLAUDE.local.md')).toBe(true)
    expect(isHostLocalPath('.claude/worktrees/agent-1/src/a.js')).toBe(true)
    expect(isHostLocalPath('.claude/worktrees')).toBe(true)
    expect(isHostLocalPath('.claude/settings.json')).toBe(false)
    expect(isHostLocalPath('packages/app/CLAUDE.local.md')).toBe(false)
  })
})

/**
 * 被 git 跟踪的宿主本地路径是仓库的一部分：可移植指纹照算。否则 PR 可以把代码提交进 `.claude/worktrees/`、让测试命令去用它，
 * 之后再改它而候选不动。「跟踪」包括已提交与已暂存；不是 git 仓库就什么都不跟踪；git 读不出来（索引损坏等）就一律照算。
 */
describe('host-local files tracked by git', () => {
  async function repo(): Promise<string> {
    const root = await freshWorkspace()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.js'), 'export const a = 1\n')
    return root
  }
  const track = (root: string, ...paths: string[]): void => {
    execFileSync('git', ['add', '-f', '--', ...paths], { cwd: root })
  }
  const untrack = (root: string, ...paths: string[]): void => {
    execFileSync('git', ['rm', '-q', '--cached', '-f', '-r', '--', ...paths], { cwd: root })
  }

  test('被跟踪的 .claude/worktrees 代码：改它就动可移植指纹，同目录里没被跟踪的文件仍然不动', async () => {
    const root = await repo()
    await mkdir(join(root, '.claude', 'worktrees'), { recursive: true })
    await writeFile(join(root, '.claude', 'worktrees', 'x.js'), 'export const x = 1\n')
    await writeFile(join(root, '.claude', 'worktrees', 'scratch.js'), 'export const s = 1\n')
    const untracked = await fingerprintWorkspaceTwins(root)
    expect(untracked.portable, '没有被跟踪的：整个目录不进可移植指纹').not.toBe(untracked.full)

    track(root, '.claude/worktrees/x.js')
    const tracked = await fingerprintWorkspaceTwins(root)
    expect(tracked.portable).not.toBe(untracked.portable)
    expect(tracked.full).toBe(untracked.full)

    await writeFile(join(root, '.claude', 'worktrees', 'x.js'), 'export const x = 2\n')
    const changed = await fingerprintWorkspaceTwins(root)
    expect(changed.portable, '被跟踪的代码变了，可移植指纹必须变').not.toBe(tracked.portable)

    await writeFile(join(root, '.claude', 'worktrees', 'scratch.js'), 'export const s = 2\n')
    await writeFile(join(root, '.claude', 'worktrees', 'another.js'), 'export const n = 1\n')
    expect((await fingerprintWorkspaceTwins(root)).portable, '没被跟踪的文件改了不动').toBe(changed.portable)
  })

  test('被跟踪的 settings.local.json 与 CLAUDE.local.md 也算；取消跟踪（git rm --cached）就回到不算', async () => {
    const root = await repo()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), '{}\n')
    await writeFile(join(root, 'CLAUDE.local.md'), 'private\n')
    const untracked = await fingerprintWorkspaceTwins(root)
    expect(untracked.portable).not.toBe(untracked.full)

    track(root, '.claude/settings.local.json', 'CLAUDE.local.md')
    const tracked = await fingerprintWorkspaceTwins(root)
    expect(tracked.portable, '都被跟踪：它们都计入').not.toBe(untracked.portable)
    await writeFile(join(root, '.claude', 'settings.local.json'), '{ "permissions": {} }\n')
    expect((await fingerprintWorkspaceTwins(root)).portable).not.toBe(tracked.portable)

    untrack(root, '.claude/settings.local.json', 'CLAUDE.local.md')
    const again = await fingerprintWorkspaceTwins(root)
    expect(again.portable).not.toBe(again.full)
    await writeFile(join(root, '.claude', 'settings.local.json'), '{ "permissions": { "allow": [] } }\n')
    expect((await fingerprintWorkspaceTwins(root)).portable).toBe(again.portable)
  })

  test('只跟踪其中一个文件：另一个仍不算；.claude/ 外壳因为装着被跟踪的文件而属于候选', async () => {
    const root = await repo()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), '{}\n')
    await writeFile(join(root, 'CLAUDE.local.md'), 'private\n')
    const bare = (await fingerprintWorkspaceTwins(root)).portable
    track(root, 'CLAUDE.local.md')
    const mixed = (await fingerprintWorkspaceTwins(root)).portable
    expect(mixed).not.toBe(bare)
    await writeFile(join(root, '.claude', 'settings.local.json'), '{ "edited": true }\n')
    expect((await fingerprintWorkspaceTwins(root)).portable).toBe(mixed)
    await writeFile(join(root, 'CLAUDE.local.md'), 'edited\n')
    expect((await fingerprintWorkspaceTwins(root)).portable).not.toBe(mixed)
  })

  test('git 读不出跟踪情况（索引损坏）：一律照算，绝不放宽', async () => {
    const root = await repo()
    await mkdir(join(root, '.claude'), { recursive: true })
    const settings = join(root, '.claude', 'settings.local.json')
    await writeFile(settings, '{}\n')
    const healthy = await fingerprintWorkspaceTwins(root)
    await writeFile(settings, '{ "edited": 1 }\n')
    expect((await fingerprintWorkspaceTwins(root)).portable, '索引健康：没被跟踪的宿主本地文件不进可移植指纹').toBe(healthy.portable)

    await writeFile(join(root, '.git', 'index'), 'not an index')
    expect(await trackedHostLocalPaths(root)).toBeUndefined()
    const broken = await fingerprintWorkspaceTwins(root)
    expect(broken.portable, 'git 答不出来：宿主本地文件照算，值不再等于健康时的').not.toBe(healthy.portable)
    await writeFile(settings, '{ "edited": 2 }\n')
    expect((await fingerprintWorkspaceTwins(root)).portable, '照算：改它就动').not.toBe(broken.portable)
  })
})

/**
 * 可移植指纹按 git 的权限位模型记录，不按文件系统的：git 不存目录权限位、不存符号链接权限位，普通文件只存属主的可执行位
 * （100644 / 100755）。其余的权限位是写出检出的那台机器决定的——符号链接在 macOS 是 0755、在 Linux 恒为 0777，
 * 目录与文件跟着 umask（002 下是 0775 / 0664）——同样的提交内容在 Linux runner 上算不出 Mac 上算的值。
 */
describe('portable fingerprint follows git mode model', () => {
  /** 三台机器的权限位：常见的 umask 022、umask 002（Ubuntu 默认用户）、严格的 077。 */
  const MACHINES = {
    umask022: { dir: 0o755, file: 0o644, exec: 0o755 },
    umask002: { dir: 0o775, file: 0o664, exec: 0o775 },
    umask077: { dir: 0o700, file: 0o600, exec: 0o700 },
  } as const
  type Machine = (typeof MACHINES)[keyof typeof MACHINES]

  /** 同一份 git 内容：只有权限位按 `machine` 变；`run.sh` 是可执行文件，其余都不是。 */
  async function checkout(machine: Machine, options: { readonly execOnA?: boolean; readonly symlink?: boolean } = {}): Promise<string> {
    const root = await freshWorkspace()
    const dir = async (rel: string): Promise<void> => { await mkdir(join(root, rel), { recursive: true }); await chmod(join(root, rel), machine.dir) }
    const file = async (rel: string, text: string, exec = false): Promise<void> => {
      await writeFile(join(root, rel), text)
      await chmod(join(root, rel), exec ? machine.exec : machine.file)
    }
    await chmod(root, machine.dir)
    await dir('src')
    await dir('src/deep')
    await dir('test')
    await file('src/a.js', 'export const a = 1\n', options.execOnA === true)
    await file('src/deep/b.js', 'export const b = 2\n')
    await file('src/run.sh', '#!/bin/sh\necho hi\n', true)
    await file('test/a.test.js', 'export {}\n')
    if (options.symlink !== false) await symlink('src/a.js', join(root, 'link.js'))
    return root
  }

  test('同一份 git 内容、三台机器的权限位（umask 022 / 002 / 077）：可移植指纹相同，完整指纹各不相同', async () => {
    const twins = await Promise.all(Object.values(MACHINES).map(async (machine) => fingerprintWorkspaceTwins(await checkout(machine))))
    expect(new Set(twins.map((item) => item.portable)).size, '可移植指纹不随目录与文件的 umask 变').toBe(1)
    expect(new Set(twins.map((item) => item.full)).size, '完整指纹记录原始权限位，所以随它变').toBe(3)
  })

  test('可执行位是 git 的口径：属主的可执行位变了就动可移植指纹；读写位、组与其他人的可执行位不算', async () => {
    for (const machine of Object.values(MACHINES)) {
      const plain = (await fingerprintWorkspaceTwins(await checkout(machine))).portable
      const executable = (await fingerprintWorkspaceTwins(await checkout(machine, { execOnA: true }))).portable
      expect(executable, '把普通文件改成可执行：提交内容变了（100644 → 100755）').not.toBe(plain)
    }
    // 只有组与其他人可执行、属主不可执行：git 当它是 100644。
    const root = await checkout(MACHINES.umask022)
    const before = await fingerprintWorkspaceTwins(root)
    await chmod(join(root, 'src', 'deep', 'b.js'), 0o611)
    const groupExec = await fingerprintWorkspaceTwins(root)
    expect(groupExec.portable).toBe(before.portable)
    expect(groupExec.full, '完整指纹把它算成另一个权限位').not.toBe(before.full)
    await chmod(join(root, 'src', 'deep', 'b.js'), 0o444)
    expect((await fingerprintWorkspaceTwins(root)).portable, '只读不改变 git 的权限位').toBe(before.portable)
    await chmod(join(root, 'src', 'deep', 'b.js'), 0o700)
    expect((await fingerprintWorkspaceTwins(root)).portable, '属主可执行：100755').not.toBe(before.portable)
  })

  test('两个指纹共用一条哈希流直到第一条不同的记录：在遍历的中途才出现分歧（最后才排序到的文件权限位不同）也各自算对', async () => {
    const root = await checkout(MACHINES.umask022, { symlink: false })
    await writeFile(join(root, 'zz-last.js'), 'export const last = 1\n')
    await chmod(join(root, 'zz-last.js'), 0o644)
    const ordinary = await fingerprintWorkspaceTwins(root)
    expect(ordinary.portable, '普通的树：整个遍历都共用一条流，两个指纹相等').toBe(ordinary.full)
    await chmod(join(root, 'zz-last.js'), 0o664)
    const late = await fingerprintWorkspaceTwins(root)
    expect(late.portable, '权限位 664 在 git 里还是 100644').toBe(ordinary.portable)
    expect(late.full, '完整指纹记录原始权限位').not.toBe(ordinary.full)
    // 分歧之后的文件内容两条流都要吃到：最后一个文件的内容变了，两个指纹都动。
    await writeFile(join(root, 'zz-last.js'), 'export const last = 2\n')
    const edited = await fingerprintWorkspaceTwins(root)
    expect(edited.portable).not.toBe(late.portable)
    expect(edited.full).not.toBe(late.full)
  })

  test('目录没有权限位：只改目录权限位（含根目录）不动可移植指纹，动完整指纹', async () => {
    const root = await checkout(MACHINES.umask022)
    const before = await fingerprintWorkspaceTwins(root)
    await chmod(join(root, 'src', 'deep'), 0o700)
    await chmod(join(root, 'test'), 0o775)
    await chmod(root, 0o700)
    const after = await fingerprintWorkspaceTwins(root)
    expect(after.portable).toBe(before.portable)
    expect(after.full).not.toBe(before.full)
    // 新增一个文件、改内容照样动：权限位之外的一切仍在记录里。
    await writeFile(join(root, 'src', 'deep', 'b.js'), 'export const b = 3\n')
    expect((await fingerprintWorkspaceTwins(root)).portable).not.toBe(after.portable)
  })

  test('符号链接：权限位不进可移植记录（只有目标）；目标变了才动', async () => {
    // 记录里用的模式记号：符号链接与目录是常量，不随实际权限位变；普通文件只看属主的可执行位。
    expect(portableModeOf('L', 0o755)).toBe(portableModeOf('L', 0o777))
    expect(portableModeOf('L', 0o755)).toBe(portableModeOf('L', 0o700))
    expect(portableModeOf('D', 0o755)).toBe(portableModeOf('D', 0o2775))
    expect(portableModeOf('F', 0o644)).toBe('644')
    expect(portableModeOf('F', 0o664)).toBe('644')
    expect(portableModeOf('F', 0o600)).toBe('644')
    expect(portableModeOf('F', 0o611)).toBe('644')
    expect(portableModeOf('F', 0o755)).toBe('755')
    expect(portableModeOf('F', 0o700)).toBe('755')
    expect(portableModeOf('F', 0o4755)).toBe('755')

    const root = await checkout(MACHINES.umask022)
    const before = await fingerprintWorkspaceTwins(root)
    // macOS 上真的把符号链接的权限位改掉（Linux 的 lchmod 是个会抛错的空壳，那里的差别由上面的记号表证明）。
    if (process.platform === 'darwin' && typeof fsPromises.lchmod === 'function') {
      await fsPromises.lchmod(join(root, 'link.js'), 0o700)
      expect(lstatSync(join(root, 'link.js')).mode & 0o777, '符号链接的权限位确实变了').toBe(0o700)
      const flipped = await fingerprintWorkspaceTwins(root)
      expect(flipped.portable).toBe(before.portable)
      expect(flipped.full).not.toBe(before.full)
    }
    await rm(join(root, 'link.js'))
    await symlink('src/deep/b.js', join(root, 'link.js'))
    expect((await fingerprintWorkspaceTwins(root)).portable, '目标变了').not.toBe(before.portable)
  })
})
