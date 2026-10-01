/** `tenon step` 子命令注册：run（把 step.next 里确定性的动作一次做完）。 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdStepRun } from './commands/step-run.js'
import { bail } from './program-exit.js'

export function registerStepCommands(program: Command, deps: CliDeps): void {
  const step = program
    .command('step')
    .description('当前步骤：run 一次做完 step.next 里确定性的动作（铺文档骨架、登记已写好的文档、读取回执、生成测试计划初稿）')
    .action(() => {
      deps.io.err('用法：tenon step run <change> [--json]')
      bail(1)
    })
  step
    .command('run <change>')
    .description('批量执行当前步骤 step.next 里确定性的动作，打印做了什么、停在哪儿和最新的 step.next；没有可做的事就什么都不改（幂等）。技能加载、agent、写文档内容、跑测试、评审与转换仍由宿主与作者来做')
    .option('--json', 'JSON 输出：did / stopped / 最新 step')
    .action(async (change: string, opts: { json?: boolean }) =>
      bail(await cmdStepRun(deps, change, { json: opts.json === true })))
}
