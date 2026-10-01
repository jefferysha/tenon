/**
 * 跨厂商评审的路由：评审者要在哪个宿主上跑，当前宿主不是它时怎么在另一个宿主上跑。
 *
 * Tenon 只指路、不代跑：这里算出确切的命令（`codex exec …` / `claude -p …`）和登记命令，由用户或当前宿主里的
 * agent 去执行；生产路径从不替用户起另一家的 CLI。评审结论是否有效由 kernel 的 evaluateStepAgents 按登记的宿主判定。
 */
import {
  shellQuote,
  type AgentView, type AgentRunHostSource, type ReviewerHostRequirement,
} from '@tenon/kernel'

export interface RunOn {
  readonly host: 'claude' | 'codex'
  /** 在另一个宿主上运行评审的命令（从仓库根执行）。 */
  readonly command: string
  /** 命令读取的提示词文件（仓库相对）。 */
  readonly promptFile: string
  /** 评审写完报告后登记的命令；`--host` 声明这份评审是在哪个宿主上跑的。 */
  readonly record: string
}

export interface HostRoute {
  readonly required: ReviewerHostRequirement['host']
  readonly source: ReviewerHostRequirement['source']
  readonly enforced: boolean
  /** 当前宿主 id；纯终端为 null。 */
  readonly current: string | null
  /** 当前宿主不是要求的宿主时给出；否则 null。 */
  readonly runOn: RunOn | null
}

/** 在 Codex 里读提示词文件运行评审：工作区可写（评审要写报告），其余沿用用户的 Codex 配置。 */
export function codexCommand(promptFile: string): string {
  return `codex exec --sandbox workspace-write - < ${shellQuote(promptFile)}`
}

/** 在 Claude Code 里无头运行评审：只放行读、写报告与登记命令。 */
export function claudeCommand(promptFile: string): string {
  return `claude -p --allowedTools "Read,Grep,Glob,Write,Bash(tenon agent record:*)" < ${shellQuote(promptFile)}`
}

export function recordCommand(change: string, runId: string, host: string): string {
  return `tenon agent record ${change} ${runId} --host ${host}`
}

export function planRoute(input: {
  readonly requirement: ReviewerHostRequirement
  readonly current: string | undefined
  readonly change: string
  readonly runId: string
  readonly promptFile: string
}): HostRoute {
  const { requirement, current } = input
  const base = { required: requirement.host, source: requirement.source, enforced: requirement.enforced, current: current ?? null }
  if (requirement.host === 'any' || current === requirement.host) return { ...base, runOn: null }
  return {
    ...base,
    runOn: {
      host: requirement.host,
      command: requirement.host === 'codex' ? codexCommand(input.promptFile) : claudeCommand(input.promptFile),
      promptFile: input.promptFile,
      record: recordCommand(input.change, input.runId, requirement.host),
    },
  }
}

const SOURCE_WORD = { step: '工作流步骤要求', agent: 'agent 定义建议', none: '' } as const

/** 路由说明（人读）：这个评审该在哪个宿主上跑、读哪个文件、怎么登记。 */
export function routeLines(agent: string, route: HostRoute): readonly string[] {
  const target = route.runOn
  if (target === null) return []
  return [
    `[ROUTE] 评审者 '${agent}' 须在 ${target.host} 上运行（${SOURCE_WORD[route.source]}${route.enforced ? '，登记的宿主不符则结论无效' : ''}）；当前宿主：${route.current ?? '终端'}`,
    `提示词：${target.promptFile}`,
    `运行：${target.command}`,
    `登记（评审写完报告后，在运行目录里）：${target.record}`,
  ]
}

/** `agent next` 一行末尾的宿主说明：要求、登记的宿主，以及登记的宿主不符导致结论无效。 */
export function hostNote(view: Pick<AgentView, 'requiredHost' | 'host' | 'wrongHost'>): string {
  if (view.wrongHost) return ` 宿主不符：要求 ${view.requiredHost ?? '—'}，登记 ${view.host ?? '无'}，结论无效`
  if (view.host !== null) return ` 宿主 ${view.host}`
  return view.requiredHost === null ? '' : ` 要求宿主 ${view.requiredHost}`
}

/** `record` 的宿主来源：显式声明且与进程环境判出的不同 = declared，否则 detected。 */
export function hostSourceOf(claimed: string | undefined, detected: string | undefined): AgentRunHostSource {
  return claimed === undefined || claimed === detected ? 'detected' : 'declared'
}
