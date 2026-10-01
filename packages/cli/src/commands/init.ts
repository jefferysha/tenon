/**
 * init <name> --track --preset [--workflow] —— 初始化 change（creator/负责人 = 当前声明身份，缺失 exit 1）（CONTRACT §3，
 * 2026-07-06 oracle 实测回写：老内核 init stdout 为空，创建路径改走 stderr 信息行）。
 * stdout：无；exit 0/1。
 *
 * --workflow（GOAL E，whole-branch review 补：此前没有任何支持的命令能把一个 change 摆到
 * 自定义 workflow 的首个 step 上，除非该 step 恰好叫 open——`tenon set phase <custom-id>`
 * 被 manifest 派生的 7 相位枚举挡下，`migrate-workflow` 只处理已存在的 change。此处新增的
 * `--workflow` 选项省略/传 'default' 时行为与此前完全一致（未提供本选项的既有调用零回归）；
 * 显式传非 default 名字时，真加载 + 校验该 workflow（复用 loadWorkflow，Fix E5 已经接的
 * validateWorkflow 在这里同样生效——非法 workflow 文件在 init 这一步就 fail-loud，不会让
 * 一个引用了坏 workflow 的 change 先被创建出来），再把 workflow 字段设成该名字、phase 字段
 * 种到它 steps[0] 的 id（而不是硬编码的 'open'）。这里故意绕开 CLI `set` 子命令那层的
 * enumOk（对齐 manifest.phases 的老内核枚举校验，仅对 `tenon set phase ...` 这一入口生效）
 * ——workflow/phase 首态随 `runRepo.initChange()` 的 `initialWorkflow` 参数，进 kernel
 * `StateStore.init()` 独占创建那唯一一次原子写入（第 7 轮 codex review P1：此前是 initChange
 * 之后再补一次 StateStore.setMany，两次写之间有竞态窗口，见 store.ts init() 头部注释），
 * 校验仍只有 quoteGate（YAML 安全字符集），不做语义枚举校验，custom workflow 的任意合法 step
 * id 在这里天然放行，且完全不触碰 enumOk/cmdSet 共享代码路径（zero 改动、zero 回归风险 to
 * oracle 覆盖的 default workflow 主线）。
 */
import { createInterface } from 'node:readline/promises'
import {
  assertWorkflowAllowed,
  effectiveWorkflowPlanBinding,
  ensureAgentFreeze,
  isDefaultWorkflowName,
  loadEffectiveWorkflowPlan,
  prepareAgentFreeze,
  readFrozenAgents,
  requireTrackForRoot,
  retiredSkillReferences,
  retiredSkillsWorkflowMessage,
  workflowPlanSnapshot,
} from '@tenon/kernel'
import type { TrackDefinition, TrackRegistry } from '@tenon/kernel'
import type { DocumentLocale } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { recordHistory } from './fields.js'
import { isValidChangeName } from '../paths.js'
import { autoDiscoverCatalog } from '../test-system/auto-discover.js'
import { requireActor } from '../userIdentity.js'
import { ensureChangeHostAgents, hostAgentHostOf } from './agent-host.js'
import { msg } from '../i18n/messages.js'

/** 冻结 agent 后为当前宿主生成 `tenon-<name>` 子代理文件；终端里不生成，失败只 WARN。 */
async function generateHostAgents(deps: CliDeps, changeDir: string, runId: string, workflowFingerprint: string): Promise<void> {
  const host = hostAgentHostOf(deps)
  if (host === undefined) return
  try {
    await ensureChangeHostAgents(deps, host, await readFrozenAgents({ changeDir, runId, workflowFingerprint }))
  } catch (e) {
    deps.io.err(`WARN: 宿主 agent 文件未生成（${errMsg(e)}），运行时改用通用子代理`)
  }
}

/**
 * 工作流声明了测试策略而项目还没有测试目录时，立项后自动识别并写入 `.tenon/tests/catalog.yaml`，并明说做了什么、
 * 请用户审阅——否则第一个任务会在规格步被 `test-catalog-missing` 挡住，要手动跑一遍 discover。
 * 只在没有目录时动手：已有目录（含无效的）不碰；识别失败只提示，不让已成功的 init 失败。
 */
