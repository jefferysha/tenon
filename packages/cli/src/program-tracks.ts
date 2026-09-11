import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdTracksList, cmdTracksShow } from './commands/tracks.js'
import { bail } from './program-exit.js'

export function registerTrackCommands(program: Command, deps: CliDeps): void {
  const tracks = program
    .command('tracks')
    .description('Track Registry 只读视图：list / show <id>（--json 稳定输出）')
    .action(() => {
      deps.io.err('用法：tenon tracks <list|show> …（详见 tenon tracks --help）')
      bail(1)
    })
  tracks
    .command('list')
    .description('列出全部 track（内建 Track 在前，固定列 ID LABEL BUILTIN DEFAULT ALLOWED POLICY）')
    .option('--json', 'JSON array 输出')
    .action(async (opts: { json?: boolean }) => bail(await cmdTracksList(deps, opts)))
  tracks
    .command('show <id>')
    .description('显示某 track 详情（标 source: builtin | builtin-override | custom）')
    .option('--json', 'JSON object 输出')
    .action(async (id: string, opts: { json?: boolean }) => bail(await cmdTracksShow(deps, id, opts)))
}
