/**
 * sync + uninstall —— 真实端到端集成测试（BACKLOG #24，GOAL C9：无伪测试）。
 *
 * 零 mock：freshHarness 真临时项目 + realDeps 真 CliDeps + createOwnedFs 真 node:fs。
 * 真装文件（真写 .claude/**、真写 .pipeline-owned.json path→hash 清单）→ 真调 cmdSync/cmdUninstall
 * → 断言真实的文件增删（用户改过的真保留、自己装的真删、结构化真 scrub 写回）+ 清单真收尾。
 *
 * 覆盖（C10）：uninstall happy（全删+目录清理）/ 保留 user-modified / 结构化 scrub / 前置三态 /
 * dry-run / confirm fail-closed；sync report-only / downgrade guard / --migrate 硬闸 / banner / channel /
 * 跨命令串联（装→sync report→uninstall 真删）。
 */
import { mkdir, readFile, rm as rmfs, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { CODEX_AGENTS_BLOCK, computeContentHash, serializeOwnedManifest } from '@tenon/kernel'
import { cmdSync, type SyncMigrationProvider } from './commands/sync.js'
import { cmdUninstall } from './commands/uninstall.js'
import { freshHarness, realDeps, rm, type Harness } from './integration-harness.js'

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 真写一个受管文件到临时项目（父目录自动建）。 */
async function installFile(h: Harness, rel: string, content: string): Promise<void> {
  const abs = join(h.cwd, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

/** 真写 .pipeline-owned.json（path→真内容 hash）。 */
async function installManifest(h: Harness, map: Record<string, string>): Promise<void> {
  await writeFile(join(h.cwd, '.pipeline-owned.json'), serializeOwnedManifest(map), 'utf8')
}

/** 真调 cmdUninstall（realDeps 真 kernel + createOwnedFs 真 fs 默认注入）。 */
async function uninstall(h: Harness, opts: { yes?: boolean; dryRun?: boolean }) {
  const out: string[] = []
  const err: string[] = []
  const code = await cmdUninstall(realDeps(h.cwd, out, err), opts)
  return { code, out, err }
}

async function sync(h: Harness, opts: Parameters<typeof cmdSync>[1]) {
  const out: string[] = []
  const err: string[] = []
  const code = await cmdSync(realDeps(h.cwd, out, err), opts)
  return { code, out, err }
}

// ════════════════════════════════════════════════════════════════════════════
// UNINSTALL — 真删 / 真保留 / 真 scrub
// ════════════════════════════════════════════════════════════════════════════
describe('真实 e2e —— uninstall 真删自己装的 + 真保留用户改过的', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('happy：3 个 unmodified 文件真删 + 清单真收尾 + 计数', async () => {
    const a = 'AAA'
    const b = 'BBB'
    const c = 'CCC'
    await installFile(h, '.claude/a.md', a)
    await installFile(h, '.claude/b.md', b)
    await installFile(h, '.claude/c.md', c)
    await installManifest(h, {
      '.claude/a.md': computeContentHash(a),
      '.claude/b.md': computeContentHash(b),
      '.claude/c.md': computeContentHash(c),
    })

    const r = await uninstall(h, { yes: true })
    expect(r.code).toBe(0)
    // 真删三文件
    expect(await exists(join(h.cwd, '.claude/a.md'))).toBe(false)
    expect(await exists(join(h.cwd, '.claude/b.md'))).toBe(false)
    expect(await exists(join(h.cwd, '.claude/c.md'))).toBe(false)
    // 空受管根 .claude 真被 final_pass 清掉
    expect(await exists(join(h.cwd, '.claude'))).toBe(false)
    // 清单真收尾（卸载后不留残清单）
    expect(await exists(join(h.cwd, '.pipeline-owned.json'))).toBe(false)
    // summary 计数
    expect(r.out.join('\n')).toContain('3 files deleted')
  })

  test('保留 user-modified：改过的真留、未改的真删（hash 升格删除决策）', async () => {
    const installed = 'INSTALLED-CONTENT'
    await installFile(h, '.claude/keep.md', 'USER EDITED THIS') // 磁盘内容≠装机内容
    await installFile(h, '.claude/drop.md', installed)
    await installManifest(h, {
      '.claude/keep.md': computeContentHash(installed), // hash 记的是装机内容 → 与磁盘不符 → 保留
      '.claude/drop.md': computeContentHash(installed),
    })

    const r = await uninstall(h, { yes: true })
    expect(r.code).toBe(0)
    expect(await readFile(join(h.cwd, '.claude/keep.md'), 'utf8')).toBe('USER EDITED THIS') // 真保留
    expect(await exists(join(h.cwd, '.claude/drop.md'))).toBe(false) // 真删
    expect(r.out.join('\n')).toContain('user-modified')
  })

  test('结构化 settings.json：真 scrub 写回（剥本插件 hook、保留用户 hook + 其它顶层键）', async () => {
    const settings = JSON.stringify(
      {
        model: 'sonnet',
        hooks: {
          SessionStart: [
            { hooks: [{ command: 'python3 .claude/hooks/pl.py' }] },
            { hooks: [{ command: 'my-own-tool run' }] },
          ],
        },
      },
      null,
      2,
    )
    await installFile(h, '.claude/settings.json', settings)
    await installFile(h, '.claude/hooks/pl.py', 'PLUGIN HOOK')
    await installManifest(h, {
      '.claude/settings.json': 'h-settings',
      '.claude/hooks/pl.py': computeContentHash('PLUGIN HOOK'),
    })

    const r = await uninstall(h, { yes: true })
    expect(r.code).toBe(0)
    // settings.json 仍在（scrub 写回，非整删）
    const after = JSON.parse(await readFile(join(h.cwd, '.claude/settings.json'), 'utf8'))
    expect(after.model).toBe('sonnet') // 非 hooks 顶层键真保留
    expect(after.hooks.SessionStart).toHaveLength(1) // 本插件 hook 真剥、用户 hook 真留
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe('my-own-tool run')
    // pl.py 是 opaque unmodified → 真删；空 hooks 目录真清
    expect(await exists(join(h.cwd, '.claude/hooks/pl.py'))).toBe(false)
    expect(r.out.join('\n')).toContain('1 files modified')
  })

  test('dry-run：render 后 exit 0，磁盘零改动、清单仍在', async () => {
    const c = 'X'
    await installFile(h, '.claude/x.md', c)
    await installManifest(h, { '.claude/x.md': computeContentHash(c) })

    const r = await uninstall(h, { dryRun: true })
    expect(r.code).toBe(0)
    expect(await exists(join(h.cwd, '.claude/x.md'))).toBe(true) // 未删
    expect(await exists(join(h.cwd, '.pipeline-owned.json'))).toBe(true) // 清单仍在
    expect(r.err.join('\n')).toContain('Dry run')
  })

  test('confirm fail-closed：无 --yes → exit 1、磁盘零改动', async () => {
    const c = 'X'
    await installFile(h, '.claude/x.md', c)
    await installManifest(h, { '.claude/x.md': computeContentHash(c) })

    const r = await uninstall(h, {})
    expect(r.code).toBe(1)
    expect(await exists(join(h.cwd, '.claude/x.md'))).toBe(true)
    expect(r.err.join('\n')).toContain('--yes')
  })

  test('前置1：无清单 → 未安装幂等 exit 0', async () => {
    const r = await uninstall(h, { yes: true })
    expect(r.code).toBe(0)
    expect(r.err.join('\n')).toContain('未安装')
  })

  test('前置2：空对象清单 → 损坏硬失败 exit 1', async () => {
    await writeFile(join(h.cwd, '.pipeline-owned.json'), '{}\n', 'utf8')
    const r = await uninstall(h, { yes: true })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('拒绝盲删')
  })

  test('missing 桶：清单内文件磁盘缺失 → 跳过、不计删除', async () => {
    await installManifest(h, { 'gone.md': 'h1', '.claude/present.md': computeContentHash('P') })
    await installFile(h, '.claude/present.md', 'P')
    const r = await uninstall(h, { yes: true })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/already missing/i)
    expect(r.out.join('\n')).toContain('1 files deleted') // 仅 present.md
  })

  test('诚实 stub：.opencode/package.json → 真保留不删 + stub 标注（降级可见 B8）', async () => {
    await installFile(h, '.opencode/package.json', '{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}')
    await installManifest(h, { '.opencode/package.json': 'h1' })
    const r = await uninstall(h, { yes: true })
    expect(r.code).toBe(0)
    expect(await exists(join(h.cwd, '.opencode/package.json'))).toBe(true) // 保守保留
    expect(r.out.join('\n')).toMatch(/stub/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SYNC — 决策层真读版本戳 / 真报告 JSON / 真 prune 落盘
// ════════════════════════════════════════════════════════════════════════════
describe('真实 e2e —— sync 决策层（真读 .pipeline-version + 报告 JSON）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  const report = (out: string[]): Record<string, unknown> => JSON.parse(out.join('\n'))

  test('report-only：真读版本戳、同版不注入、清单零改动', async () => {
    await writeFile(join(h.cwd, '.pipeline-version'), '1.0.0', 'utf8')
    const r = await sync(h, { cliVersion: '1.0.0' })
    expect(r.code).toBe(0)
    expect(report(r.out)).toMatchObject({
      stage: 'sync',
      project_version: '1.0.0',
      cli_version: '1.0.0',
      report_only: true,
      inject_config_sections: false,
    })
  })

  test('AGENTS.md 的过时 Codex 受管块：report-only 只报告，--migrate 就地刷新且块外不动', async () => {
    const stale = '# 项目规则\n\n用户自己的规则\n\n<!-- PIPELINE:CODEX:START -->\n## 旧块\n初始化 OpenSpec 并分派当前 phase Skill\n<!-- PIPELINE:CODEX:END -->\n'
    await writeFile(join(h.cwd, 'AGENTS.md'), stale, 'utf8')
    await writeFile(join(h.cwd, '.pipeline-version'), '1.0.0', 'utf8')

    const reported = await sync(h, { cliVersion: '1.0.0' })
    expect(reported.code).toBe(0)
    expect(report(reported.out)).toMatchObject({ codex_block: 'stale', report_only: true })
    expect(reported.err.join('\n')).toContain('tenon sync --migrate')
    expect(await readFile(join(h.cwd, 'AGENTS.md'), 'utf8')).toBe(stale)

    const migrated = await sync(h, { cliVersion: '1.0.0', migrate: true })
    expect(migrated.code).toBe(0)
    expect(report(migrated.out)).toMatchObject({ codex_block: 'refreshed' })
    const refreshed = await readFile(join(h.cwd, 'AGENTS.md'), 'utf8')
    expect(refreshed).toBe(`# 项目规则\n\n用户自己的规则\n\n${CODEX_AGENTS_BLOCK}`)
    expect(refreshed).not.toContain('phase Skill')

    const again = await sync(h, { cliVersion: '1.0.0' })
    expect(report(again.out)).toMatchObject({ codex_block: 'current' })
  })

  test('downgrade 守卫：cli<project 无 --allow → proceed=false、exit 0、明示两条出路', async () => {
    await writeFile(join(h.cwd, '.pipeline-version'), '2.0.0', 'utf8')
    const r = await sync(h, { cliVersion: '1.0.0' })
    expect(r.code).toBe(0)
    expect(report(r.out)).toMatchObject({ stage: 'downgrade-guard', proceed: false })
    expect(r.err.join('\n')).toContain('DOWNGRADE')
  })

  test('--migrate 硬闸：breaking∧recommend∧pending → exit 1（真读版本戳触发窗口）', async () => {
    await writeFile(join(h.cwd, '.pipeline-version'), '1.0.0', 'utf8')
    const migrations: SyncMigrationProvider = {
      pending: () => ['a/b.md'],
      metadata: () => ({ breaking: true, recommend_migrate: true }),
    }
    const r = await sync(h, { cliVersion: '2.0.0', migrations })
    expect(r.code).toBe(1)
    expect(report(r.out).migrate_gate).toMatchObject({ decision: 'required', exitCode: 1 })
    expect(r.err.join('\n')).toContain('MIGRATION REQUIRED')
  })

  test('prune 落盘仅 --migrate：report-only 不改真清单、--migrate 真剪落盘', async () => {
    await writeFile(join(h.cwd, '.pipeline-version'), '1.0.0', 'utf8')
    const manifest = { 'orphan.md': 'h1' }
    await installManifest(h, manifest)
    const before = await readFile(join(h.cwd, '.pipeline-owned.json'), 'utf8')

    // report-only：pruned 计算但清单字节不变
    const r1 = await sync(h, { cliVersion: '2.0.0' })
    expect(report(r1.out).pruned_persisted).toBe(false)
    expect(await readFile(join(h.cwd, '.pipeline-owned.json'), 'utf8')).toBe(before)

    // --migrate：真剪落盘（orphan.md 被剔除）
    const r2 = await sync(h, { cliVersion: '2.0.0', migrate: true })
    expect(report(r2.out).pruned_persisted).toBe(true)
    const after = await readFile(join(h.cwd, '.pipeline-owned.json'), 'utf8')
    expect(after).not.toContain('orphan.md')
  })

  test('banner：真读版本戳落后 → update 方向；同版 → 静默', async () => {
    await writeFile(join(h.cwd, '.pipeline-version'), '1.0.0', 'utf8')
    const r1 = await sync(h, { sub: 'banner', cliVersion: '2.0.0' })
    expect(report(r1.out)).toMatchObject({ direction: 'update' })

    const r2 = await sync(h, { sub: 'banner', cliVersion: '1.0.0' })
    expect(r2.out).toEqual([]) // 同版静默
  })

  test('upgrade-channel：从注入 installed_plugins.json 文本派生 beta', async () => {
    const installed = JSON.stringify({ plugins: { k: [{ version: '3.0.0-beta.4' }] } })
    const r = await sync(h, { sub: 'upgrade-channel', cliVersion: '1.0.0', installedJson: installed, pluginKey: 'k' })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out.join('\n'))).toMatchObject({ channel: 'beta' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 跨命令串联：真装 → sync report → uninstall 真删
// ════════════════════════════════════════════════════════════════════════════
describe('真实 e2e —— 跨命令串联（装 → sync → uninstall）', () => {
  test('装文件+清单 → sync 报告 report-only → uninstall 真删全部', async () => {
    const h = await freshHarness()
    try {
      const content = 'OWNED-BY-PIPELINE'
      await installFile(h, '.claude/hooks/gate.sh', content)
      await writeFile(join(h.cwd, '.pipeline-version'), '1.0.0', 'utf8')
      await installManifest(h, { '.claude/hooks/gate.sh': computeContentHash(content) })

      // sync 报告态：不动盘
      const s = await sync(h, { cliVersion: '1.0.0' })
      expect(s.code).toBe(0)
      expect(await exists(join(h.cwd, '.claude/hooks/gate.sh'))).toBe(true)

      // uninstall：真删 + 空目录逐层清（.claude/hooks → .claude）
      const u = await uninstall(h, { yes: true })
      expect(u.code).toBe(0)
      expect(await exists(join(h.cwd, '.claude/hooks/gate.sh'))).toBe(false)
      expect(await exists(join(h.cwd, '.claude'))).toBe(false)
      expect(await exists(join(h.cwd, '.pipeline-owned.json'))).toBe(false)
    } finally {
      await rmfs(h.cwd, { recursive: true, force: true })
    }
  })
})