async function announceAutoDiscover(deps: CliDeps): Promise<void> {
  try {
    const outcome = await autoDiscoverCatalog(deps.cwd)
    if (outcome.state === 'written') {
      deps.io.err(`[TEST] 项目还没有测试目录：已自动识别 ${outcome.suites.length} 个套件并写入 .tenon/tests/catalog.yaml（${outcome.suites.join('、')}）`)
      deps.io.err('  请审阅每个套件的命令、报告路径和文件 glob 后提交（tenon test catalog show 查看；tenon test discover 重新识别）')
      for (const note of outcome.notes) deps.io.err(`  提示：${note}`)
    } else if (outcome.state === 'none') {
      deps.io.err('[TEST] 项目还没有测试目录，自动识别没有找到测试工具：用 tenon test catalog add 登记套件；项目确实没有测试就 tenon test catalog not-applicable unit --reason \'<原因>\'（经评审确认一次后生效）')
      for (const note of outcome.notes) deps.io.err(`  提示：${note}`)
    } else if (outcome.state === 'failed') {
      deps.io.err(`WARN: 自动识别测试目录失败（${outcome.message}）；稍后执行 tenon test discover --write`)
    }
  } catch (e) {
    deps.io.err(`WARN: 自动识别测试目录失败（${errMsg(e)}）；稍后执行 tenon test discover --write`)
  }
}

export interface InitCmdOpts {
  // track/preset 为 optional：program.ts 用 .option（非 .requiredOption）注册，缺省时由交互
  // 向导（TTY）补齐或非交互 fail-loud——commander 不再抢在 action 前拦截，向导才有机会跑。
  track?: string
  preset?: string
  workflow?: string
  documentLocale?: string
}

// ── 交互向导的注入面（真实现 = REAL_INIT_WIZARD_ENV；测试注入 fake，命名避开 loops 的 InitEnv/Prompter）──

/** 一问一答面（真实现 = node:readline/promises；测试注入脚本化应答）。 */
export interface InitPrompter {
  ask(prompt: string): Promise<string>
  close(): void
}

/** init 向导注入环境：交互探测 + Prompter 工厂（仅在决定走向导时才 makePrompter）。 */
export interface InitWizardEnv {
  /** 是否交互终端（真实现 = process.stdin.isTTY && process.stdout.isTTY）。 */
  isInteractive(): boolean
  makePrompter(): InitPrompter
}

export const REAL_INIT_WIZARD_ENV: InitWizardEnv = {
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  makePrompter: () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return { ask: (prompt) => rl.question(prompt), close: () => rl.close() }
  },
}

/** preset 闭集：guard 只认 full（direct_override 锁）与 hotfix/tweak（覆盖豁免）。flag 与向导同一份校验，
 *  未知值 exit 1——此前 flag 路径是开放集，`--preset nope` 会被原样存下。 */
const PRESETS: readonly string[] = ['full', 'hotfix', 'tweak']

/** preset 只被 default 工作流的 guard 读取；显式指定自定义工作流时不强制要求（缺省存 'null'）。 */
const isCustomWorkflowFlag = (workflow: string | undefined): boolean =>
  workflow !== undefined && workflow !== '' && !isDefaultWorkflowName(workflow)

/** 问一个带校验的必填项：空输入收默认（若有）；仍为空或校验不过 → 就地重问（交互态语义）。 */
async function askValidated(
  p: InitPrompter, deps: CliDeps, label: string,
  dflt: string | undefined, validate: (s: string) => string | null,
): Promise<string> {
  for (;;) {
    const hasDflt = dflt !== undefined && dflt !== ''
    const ans = (await p.ask(hasDflt ? `${label} [${dflt}]: ` : `${label}（必填）: `)).trim()
    const val = ans === '' ? (dflt ?? '') : ans
    if (val === '') { deps.io.err('该项必填，请输入一个值。'); continue }
    const err = validate(val)
    if (err !== null) { deps.io.err(err); continue }
    return val
  }
}

/** 问一个无校验的可选项：空输入收默认（默认为空则不显示中括号）。 */
async function askPlain(p: InitPrompter, label: string, dflt: string): Promise<string> {
  const ans = (await p.ask(dflt ? `${label} [${dflt}]: ` : `${label}: `)).trim()
  return ans === '' ? dflt : ans
}

/**
 * 交互向导：逐项问答收齐 track/preset（+ 可选 workflow）。已给 flag 作该项默认（回车即收），
 * track 选项与校验从 registry.ordered 生成（不再手抄枚举；缺 tracks.yaml 时即内建 Track），preset 非空，
 * 校验不过就地重问。返回补齐后的 opts（原字段其余保留）。
 */
