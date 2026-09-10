/**
 * afk <sub> —— AFK 自动化 CLI 入口（BACKLOG 收敛复查 iteration-29：#29 automation 包此前
 * 无 CLI 可达性，本命令补上；#29-wire 收敛：run 真接 docker 执行，不再只 report）。
 *
 * run 的真容器执行需要：① docker daemon 可用 ② 预构建的 sandcastle 镜像（--image 覆盖，缺省
 * sandcastle:local）。有候选但无 docker → 诚实报告并返回非零，绝不以成功退出伪装已执行；只有
 * ready 队列确实为空的 `empty` 才返回 0（诚实门）。
 * 有 docker → 真调 automation.runRound(createDockerRunChange(...))：真 git worktree、真容器、
 * 真 tenon-afk-run 握手回读、真 barrier build_sha 派生、L3 真 merge-back（L1/L2 report-only
 * 安全默认，成功也只停 paused）。createDockerRunChange 传 deps.store，运行期真写回
 * automation_sandbox/automation_worktree（Task 1 收尾缺口修复：此前只有 lifecycle 编排层写这
 * 两个字段的能力，没有一条真调用链把真 StateStore 接进来，见
 * .superpowers/sdd/task-1-report.md「Concerns」）。
 *
 * 默认 L1 report-only（#29/#38）：enqueue 只挂队不自动跑；--level 覆盖仅影响本次 run 的分级
 * （升档的持久化决策仍走 loops graduation，本命令不改 .pipeline.yaml 之外的任何 level 状态）。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AUTOMATION_STATES, CANCEL_MARKER_FILE, createAutomation, dockerAvailable, makeIdGen, nodeExec,
  AUTOMATION_LEVELS, type AutomationLevel,
} from '@tenon/automation'
import { createLoopLedgerStore, loadRegistry, requireTrackForRoot } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, changesRoot, isValidChangeName } from '../paths.js'
import { str } from '../render.js'
import { runAfkRound } from './afk-executor.js'

export { probeGitCommitAncestry } from './afk-executor.js'

interface AfkOpts { json?: boolean; level?: string; image?: string; loop?: string }

function isAutomationLevel(v: string): v is AutomationLevel {
  return (AUTOMATION_LEVELS as readonly string[]).includes(v)
}

export async function cmdAfk(deps: CliDeps, sub: string, name: string | undefined, opts: AfkOpts): Promise<number> {
  const level: AutomationLevel = opts.level && isAutomationLevel(opts.level) ? opts.level : 'L1'
  if (opts.level && !isAutomationLevel(opts.level)) {
    deps.io.err(`ERROR: --level 需 L1|L2|L3，收到 '${opts.level}'`)
    return 1
  }
  // `tenon afk ...` is an explicit operator entrypoint. It alone opts this invocation into
  // queue mutation; lifecycle callbacks that omit these flags remain fail-safe OFF.
  const auto = createAutomation({
    repoRoot: deps.cwd,
    store: deps.store,
    clock: deps.clock,
    config: { level, enabled: true, defaultOptIn: true },
  })

  switch (sub) {
    case 'enqueue': {
      if (!name || !isValidChangeName(name)) {
        deps.io.err(`ERROR: enqueue 需合法 change 名: '${name ?? ''}'`)
        return 1
      }
      // GOAL H · Stage B 显式绑定入口：--loop 校验 loop 存在 + 落一条 explicit change-loop-binding
      // （admission 优先级②直接读它，不再前缀猜）。loop 不存在 fail-loud（不静默）。
      if (opts.loop !== undefined) {
        const reg = loadRegistry(deps.cwd)
        if (reg.data === null || !reg.data.loops.some((l) => l.id === opts.loop)) {
          deps.io.err(`ERROR: --loop '${opts.loop}' 在 .pipeline/loops.yaml 中不存在（无法显式绑定）`)
          return 1
        }
      }
      try {
        const queued = await auto.enqueue(
          name,
          (trackId) => requireTrackForRoot(deps.loadRegistry(), trackId, deps.cwd).policyProfile,
        )
        let bound = false
        if (opts.loop !== undefined) {
          const ledger = createLoopLedgerStore()
          const id = makeIdGen()
          await ledger.append(deps.cwd, {
            schema_version: 1, record_id: id('rec'), recorded_at: deps.clock(),
            kind: 'change-loop-binding', change: name, loop_id: opts.loop, source: 'explicit',
          })
          bound = true
        }
        if (opts.json) deps.io.out(JSON.stringify({ change: name, queued, loop: opts.loop ?? null, bound }))
        else {
          deps.io.err(queued ? `[AFK] ${name} 已挂队（automation=queued，默认 L1 report-only）` : `[AFK] ${name} 未挂队（策略未授权 / 非 spec-complete / 已在队 / 未 opt-in）`)
          if (bound) deps.io.err(`[AFK] ${name} 已显式绑定 loop '${opts.loop}'（explicit change-loop-binding）`)
        }
        return queued ? 0 : 3 // 3=未入队（非错误，可判别）
      } catch (e) {
        deps.io.err(`ERROR: ${errMsg(e)}`)
        return 1
      }
    }
    case 'scan': {
      try {
        const ready = await auto.scanReady()
        if (opts.json) deps.io.out(JSON.stringify({ ready }))
        else if (ready.length === 0) deps.io.out('AFK 就绪队列空——无 queued 且依赖满足的 change')
        else { deps.io.out(`AFK 就绪队列（${ready.length}）:`); for (const n of ready) deps.io.out(`  - ${n}`) }
        return 0
      } catch (e) {
        deps.io.err(`ERROR: ${errMsg(e)}`)
        return 1
      }
    }
    case 'status': {
      // 聚合各 change 的 automation_* 字段 → 泳道（同 server /api/afk/snapshot 口径，本地 CLI 版）
      const root = changesRoot(deps.cwd)
      const lanes: Record<string, string[]> = Object.fromEntries(AUTOMATION_STATES.map((s) => [s, []]))
      let names: string[]
      try { names = await deps.listChanges(root) } catch { names = [] }
      for (const n of name ? [name] : names) {
        try {
          const fields = (await deps.store.read(changeDir(deps.cwd, n))).fields
          const a = str(fields.automation) || 'off'
          const lane = lanes[a]
          if (lane) lane.push(n)
        } catch { /* 坏 change 跳过 */ }
      }
      const active = Object.fromEntries(Object.entries(lanes).filter(([, v]) => v.length > 0))
      if (opts.json) { deps.io.out(JSON.stringify({ lanes: active })); return 0 }
      const entries = Object.entries(active)
      if (entries.length === 0) { deps.io.out('无 AFK 活跃 change（全 off）'); return 0 }
      deps.io.out('AFK 泳道:')
      for (const [s, ns] of entries) deps.io.out(`  ${s.padEnd(10)} ${ns.join(', ')}`)
      return 0
    }
    case 'run': {
      try {
        const result = await runAfkRound(deps, { level, image: opts.image })
        if (result.status === 'empty') {
          deps.io.out('AFK run: 就绪队列空——无 queued 且依赖满足的 change')
          return 0
        }
        if (result.status === 'docker-unavailable') {
          if (opts.json) deps.io.out(JSON.stringify({ ok: false, ...result }))
          else deps.io.err(`[AFK] run 需 docker daemon（未检测到）。就绪队列 ${result.ready.length} 项：${result.ready.join(', ')}。当前环境不执行容器（诚实门：不伪装 docker 就绪）。`)
          return 1
        }
        if (result.status === 'configuration-error') {
          deps.io.err(`[AFK] run 装配失败（不宣称跑完）：${result.message}`)
          return 1
        }
        const report = result.report
        if (report === undefined) {
          deps.io.err('[AFK] run 未返回执行报告（不宣称跑完）')
          return 1
        }
        if (!report.ok) {
          deps.io.err(`[AFK] run 一轮遇故障（不宣称跑完）：${report.failures.length} 项 failure${report.ledgerDegraded ? '、账本坏行 fail-closed' : ''}。已 admit ${report.admitted}/${report.candidates}。`)
          for (const failure of report.failures) {
            deps.io.err(`  · ${failure.change} [${failure.phase}/${failure.kind}]: ${failure.message}`)
          }
          return 1
        }
        const denied = report.entries.filter((entry) => entry.disposition === 'denied').length
        deps.io.out(`AFK run: 跑完一轮（${report.candidates} 项候选，admit ${report.admitted}${denied > 0 ? `、拒 ${denied}` : ''}${report.halted ? '、halt-round' : ''}，level=${result.level}，image=${result.image}）`)
        return 0
      } catch (error) {
        deps.io.err(`ERROR: ${errMsg(error)}`)
        return 1
      }
    }
    case 'cancel': {
      // server POST /api/afk/:name/cancel（packages/server/src/afk.ts::cancelAfkRun）的 CLI 终端等价：
      // 前置校验（change 存在 → automation==running → worktree/sandbox 非空）→ 先落取消标记文件
      // （worktree 根，复用 automation 单一常量 CANCEL_MARKER_FILE，不另拼字符串）→ 再 docker kill 容器。
      // 顺序与 server 一致：标记先于 kill 造成的非零退出到场，runChangeInSandbox 结算时 hasCancelMarker
      // 探到即抛 CancelledRunError，而非被 classify 误判成瞬态失败自动重排。
      if (!name || !isValidChangeName(name)) {
        deps.io.err(`ERROR: cancel 需合法 change 名: '${name ?? ''}'`)
        return 1
      }
      const dir = changeDir(deps.cwd, name)
      // store.get 对不存在的 change 真 throw ENOENT（同 server 的 canonical/legacy 存在性前置）——
      // 这里 catch 成诚实门 exit 1，不裸抛。
      let automation: string
      let worktree: string
      let sandbox: string
      try {
        automation = str(await deps.store.get(dir, 'automation'))
        worktree = str(await deps.store.get(dir, 'automation_worktree'))
        sandbox = str(await deps.store.get(dir, 'automation_sandbox'))
      } catch (e) {
        deps.io.err(`ERROR: 找不到 change '${name}'（无 canonical/legacy 状态？）：${errMsg(e)}`)
        return 1
      }
      if (automation !== 'running') {
        // 对齐 server「automation 不是 running → 找不到运行中的 job」语义；诚实门：不做任何取消动作。
        deps.io.err(`[AFK] ${name} automation='${automation || '(空)'}'，不是 running——找不到运行中的 job，未做任何取消动作`)
        return 3 // 3=无运行中任务可取消（非错误，可判别，同 enqueue 未入队口径）
      }
      if (!worktree || !sandbox) {
        // 对齐 server「缺 automation_worktree/automation_sandbox → 无法定位容器」。
        deps.io.err(`[AFK] ${name} 缺 automation_worktree/automation_sandbox，无法定位沙箱容器（字段可能被旧版截断损坏），未做任何取消动作`)
        return 1
      }
      try {
        await writeFile(join(worktree, CANCEL_MARKER_FILE), '1', 'utf8')
      } catch (e) {
        // 对齐 server：worktree 目录已被清理/字段损坏 → 就地拦成诚实门 exit 1，只带 errno、不裸抛全路径。
        const code = (e as NodeJS.ErrnoException | null)?.code ?? 'unknown'
        deps.io.err(`[AFK] ${name} 无法在 automation_worktree 落取消标记（${code}）：worktree 目录可能已被清理/字段损坏——任务若已不在跑，可直接 enqueue 重试或忽略`)
        return 1
      }
      // 诚实门：docker 不可用不伪装已 kill。标记已落即达成取消意图（容器在别处仍跑时会在其结算读到标记）。
      const hasDocker = await dockerAvailable((file, args) => nodeExec(file, args))
      if (!hasDocker) {
        deps.io.err(`[AFK] ${name} 取消标记已落，但未检测到 docker daemon——无法 kill 沙箱容器 '${sandbox}'（诚实门：不伪装已 kill）。容器若仍在跑，会在其结算时读到标记并转 CancelledRunError。`)
        if (opts.json) deps.io.out(JSON.stringify({ change: name, cancelled: true, killed: false, reason: 'docker-unavailable' }))
        return 0
      }
      // docker kill 失败（容器已退出/已不存在）不视为错误——同 server：标记已落即达成取消意图，真正的
      // 结算判定权在 automation 侧 hasCancelMarker，不在这次 kill 的退出码。nodeExec 永不抛（用 exitCode 表达）。
      await nodeExec('docker', ['kill', sandbox])
      if (opts.json) deps.io.out(JSON.stringify({ change: name, cancelled: true, killed: true }))
      else deps.io.err(`[AFK] ${name} 已取消：取消标记已落 + docker kill ${sandbox}`)
      return 0
    }
    default:
      deps.io.err(`ERROR: 未知 afk 子命令: ${sub}（支持: enqueue <name> / scan / status [name] / run [--level] [--image] / cancel <name>）`)
      return 1
  }
}
