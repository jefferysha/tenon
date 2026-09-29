/**
 * sync 命令 —— 版本化项目内资产同步（BACKLOG #24，对标老仓 pipeline-sync.sh + update-upgrade.py）。
 * 语义盘点与老仓行号见 kernel/src/state/ownership.ts 顶注（E 段）。**默认只报告不改盘**。
 *
 * 三子命令（老仓 pipeline-sync.sh sync|banner|upgrade-channel）：
 *   sync（默认）：决策层顺序铁律 —— downgrade-guard（拒即整体 return）→ needs_codex_upgrade（裸 manifest，
 *     先于 prune）→ prune（codex 进 known、persist 仅 --migrate）→ AGENTS.md Codex 受管块比对（刷新仅
 *     --migrate）→ config-section 注入门 → --migrate 硬闸（breaking∧recommend 双真 → exit 1，不可降级为
 *     提示）。报告以单行 JSON 落 stdout（SKILL 消费）。
 *   banner：项目 .pipeline-version vs CLI 版纯本地比对（零网络），落后才输出 nudge。
 *   upgrade-channel：从 installed_plugins.json（注入文本）按后缀派生 latest/beta/rc。
 *
 * ★诚实 stub（BACKLOG #24 诚实门）：迁移注册表（老仓 migrations.py get_migrations_for_version /
 *   get_migration_metadata）+ 执行器（migrate-exec.py）在 lite 没有对应实现——那是独立子系统
 *   （备份先行/hash 闸/根守护三闸）。故 pending/metadata 由注入的 SyncMigrationProvider 提供，
 *   缺省 STUB=空 pending + 无 breaking：sync 决策层全量可跑，但「真跑迁移落盘」面是 stub、不伪造。
 *   实际后果：缺省注入下 --migrate 硬闸永不触发（无 pending、无 breaking），迁移相关分支恒走空集路径。
 */
