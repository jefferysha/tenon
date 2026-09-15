/**
 * commander 装配：CONTRACT §3 全表命令 → 纯函数命令模块。
 * 命令函数返回 exit code；非 0 以 CliExit 抛出，由 main.ts 落到 process.exitCode
 * （commander 自身的 usage error 经 exitOverride 也抛出，main 统一映射 exit 1）。
 */
import { Command } from 'commander'
import { PRODUCT_IDENTITY } from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { cmdCheck } from './commands/check.js'
import type { DashboardRuntime } from './commands/dashboard.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdCas, cmdGet, cmdSet, cmdSetMany } from './commands/fields.js'
import { cmdArtifactRegister } from './commands/artifact.js'
import {
  cmdDocumentInit,
  cmdDocumentMigrateDelta,
  cmdDocumentRead,
  cmdDocumentRecord,
  cmdDocumentScaffold,
  cmdDocumentStatus,
} from './commands/document.js'
import { cmdImport } from './commands/import.js'
import { cmdInbox } from './commands/inbox.js'
import { cmdAdvance } from './commands/advance.js'
import { cmdAfk } from './commands/afk.js'
import { cmdChannel } from './commands/channel.js'
import { cmdGenRouterSh } from './commands/gen-router.js'
import { cmdInit, type InitCmdOpts } from './commands/init.js'
import { cmdLoops } from './commands/loops.js'
import { cmdMem } from './commands/mem.js'
import { cmdScaffold } from './commands/scaffold.js'
import { cmdSession } from './commands/session.js'
import { cmdSpec } from './commands/spec.js'
import { cmdSync } from './commands/sync.js'
import { cmdTap } from './commands/tap.js'
import { cmdTask } from './commands/task.js'
import { cmdUninstall } from './commands/uninstall.js'
import { cmdList, cmdStatus } from './commands/status.js'
import { cmdTransition } from './commands/transition.js'
import { cmdInternalSkillGate } from './commands/internalSkillGate.js'
import { cmdInternalConstraintGate } from './commands/internalConstraintGate.js'
import { cmdInternalCodexJsonl } from './commands/internalCodexJsonl.js'
import { cmdInternalSkillProvenance } from './commands/internal-skill-provenance.js'
import { cmdMigrateWorkflow } from './commands/migrateWorkflow.js'
import { cmdStateProjection } from './commands/state-projection.js'
import { cmdTriage, type TriageCommandRuntime } from './commands/triage.js'
import { bail, stripNl } from './program-exit.js'
import { registerInstallCommands } from './program-install.js'
import { registerTrackCommands } from './program-tracks.js'
import { registerHandoffCommand, registerWorkflowCommands } from './program-workflows.js'
import { registerSkillInvocationInternalCommands } from './program-skill-invocations.js'
import { registerReviewCommands } from './program-review.js'
import { LOOPS_HELP } from './program-help.js'
import { registerOrchestrationCommands } from './program-orchestration.js'
export { CliExit } from './program-exit.js'

export interface ProgramRuntimes {
  readonly triage?: TriageCommandRuntime
  /** Injectable only for command tests; production resolves the installed plugin root. */
  readonly dashboard?: DashboardRuntime
}

