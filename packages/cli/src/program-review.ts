import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdInteraction } from './commands/interaction.js'
import { cmdReview } from './commands/review.js'
import { bail } from './program-exit.js'

export function registerReviewCommands(program: Command, deps: CliDeps): void {
  program
    .command('review <sub> [name]')
    .description('review 出口确认：request <change> --event <event>（请求 review）/ acknowledge <change> [--delegated]（写精确 receipt）')
    .option('--event <event>', 'request 时绑定的确切 transition event；多出口 review step 必填')
    .option('--delegated', '仅用户已明确委托当前 Change 连续执行时，按该委托写审计化 review receipt')
    .action(async (sub: string, name: string | undefined, opts: { event?: string; delegated?: boolean }) =>
      bail(await cmdReview(deps, sub, name, opts)))

  program
    .command('interaction <sub> [args...]')
    .description('interaction scorecard：读取有界、非 symlink 的 benchmark fixtures 并输出确定性 JSON')
    .option('--json', 'JSON 输出（scorecard 必须显式指定）')
    .action(async (sub: string, args: string[], opts: { json?: boolean }) =>
      bail(await cmdInteraction(deps, sub, args, opts)))
}