async function runInitWizard(deps: CliDeps, registry: TrackRegistry, flags: InitCmdOpts, env: InitWizardEnv): Promise<InitCmdOpts> {
  const p = env.makePrompter()
  try {
    deps.io.out('[init] 交互向导 —— 每问展示默认值（中括号内），直接回车即收默认。')
    const trackIds = registry.ordered.map((t) => t.id)
    const track = await askValidated(
      p, deps, `track（${trackIds.join('|')}）`, flags.track,
      (s) => (registry.byId.has(s) ? null : `ERROR: 非法 track '${s}'，允许: ${trackIds.join(' | ')}`),
    )
    const preset = await askValidated(
      p, deps, 'preset（full|hotfix|tweak）', flags.preset,
      // 与 flag 同一闭集：提示列了枚举就必须校验，否则 'ful' 静默建出无效 change。
      (s) => (PRESETS.includes(s) ? null : `ERROR: 非法 preset '${s}'，允许: ${PRESETS.join(' | ')}`),
    )
    const workflowRaw = await askPlain(p, 'workflow（自定义 workflow 名，缺省 default）', flags.workflow ?? '')
    return {
      ...flags,
      track,
      preset,
      workflow: workflowRaw === '' ? undefined : workflowRaw,
    }
  } finally {
    p.close()
  }
}

