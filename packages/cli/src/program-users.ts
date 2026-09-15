import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdOwnerSet, cmdOwnerTake } from './commands/owner.js'
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
  const owner = program
    .command('owner')
    .description('负责人：take 接手（负责人改为当前用户）/ set 移交（仅当前负责人）')
    .action(() => {
      deps.io.err('用法：tenon owner <take|set> …（详见 tenon owner --help）')
      bail(1)
    })
  owner
    .command('take <change>')
    .description('接手：负责人改为当前用户并留下历史记录')
    .action(async (change: string) => bail(await cmdOwnerTake(deps, change)))
  owner
    .command('set <change> <id>')
    .description('移交负责人（仅当前负责人可执行）')
    .option('--name <name>', '显示名')
    .action(async (change: string, id: string, opts: { name?: string }) => bail(await cmdOwnerSet(deps, change, id, opts)))
}
