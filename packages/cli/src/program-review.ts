import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdInteraction } from './commands/interaction.js'
import { cmdReview } from './commands/review.js'
import { bail } from './program-exit.js'

export function registerReviewCommands(program: Command, deps: CliDeps): void {
  program
    .command('review <sub> [name]')
    .description('review 出口确认：request <change> --event <event>（请求 review）/ acknowledge <change> [--delegated] [--as reviewer]（写精确 receipt；只认负责人，非负责人以评审人身份确认要加 --as reviewer）/ revoke <change> --reason <原因>（把已批准、未被消费的回执撤回为待确认；只认负责人）')
    .option('--event <event>', 'request 时绑定的确切 transition event；多出口 review step 必填')
    .option('--delegated', '仅用户已明确委托当前 Change 连续执行时，按该委托写审计化 review receipt')
    .option('--as <role>', '仅 acknowledge：非负责人以评审人身份确认（只支持 reviewer，角色与负责人记进历史）')
    .option('--reason <text>', '仅 revoke：撤回已批准回执的原因（必填，一行，不超过 200 字）')
    .action(async (sub: string, name: string | undefined, opts: { event?: string; delegated?: boolean; as?: string; reason?: string }) =>
      bail(await cmdReview(deps, sub, name, opts)))

  program
    .command('interaction <sub> [args...]')
    .description('interaction scorecard：读取有界、非 symlink 的 benchmark fixtures 并输出确定性 JSON')
    .option('--json', 'JSON 输出（scorecard 必须显式指定）')
    .action(async (sub: string, args: string[], opts: { json?: boolean }) =>
      bail(await cmdInteraction(deps, sub, args, opts)))
}