export async function cmdInit(
  deps: CliDeps, name: string, opts: InitCmdOpts, env: InitWizardEnv = REAL_INIT_WIZARD_ENV,
): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: ${msg(deps, 'change.nameInvalid', { name })}`)
    return 1
  }
  const creator = requireActor(deps)
  if (creator === null) return 1

  // 缺 track/preset：TTY 下走向导补齐（BT6 小白友好），非交互（agent/CI）fail-loud exit 1。
  // 向导用一份 registry 生成选项/校验（仅影响交互提示；权威校验在下方 registry 锁内 fresh-load）。
  // track 且 preset 都已给 → 本块整体不进；golden-oracle 双跑守的非交互主线（内建轨）观测行为不变。
  if (opts.preset !== undefined && opts.preset !== '' && !PRESETS.includes(opts.preset)) {
    deps.io.err(`ERROR: ${msg(deps, 'init.presetInvalid', { preset: opts.preset, allowed: PRESETS.join(' | ') })}`)
    return 1
  }
  const presetRequired = !isCustomWorkflowFlag(opts.workflow)
  if (!opts.track || (!opts.preset && presetRequired)) {
    if (!env.isInteractive()) {
      const missing = [!opts.track ? '--track' : null, !opts.preset && presetRequired ? '--preset' : null].filter(Boolean).join(' ')
      deps.io.err(`ERROR: ${msg(deps, 'init.nonInteractiveMissing', { missing })}`)
      return 1
    }
    let wizRegistry: TrackRegistry
    try {
      wizRegistry = deps.loadRegistry()
    } catch (e) {
      deps.io.err(`ERROR: ${errMsg(e)}`)
      return 1
    }
    opts = await runInitWizard(deps, wizRegistry, opts, env)
  }

  // R3 D4：init 纳入仓级 registry 生命周期锁（锁序 registry → change）——锁内 fresh-load registry
  // 做权威校验、再创建 change，堵住「锁外读 registry、之后才写 change」与 tracks delete 竞争的跨锁
  // TOCTOU（delete 扫描期 init 同轨必等待）。坏 tracks.yaml 在锁内 load 处 fail-loud（外层 catch →
  // exit 1）。requireTrack/assertWorkflowAllowed 全部先于落盘（不留引用坏 workflow 的半成品 change）。
  const wants = { catalog: false }
  try {
    const code = await deps.withRegistryLock(async ({ registry }) => {
      // track 合法性改走锁内 fresh registry（requireTrack）：未注册即拒（缺 tracks.yaml 时等价旧四轨枚举）。
      let track: TrackDefinition
      try {
        track = requireTrackForRoot(registry, opts.track ?? '', deps.cwd, opts.workflow)
      } catch (e) {
        deps.io.err(`ERROR: ${errMsg(e)}`)
        return 1
      }
      if (opts.documentLocale !== undefined
        && opts.documentLocale !== 'zh-CN'
        && opts.documentLocale !== 'en') {
        deps.io.err(`ERROR: ${msg(deps, 'init.documentLocaleInvalid', { locale: opts.documentLocale })}`)
        return 1
      }

      // workflow 绑定（codex 设计 §5）：workflowId = 显式 --workflow ?? track.workflow.default；
      // 校验它在该 track 的 allowed 白名单内、且真实存在可加载。default 走 store.init 老首态（open），
      // 非 default 则种到该 workflow 首个 step。只接 init 构造点、不改 resolveWorkflowName 读取语义。
      const workflowId = opts.workflow && opts.workflow !== '' ? opts.workflow : track.workflow.default
      if (!opts.preset && isDefaultWorkflowName(workflowId)) {
        deps.io.err(`ERROR: ${msg(deps, 'init.presetEmpty', { allowed: PRESETS.join('|') })}`)
        return 1
      }
      try {
        assertWorkflowAllowed(track, workflowId)
      } catch (e) {
        deps.io.err(`ERROR: ${errMsg(e)}`)
        return 1
      }
      let initialWorkflow: {
        workflow: string
        phase: string
        openspecContract?: boolean
        documentContract?: boolean
        documentProfile?: 'legacy-full' | 'document-v1'
        documentGovernanceFingerprint?: string
        workflowPlanFingerprint?: string
        workflowPlanSnapshot?: ReturnType<typeof workflowPlanSnapshot>
      }
      let plan
      try {
        plan = loadEffectiveWorkflowPlan(deps.cwd, workflowId, track)
      } catch (e) {
        deps.io.err(`ERROR: ${errMsg(e)}`)
        return 1
      }
      const first = plan.workflow.steps[0]
      if (first === undefined) {
        deps.io.err(`ERROR: ${msg(deps, 'init.workflowNoSteps', { workflow: workflowId })}`)
        return 1
      }
      // 引用已删除技能的工作流不能开新任务：先改工作流，再立项。
      const retired = retiredSkillReferences(plan)
      if (retired.length > 0) {
        deps.io.err(`ERROR: ${retiredSkillsWorkflowMessage(workflowId, retired)}`)
        return 1
      }
      // 项目级文档的立项前置条件（如前端轨道要求 DESIGN.md 就绪）：先于任何落盘。
      const refused = await deps.creationPrecondition?.({
        workflow: workflowId,
        track: track.id,
        firstStep: first.id,
        ...(plan.capabilities.documents.policy === undefined ? {} : { policy: plan.capabilities.documents.policy }),
      })
      if (refused !== undefined && refused !== null) {
        deps.io.err(`ERROR: ${refused}`)
        return 1
      }
      // agent 内容随 Change 创建冻结：库读不到任何被引用的 agent 就在这里拒绝，Change 还没落盘。
      let freezeAgent
      try {
        freezeAgent = await prepareAgentFreeze(
          plan.workflow,
          deps.agentLibrary ?? (async () => ({ entries: [], sync: { id: 'agents', state: 'unchanged' as const } })),
        )
      } catch (e) {
        deps.io.err(`ERROR: ${msg(deps, 'init.agentMissing', { error: errMsg(e) })}`)
        return 1
      }
      const binding = effectiveWorkflowPlanBinding(plan)
      initialWorkflow = {
        workflow: workflowId,
        phase: first.id,
        ...binding,
        workflowPlanSnapshot: workflowPlanSnapshot(plan),
        ...(plan.capabilities.documents.policy?.id === 'openspec-v1' ? { openspecContract: true } : {}),
        ...(plan.capabilities.documents.policy?.id === 'document-v1' ? { documentContract: true } : {}),
      }

      try {
        // 身份随 init 独占创建一次性写入（W1 第五轮 codex review）；custom workflow 首态随
        // initialWorkflow 进同一次原子发布（第 7 轮 codex review，见 store.ts init() 注释）。
        const { changeDir: created, run } = await deps.runRepo.initChange({
          repoRoot: deps.cwd,
          name,
          track: track.id,
          reviewSeed: track.policyProfile.reviewSeed,
          preset: opts.preset || 'null',
          creator,
          clock: deps.clock,
          documentLocale: (opts.documentLocale ?? 'zh-CN') as DocumentLocale,
          initialWorkflow,
        })
        if (freezeAgent !== undefined) {
          await (deps.agentFreeze ?? ensureAgentFreeze)({
            changeDir: created,
            runId: run.id,
            workflowFingerprint: plan.workflowFingerprint,
            workflow: plan.workflow,
            resolve: freezeAgent,
          })
          await generateHostAgents(deps, created, run.id, plan.workflowFingerprint)
        }
        await recordHistory(deps, created, {
          ts: deps.clock(),
          kind: 'init',
          actor: creator,
        })
        // 决策 D（v5 T2）：init 成功后 best-effort 登记 repoRoot 到机器级项目注册表——注册表任何
        // 故障（损坏/目录不可写）只 WARN，绝不让已成功的 init 失败。
        if (deps.registerProject) {
          try {
            await deps.registerProject(deps.cwd)
          } catch (e) {
            deps.io.err(`WARN: 项目注册表登记失败: ${errMsg(e)}`)
          }
        }
        deps.io.err(`[INIT] ${created}`)
        wants.catalog = plan.workflow.steps.some((step) => step.test_policy !== undefined)
        return 0
      } catch (e) {
        deps.io.err(`ERROR: ${errMsg(e)}`)
        return 1
      }
    })
    // 识别要扫目录树，放在仓级 registry 锁之外。
    if (code === 0 && wants.catalog) await announceAutoDiscover(deps)
    return code
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}
