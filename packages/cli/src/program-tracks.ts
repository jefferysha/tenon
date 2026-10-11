import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdTracksList, cmdTracksShow } from './commands/tracks.js'
import { bail } from './program-exit.js'

export function registerTrackCommands(program: Command, deps: CliDeps): void {
  const tracks = program
    .command('tracks')
    .description('工作流分支（轨道）只读视图：list / show <id>（--json 稳定输出）')
    .action(() => {
      deps.io.err('用法：tenon tracks <list|show> …（详见 tenon tracks --help）')
      bail(1)
    })
  tracks
    .command('list')
    .description('列出全部工作流的全部轨道（固定列 WORKFLOW:TRACK LABEL ROUTABLE）')
    .option('--json', 'JSON array 输出')
    .action(async (opts: { json?: boolean }) => bail(await cmdTracksList(deps, opts)))
  tracks
    .command('show <id>')
    .description('显示某轨道详情（<工作流>:<轨道>；轨道 id 只在一个工作流里出现时可省略工作流名）')
    .option('--json', 'JSON object 输出')
    .action(async (id: string, opts: { json?: boolean }) => bail(await cmdTracksShow(deps, id, opts)))
}
