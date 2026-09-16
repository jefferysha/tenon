import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdStateProjection } from './commands/state-projection.js'
import { bail } from './program-exit.js'

export function registerStateCommands(program: Command, deps: CliDeps): void {
  program
    .command('state <sub> <name>')
    .description('canonical state 运维：status | repair-projection | import-legacy | pin-workflow-snapshot')
    .option('--json', '稳定 JSON 输出')
    .option('--force-canonical', 'repair-projection：明确用 canonical 覆盖未知 YAML drift')
    .option('--workflow-file <path>', 'pin-workflow-snapshot：必须与已绑定 fingerprint 完全一致的旧 workflow 文件')
    .action(async (
      sub: string,
      name: string,
      opts: { json?: boolean; forceCanonical?: boolean; workflowFile?: string },
    ) => bail(await cmdStateProjection(deps, sub, name, opts)))
}
