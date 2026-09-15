import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdUser, cmdUserSet } from './commands/user.js'
import { bail } from './program-exit.js'

export function registerUserCommands(program: Command, deps: CliDeps): void {
  const user = program
    .command('user')
    .description('当前用户身份（自报）：TENON_USER → 本机 user.json → git config user.email')
    .option('--json', 'JSON 输出')
    .action(async (opts: { json?: boolean }) => bail(await cmdUser(deps, opts)))
  user
    .command('set <id>')
    .description('写本机 user.json（覆盖 git 身份）')
    .option('--name <name>', '显示名')
    .action(async (id: string, opts: { name?: string }) => bail(await cmdUserSet(deps, id, opts)))
}