export function buildProgram(deps: CliDeps, runtimes: ProgramRuntimes = {}): Command {
  const program = new Command(PRODUCT_IDENTITY.cli)
  program
    .description(`${PRODUCT_IDENTITY.displayName} 状态机 CLI（CONTRACT §3）`)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.io.out(stripNl(s)),
      writeErr: (s) => deps.io.err(stripNl(s)),
    })

  program
    .command('init <name>')
    .description('初始化 change（stdout 无输出，路径信息走 stderr）')
    // track/preset 非 requiredOption：缺省时 TTY 下走交互向导补齐、非交互 fail-loud（见 cmdInit）；
    // 若用 requiredOption，commander 会抢在 action 前就报错，向导没机会跑。
    .option('--track <track>', 'chat | simple | pm | frontend | backend | free | custom')
    .option('--preset <preset>', 'full | hotfix | tweak')
    .option('--user <user>', 'created_by')
    .option('--workflow <workflow>', '自定义 workflow 名（.pipeline/workflows/<name>.yaml），缺省 default')
    .option('--document-locale <locale>', '治理文档语言：zh-CN（默认）| en')
    .action(async (name: string, opts: InitCmdOpts) => bail(await cmdInit(deps, name, opts)))

  registerInstallCommands(program, deps, runtimes.dashboard)
  registerOrchestrationCommands(program, deps)

  program
    .command('get <name> <field>')
    .description('读字段（stdout: 裸值；字段缺失/未知 → 空行 + exit 0）')
    .action(async (name: string, fieldName: string) => bail(await cmdGet(deps, name, fieldName)))

  program
    .command('set <name> <field> <value>')
    .description('写字段（无输出；四闸拒写 exit 1）')
    .action(async (name: string, fieldName: string, value: string) =>
      bail(await cmdSet(deps, name, fieldName, value)))

  program
    .command('set-many <name> <kv...>')
    .description('多字段原子写 key=value ...（无输出）')
    .action(async (name: string, kv: string[]) => bail(await cmdSetMany(deps, name, kv)))

  program
    .command('cas <name> <field> <expect> <next>')
    .description('compare-and-set（无输出；不匹配 exit 3）')
    .action(async (name: string, fieldName: string, expect: string, next: string) =>
      bail(await cmdCas(deps, name, fieldName, expect, next)))

  // ── artifact：受 artifact 契约约束的单字段写（G2 P5）——Commander 真子命令树（同 tracks 装配惯例，
  // exitOverride/configureOutput 由父命令继承；--producer 缺失 = usage error → main 映射 exit 1）。
  const artifact = program
    .command('artifact')
    .description('artifact 登记：register <change> <field> <path> --producer <skill-id>（受 declaration+producer 校验约束的单字段写）')
    .action(() => {
      deps.io.err('用法：tenon artifact register <change> <field> <path> --producer <skill-id>')
      bail(1)
    })
  artifact
    .command('register <change> <field> <path>')
    .description('登记一条 artifact：校验当前 step/track 的 declaration + producer 具体 skill，锁内原子写字段（成功静默 exit 0；任一校验不过 exit 1、state 不变）')
    .requiredOption('--producer <skill-id>', '产出该 artifact 的具体 skill id（须命中当前 step/track 有效 skill 集的某个具体 alternative；整个 a|b token 非法）')
    .action(async (change: string, field: string, path: string, opts: { producer: string }) =>
      bail(await cmdArtifactRegister(deps, change, field, path, opts.producer)))

  const document = program
    .command('document')
    .description('OpenSpec 文档证据：init / scaffold / record / migrate-delta / read / status')
    .action(() => {
      deps.io.err('用法：tenon document init|record|migrate-delta|read|status <change> ...')
      bail(1)
    })
  document
    .command('init <change>')
    .description('为既有受治理 Change 创建 .pipeline-documents.json（新建 Change 已自动创建）')
    .action(async (change: string) => bail(await cmdDocumentInit(deps, change)))
  document
    .command('scaffold <change> <kind>')
    .description('按 Change 固定 locale 幂等创建受 contract 声明的文档结构；不登记 producer 或读取证据')
    .option('--locale <locale>', '仅旧 Change 可显式选择 zh-CN | en；已固定 Change 必须一致')
    .option('--capability <name>', 'delta-spec 的真实 capability；不得用 Change 名代替')
    .action(async (change: string, kind: string, opts: { locale?: string; capability?: string }) =>
      bail(await cmdDocumentScaffold(deps, change, kind, opts.locale, opts.capability)))
  document
    .command('record <change> <kind> <path>')
    .description('登记当前 phase 产出或允许更新的文档和实际 Skill 调用证据；旧 Change 可显式 --backfill 首次补登记前序文档')
    .requiredOption('--producer <skill-id>', '实际生成该文档的具体 skill id')
    .option('--backfill', '仅升级旧 Change 时首次补登记此前 phase 的未登记文档；不得覆盖已有 record，仍须有真实 skill 证据')
    .action(async (change: string, kind: string, path: string, opts: { producer: string; backfill?: boolean }) =>
      bail(await cmdDocumentRecord(deps, change, kind, path, opts.producer, opts.backfill === true)))
  document
    .command('migrate-delta <change> <legacy-path> <canonical-path>')
    .description('显式迁移一个旧 delta record；仅当 canonical 文件与旧 digest 完全一致时原子替换，可幂等重试')
    .action(async (change: string, legacyPath: string, canonicalPath: string) =>
      bail(await cmdDocumentMigrateDelta(deps, change, legacyPath, canonicalPath)))
  document
    .command('read <change> <kind>')
    .description("登记当前 phase 已读取文档（kind 可为 'all'）")
    .action(async (change: string, kind: string) => bail(await cmdDocumentRead(deps, change, kind)))
  document
    .command('status <change>')
    .description('显示文档产物、内容摘要和当前 phase 的读取收据（不完整 exit 2）')
    .option('--json', 'JSON 输出')
    .action(async (change: string, opts: { json?: boolean }) =>
      bail(await cmdDocumentStatus(deps, change, opts.json === true)))

  program
    .command('transition <name> <event>')
    .description('状态机转换（stdout 无输出，[TRANSITION] 走 stderr；非法/未知事件 exit 1）')
    .action(async (name: string, event: string) => bail(await cmdTransition(deps, name, event)))

  registerReviewCommands(program, deps)

  program
    .command('check <name>')
    .description('guard 前置校验（人读报告；不过 exit 2）')
    .action(async (name: string) => bail(await cmdCheck(deps, name)))

  program
    .command('advance <name>')
    .description('auto-transition 中间档：guard 全绿自动推进，撞三门/终态/guard 不过即停（HITL，D12>Tenon runtime）')
    .option('--max-steps <n>', '防失控保险丝（默认 12）', (v: string) => parseInt(v, 10))
    .option('--dry-run', '只报计划不推进')
    .option('--through-gates', '放行复核相位（confirm/interaction 硬门仍不跨越）')
    .action(async (name: string, opts: { maxSteps?: number; dryRun?: boolean; throughGates?: boolean }) =>
      bail(await cmdAdvance(deps, name, opts)))

  registerHandoffCommand(program, deps)

  program
    .command('import <name>')
    .description('老仓 change 历史区 → .pipeline-history.jsonl（--strip 同时清理 YAML 历史节）')
    .option('--strip', '导入后从 .pipeline.yaml 移除历史节（其余尾内容保留）')
    .action(async (name: string, opts: { strip?: boolean }) => bail(await cmdImport(deps, name, opts)))

  program
    .command('doctor')
    .description('统一健康面：哪些保障此刻真的在生效/已静默降级（exit 1=有红灯）')
    .option('--json', 'JSON 输出（schema 稳定）')
    .action(async (opts: { json?: boolean }) => bail(await cmdDoctor(deps, opts)))

  program
    .command('task <sub> [args...]')
    .description('task lifecycle：add-dep / remove-dep <name> <dep> · children / cascade / canonical <name>')
    .option('--json', 'JSON 输出（children / canonical）')
    .action(async (sub: string, args: string[], opts: { json?: boolean }) =>
      bail(await cmdTask(deps, sub, opts.json ? [...args, '--json'] : args)))

  program
    .command('scaffold <sub> [args...]')
    .description('Tenon contract parity：scaffold 按类型铺分层空文档集 · resolve-workflow 多 id 解析（D2/B16）')
    .allowUnknownOption()
    .action(async (sub: string, args: string[]) => bail(await cmdScaffold(deps, sub, args)))

  program
    .command('spec <sub> [args...]')
    .description('living-spec：specs · set-spec-scope <cap> [scope] · inject-jsonl <cap> [agent]')
    .option('--json', 'JSON 输出（specs）')
    .action(async (sub: string, args: string[], opts: { json?: boolean }) =>
      bail(await cmdSpec(deps, sub, opts.json ? [...args, '--json'] : args)))

  program
    .command('session <sub> [args...]')
    .description('session：activate <name> [--continuous] [--host-session <id>] · route-context <name> [--json]')
    .option('--json', 'JSON 输出（route-context）')
    .option('--continuous', '仅 activate：绑定当前 Change 的持续交互授权')
    .option('--host-session <id>', '仅 activate：绑定原生 host session，供 dashboard 判断普通会话是否仍在执行')
    .action(async (sub: string, args: string[], opts: { json?: boolean; continuous?: boolean; hostSession?: string }) => {
      const forwarded = [...args]
      if (opts.json) forwarded.push('--json')
      if (opts.continuous) forwarded.push('--continuous')
      if (opts.hostSession !== undefined) forwarded.push('--host-session', opts.hostSession)
      bail(await cmdSession(deps, sub, forwarded))
    })

  program
    .command('inbox')
    .description('收件箱：等待人工决策的 change（三门 marker + 复核相位）')
    .option('--json', 'JSON 输出（schema 稳定）')
    .option('--html', '自足静态单页（重定向到文件用浏览器打开）')
    .action(async (opts: { json?: boolean; html?: boolean }) => bail(await cmdInbox(deps, opts)))

  program
    .command('status [name]')
    .description('change 摘要（无 name 列全部活跃）')
    .option('--json', 'JSON 输出（schema 稳定）')
    .action(async (name: string | undefined, opts: { json?: boolean }) =>
      bail(await cmdStatus(deps, name, opts)))

  registerWorkflowCommands(program, deps)

  program
    .command('list')
    .description('活跃 change 表')
    .option('--json', 'JSON 输出（schema 稳定）')
    .action(async (opts: { json?: boolean }) => bail(await cmdList(deps, opts)))

  program
    .command('triage <source>')
    .description('H12 生产 triage：git-commits | loop-run-terminals；成功页提交 durable checkpoint，可原命令幂等续跑')
    .option('--provider <provider>', '分类 provider（默认 codex；生产仅支持 codex）', 'codex')
    .option('--model <model>', 'Codex triage model（缺省使用 host 固定默认）')
    .option('--page-size <n>', '每页 observation 上限（默认 20）', '20')
    .option('--max-pages <n>', '本次最多提交页数（默认 4；到限可原命令续跑）', '4')
    .option('--max-high-candidates <n>', '每页最多创建的 high WorkflowRun（默认 10）', '10')
    .option('--json', '单行稳定 JSON 输出')
    .addHelpText('after', '\nsource: git-commits（当前仓 HEAD）| loop-run-terminals（当前仓 durable loop ledger）')
    .action(async (source: string, opts: import('./commands/triage.js').TriageCmdOpts) =>
      bail(await cmdTriage(deps, source, opts, runtimes.triage)))

  program
    .command('sync [sub]')
    .description('项目内资产同步（downgrade-guard / prune / config 门 / --migrate 硬闸）')
    .option('--migrate', '放行迁移硬闸（缺省只报告不改盘；注意缺省未注入迁移执行器时本闸恒空转）')
    .option('--allow-downgrade', '放行降级同步')
    .action(async (sub: string | undefined, opts: { migrate?: boolean; allowDowngrade?: boolean }) => {
      const installedJson = await deps.readInstalledPlugins?.()
      bail(await cmdSync(deps, {
        sub: sub as 'sync' | 'banner' | 'upgrade-channel' | undefined,
        cliVersion: deps.pluginVersion ?? 'unknown',
        migrate: opts.migrate,
        allowDowngrade: opts.allowDowngrade,
        installedJson,
      }))
    })

  program
    .command('uninstall')
    .description('卸载 + 所有权 scrubber（只删自己装的、用户改过的保留）')
    .option('-y, --yes', '非交互确认')
    .option('--dry-run', '只打印计划不落盘')
    .action(async (opts: { yes?: boolean; dryRun?: boolean }) =>
      bail(await cmdUninstall(deps, { yes: opts.yes, dryRun: opts.dryRun })))

  program
    .command('afk <sub> [name]')
    .description('AFK 自动化：enqueue <name> [--loop <id>] 挂队(+显式绑定 loop) / scan 就绪队列 / status [name] 泳道 / run 真跑 docker 沙箱 / cancel <name> 取消运行中任务（落取消标记 + docker kill，对齐 server /api/afk/:name/cancel）')
    .option('--json', 'JSON 输出')
    .option('--level <level>', 'run：分级放权档位覆盖（L1|L2|L3，缺省 L1 report-only 安全默认）')
    .option('--image <image>', 'run：sandcastle 镜像名（缺省 sandcastle:local）')
    .option('--loop <loop-id>', 'enqueue：显式绑定该 change 到 loop（落 explicit change-loop-binding，admission 归属不再前缀猜）')
    .action(async (sub: string, name: string | undefined, opts: { json?: boolean; level?: string; image?: string; loop?: string }) =>
      bail(await cmdAfk(deps, sub, name, opts)))

  program
    .command('loops <sub> [args...]')
    .alias('loop')
    .description('loop 治理：init 起草草稿（向导/非交互）· list 登记表 · enforce R1-R11 裁决 · status（B18/D16，L1→L3 分级放权）')
    .allowUnknownOption()
    // 子命令是手解析的（loops <sub> [args...] 单命令），commander 的 --help 只显父用法看不到 init 的
    // --id/--goal 等（小白无法从 --help 发现）。补一段 after-help 列出子命令 + init 关键 flags + 示例。
    .addHelpText('after', LOOPS_HELP)
    .action(async (sub: string, args: string[]) => bail(await cmdLoops(deps, sub, args)))

  program
    .command('channel <sub> [args...]')
    .description('正交 worker 层（event-sourced）：create/send/wait/messages/thread/forum/registry …')
    .allowUnknownOption() // flag 由 cmdChannel 自解析
    .action(async (sub: string, args: string[]) => bail(await cmdChannel(deps, sub, args)))

  program
    .command('mem <sub> [args...]')
    .description('跨 runtime 会话检索：list · search <kw> · context <id> · extract <id> · projects')
    .allowUnknownOption() // --json/--limit/--phase 等 flag 由 cmdMem 自解析
    .action(async (sub: string, args: string[]) => bail(await cmdMem(deps, sub, args)))

  program
    .command('tap <sub> [args...]')
    .description('tap 流量代理：start <client...> [--ca [dir]] [--json] [-- <command> ...]（daemon 启动器，#34-wire）')
    .allowUnknownOption() // --ca/--json/-- <command> 由 cmdTap 自解析（-- 之后原样透传，不可用 commander 解析）
    .action(async (sub: string, args: string[]) => bail(await cmdTap(deps, sub, args)))

  program
    .command('_gen-router-sh <manifest> <repo-root>')
    .description('[内部] 从 manifest + effective track registry 派生项目 router data cache（router.sh 调用）')
    .action(async (manifest: string, repoRoot: string) =>
      bail(await cmdGenRouterSh(deps, manifest, repoRoot)))

  program
    .command('internal-skill-gate <name> <skillId>')
    .description('[内部] 非 default workflow 的 skill DAG 解锁判定（hooks/gate.sh 委托目标；0=放行 2=拦截）')
    .action(async (name: string, skillId: string) => bail(await cmdInternalSkillGate(deps, name, skillId)))

  program
    .command('internal-constraint-gate <operation> <nulPathsFile>')
    .description('[内部] AutomationPolicy 路径授权（0=放行 2=拒绝 1=输入损坏）')
    .action(async (operation: string, nulPathsFile: string) =>
      bail(await cmdInternalConstraintGate(deps, operation, nulPathsFile)))

  program
    .command('internal-codex-jsonl <mode> <jsonlPath>')
    .description('[内部] 解析 host-owned codex exec --json 事件（usage|transitions）')
    .action(async (mode: string, jsonlPath: string) =>
      bail(await cmdInternalCodexJsonl(deps, mode, jsonlPath)))

  program
    .command('internal-skill-provenance <mode>', { hidden: true })
    .description('[内部] canonical Skill provenance verify|sync（供 bundled verifier 使用）')
    .option('--root <path>', '插件/release root')
    .option('--json', '输出结构化 findings')
    .option('--quiet', '成功时不输出')
    .action(async (mode: string, opts: { root?: string; json?: boolean; quiet?: boolean }) =>
      bail(await cmdInternalSkillProvenance(deps, mode, opts)))

  registerSkillInvocationInternalCommands(program, deps)

  program
    .command('migrate-workflow <name>')
    .description('[一次性] 老格式 change 补齐/确认 workflow 字段为 default（真实自定义 workflow 不覆盖）')
    .action(async (name: string) => bail(await cmdMigrateWorkflow(deps, name)))

  program
    .command('state <sub> <name>')
    .description('canonical state 运维：status | repair-projection | import-legacy | pin-workflow-snapshot')
    .option('--json', '稳定 JSON 输出')
    .option('--force-canonical', 'repair-projection：明确用 canonical 覆盖未知 YAML drift')
    .option('--workflow-file <path>', 'pin-workflow-snapshot：必须与已绑定 fingerprint 完全一致的旧 workflow 文件')
    .action(async (
      sub: string,
      name: string,
      opts: { json?: boolean; forceCanonical?: boolean; workflowFile?: string },
    ) => bail(await cmdStateProjection(deps, sub, name, opts)))

  registerTrackCommands(program, deps)

  program.addHelpText(
    'after',
    '\n首次安装：tenon setup --codex（或 --claude；安装完整打包插件并配就绪）——随后再用 init 起 change。',
  )

  return program
}
