/** `tenon test` 子命令注册：run / status / baseline / report / code-size。 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdTestRun } from './commands/test-run.js'
import { bail } from './program-exit.js'

export function registerTestCommands(program: Command, deps: CliDeps): void {
  const test = program
    .command('test')
    .description('测试登记：run / status / baseline / report / code-size')
    .action(() => {
      deps.io.err('用法：tenon test run|status|baseline|report|code-size ...')
      bail(1)
    })
  test
    .command('run <change> <test-id>')
    .description('执行该步骤声明的测试并登记结果（通过 exit 0、失败 exit 2、用法或环境错误 exit 1）')
    .option('--json', 'JSON 输出（记录全文 + record_path/log_path）')
    .action(async (change: string, testId: string, opts: { json?: boolean }) =>
      bail(await cmdTestRun(deps, change, testId, { json: opts.json === true })))
}
