import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { bail } from './program-exit.js'
import { cmdOrchestrationBindArtifact, cmdOrchestrationControl, cmdOrchestrationEvents, cmdOrchestrationGate, cmdOrchestrationInit, cmdOrchestrationRetry, cmdOrchestrationRun, cmdOrchestrationStatus, cmdOrchestrationWatch, parseOrchestrationAfter } from './commands/orchestration.js'

export function registerOrchestrationCommands(program: Command, deps: CliDeps): void {
  const orchestration = program.command('orchestration').description('V2 durable orchestration：start / status / watch / events / controls')
  orchestration.command('status <change>').option('--json', 'JSON 输出').action(async (change: string, opts: { json?: boolean }) => bail(await cmdOrchestrationStatus(deps, change, opts.json === true)))
  orchestration.command('events <change>').option('--after <revision>', 'revision cursor', '0').option('--json', 'JSON 输出').action(async (change: string, opts: { after?: string; json?: boolean }) => {
    const after = parseOrchestrationAfter(opts.after)
    bail(after < 0 ? 1 : await cmdOrchestrationEvents(deps, change, after, opts.json === true))
  })
  orchestration.command('init <change>').requiredOption('--project <id>').requiredOption('--correlation <id>').action(async (change: string, opts: { project: string; correlation: string }) => bail(await cmdOrchestrationInit(deps, change, opts.project, opts.correlation)))
  orchestration.command('watch <change>').option('--follow', '持续跟随直到终态').option('--json', 'JSON 输出').action(async (change: string, opts: { follow?: boolean; json?: boolean }) => bail(await cmdOrchestrationWatch(deps, change, opts.json === true, opts.follow === true)))
  orchestration.command('start <change>').action(async (change: string) => bail(await cmdOrchestrationControl(deps, change, 'start-change', 'operator-start')))
  orchestration.command('run <change>').description('使用生产 runtime 执行已初始化的 change').action(async (change: string) => bail(await cmdOrchestrationRun(deps, change)))
  orchestration.command('retry <change>').requiredOption('--work-item <id>').action(async (change: string, opts: { workItem: string }) => bail(await cmdOrchestrationRetry(deps, change, opts.workItem)))
  orchestration.command('approve <change>').option('--gate <id>', 'gate ID', 'verification').option('--evidence <ref...>', 'evidence refs').option('--reason <reason>', '审批理由', 'operator-approved').action(async (change: string, opts: { gate: string; evidence?: string[]; reason: string }) => bail(await cmdOrchestrationGate(deps, change, 'passed', opts.gate, opts.evidence ?? [], opts.reason)))
  orchestration.command('reject <change>').option('--gate <id>', 'gate ID', 'verification').option('--reason <reason>', '拒绝理由', 'operator-rejected').action(async (change: string, opts: { gate: string; reason: string }) => bail(await cmdOrchestrationGate(deps, change, 'rejected', opts.gate, [], opts.reason)))
  orchestration.command('bind-artifact <change>').requiredOption('--work-item <id>').requiredOption('--ref <ref>').requiredOption('--digest <sha256>').action(async (change: string, opts: { workItem: string; ref: string; digest: string }) => bail(await cmdOrchestrationBindArtifact(deps, change, opts.workItem, opts.ref, opts.digest)))
  for (const type of ['pause-change', 'resume-change', 'cancel-change', 'replan-change'] as const) {
    const name = type.replace('-change', '')
    orchestration.command(`${name} <change>`).option('--reason <reason>', '原因', 'operator-request').action(async (change: string, opts: { reason: string }) => bail(await cmdOrchestrationControl(deps, change, type, opts.reason)))
  }
}