import {
  AGENTS_MD,
  CODEX_AGENTS_BLOCK,
  CODEX_UPGRADE_MARKERS,
  bannerNudge,
  createOwnedFs,
  deriveChannelFromInstalled,
  guardDowngrade,
  loadOwnedManifest,
  migrateGateDecision,
  needsCodexUpgrade,
  pruneOwnedManifest,
  readVersionFile,
  refreshManagedBlock,
  saveOwnedManifest,
  shouldInjectConfigSections,
  type OwnedFs,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

/**
 * 迁移注册表注入面（老仓 migrations.py 的 lite 替身）。缺省 STUB：无 pending、无 breaking；
 * 真注册表由调用方注入（见顶注诚实 stub）。
 */
export interface SyncMigrationProvider {
  /** from→to 半开区间的 pending 迁移路径（老仓 get_migrations_for_version 的 from/to 并集）。 */
  pending: (fromVersion: string, toVersion: string) => string[]
  /** 迁移元数据（老仓 get_migration_metadata）：是否 breaking / 是否建议 --migrate。 */
  metadata: (fromVersion: string, toVersion: string) => { breaking?: boolean; recommend_migrate?: boolean }
}

const STUB_MIGRATIONS: SyncMigrationProvider = { pending: () => [], metadata: () => ({}) }

export interface SyncOpts {
  /** 子命令，缺省 'sync'。 */
  sub?: 'sync' | 'banner' | 'upgrade-channel'
  /** CLI 版本（single source of truth = plugin 版本；main.ts 注入）。 */
  cliVersion: string
  migrate?: boolean
  allowDowngrade?: boolean
  /** upgrade-channel：installed_plugins.json 文本（main.ts 读文件后注入；测试传 fixture）。 */
  installedJson?: string
  pluginKey?: string
  /** 迁移注册表（缺省 STUB）。 */
  migrations?: SyncMigrationProvider
}

/** 单行 JSON 落 stdout（老仓 _emit：SKILL 用 jq/python 解析）。 */
function emit(deps: CliDeps, obj: unknown): void {
  deps.io.out(JSON.stringify(obj))
}

/** sync 主决策层（老仓 _cmd_sync:428-491，顺序铁律）。 */
async function runSync(deps: CliDeps, opts: SyncOpts, fs: OwnedFs): Promise<number> {
  const cwd = deps.cwd
  const cliVersion = opts.cliVersion
  const migrate = opts.migrate === true
  const migrations = opts.migrations ?? STUB_MIGRATIONS

  const projectVersion = await readVersionFile(fs, cwd)

  // 1. downgrade-guard：proceed=false 直接 return（不写）。
  const guard = guardDowngrade(cliVersion, projectVersion, opts.allowDowngrade === true)
  if (!guard.proceed) {
    emit(deps, { stage: 'downgrade-guard', proceed: false, guard })
    for (const m of guard.messages) deps.io.err(m) // 降级可见（GOAL B8）：明示为何拒。
    return 0 // 默认拒不是错误退出码；调用方据 proceed=false 停手。
  }

  // pending 迁移 + 元数据（stub 缺省空）。
  const pending = migrations.pending(projectVersion, cliVersion)
  const metadata = migrations.metadata(projectVersion, cliVersion)

  // 2. needs_codex_upgrade（读裸 manifest，先于 prune）。
  const manifest = await loadOwnedManifest(fs, cwd)
  const hasCodexDir = await fs.isDir(`${cwd.replace(/\/+$/, '')}/.codex`)
  const codexNeeded = needsCodexUpgrade(hasCodexDir, Object.keys(manifest))

  // 3. prune（codex marker 进 known，让其存活到 upgrade 流程；persist 仅 --migrate）。
  //    AGENTS.md 哨兵判定读磁盘（老仓 _should_keep_agents_md(cwd)）。
  const known = codexNeeded ? [...CODEX_UPGRADE_MARKERS] : []
  const agentsMdContent = await fs.readText(`${cwd.replace(/\/+$/, '')}/${AGENTS_MD}`)
  const { kept, pruned } = pruneOwnedManifest(manifest, { knownKeys: known, migrationPaths: pending, agentsMdContent })
  let prunedPersisted = false
  if (pruned.length > 0 && migrate) {
    await saveOwnedManifest(fs, cwd, kept)
    prunedPersisted = true
  }

  // 3b. AGENTS.md 的 Codex 受管块：与本版 CLI 的块比对；report-only 只报告，--migrate 才就地刷新
  //     START…END 之间的行（块外用户内容原样保留；标记非法一律不写）。
  const agentsMdPath = `${cwd.replace(/\/+$/, '')}/${AGENTS_MD}`
  const block = agentsMdContent === undefined ? { status: 'absent' as const } : refreshManagedBlock(agentsMdContent, CODEX_AGENTS_BLOCK)
  let codexBlock: 'absent' | 'current' | 'invalid' | 'stale' | 'refreshed' = block.status
  if (block.status === 'stale' && migrate) {
    await fs.writeText(agentsMdPath, block.content)
    codexBlock = 'refreshed'
  }

  // 4. config-section 注入门（仅 cli>project ∧ ≠unknown；unknown 判定内建于 shouldInjectConfigSections）。
  const injectConfig = shouldInjectConfigSections(cliVersion, projectVersion)

  // 5. --migrate 硬闸决策。
  const gate = migrateGateDecision(pending.length, migrate, cliVersion, projectVersion, metadata)

  emit(deps, {
    stage: 'sync',
    proceed: true,
    downgrade_action: guard.action,
    project_version: projectVersion,
    cli_version: cliVersion,
    pending_count: pending.length,
    codex_upgrade_needed: codexNeeded,
    codex_block: codexBlock,
    pruned,
    pruned_persisted: prunedPersisted,
    inject_config_sections: injectConfig,
    migrate_flag: migrate,
    migrate_gate: gate,
    report_only: !migrate,
  })
  if (codexBlock === 'stale') deps.io.err('AGENTS.md 的 Tenon Codex 受管块已过时：运行 tenon sync --migrate 刷新（块外内容不动）')
  if (codexBlock === 'invalid') deps.io.err('AGENTS.md 的 Tenon 受管块标记不成对或顺序非法，未改写')
  for (const m of gate.messages) deps.io.err(m) // required/tip 消息降级可见。
  return gate.exitCode
}

/** banner 子命令（老仓 _cmd_banner:418-425）。 */
async function runBanner(deps: CliDeps, opts: SyncOpts, fs: OwnedFs): Promise<number> {
  const projectVersion = await readVersionFile(fs, deps.cwd)
  const nudge = bannerNudge(projectVersion, opts.cliVersion)
  if (nudge === null) return 0 // 静默
  emit(deps, nudge)
  return 0
}

/** upgrade-channel 子命令（老仓 _cmd_channel:410-415）。绝不读真实 installed_plugins.json——文本由调用方注入。 */
function runChannel(deps: CliDeps, opts: SyncOpts): number {
  const channel = deriveChannelFromInstalled(opts.installedJson ?? '{}', opts.pluginKey)
  emit(deps, { channel })
  return 0
}

/**
 * sync 命令入口（纯函数 + deps 注入 + OwnedFs 注入，风格同 task.ts）。
 * fs 缺省真 node:fs（integration 走真路径）；mock 层注入 fake 快速回归。
 */
export async function cmdSync(deps: CliDeps, opts: SyncOpts, fs: OwnedFs = createOwnedFs()): Promise<number> {
  try {
    switch (opts.sub ?? 'sync') {
      case 'sync':
        return await runSync(deps, opts, fs)
      case 'banner':
        return await runBanner(deps, opts, fs)
      case 'upgrade-channel':
        return runChannel(deps, opts)
      default:
        deps.io.err(`ERROR: 未知 sync 子命令: ${opts.sub}（支持: sync banner upgrade-channel）`)
        return 2
    }
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 2
  }
}
