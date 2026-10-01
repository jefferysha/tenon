/**
 * 排障入口：`tenon support bundle`（脱敏诊断包）与 `tenon logs`（Dashboard server 日志）。
 * 两者都只读本机文件、不联网；运行时依赖（睡眠、SIGINT、环境）可注入，命令测试不碰真实进程。
 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdLogs, type LogsOpts, type LogsRuntime } from './commands/logs.js'
import { cmdSupportBundle, type SupportOpts, type SupportRuntime } from './commands/support.js'
import { bail } from './program-exit.js'

export interface SupportRuntimes {
  readonly logs?: LogsRuntime
  readonly support?: SupportRuntime
}

export function registerSupportCommands(program: Command, deps: CliDeps, runtimes: SupportRuntimes): void {
  const support = program
    .command('support')
    .description('排障支持：bundle 生成本机脱敏诊断包')
  support
    .command('bundle')
    .description('生成脱敏诊断包 .tar.gz（版本、doctor、runtime 状态、配置摘要、最近 Dashboard 日志；< 5 MB，只在本机，不联网）')
    .option('--out <path>', '输出文件路径（缺省 ~/tenon-support-<时间>.tar.gz）')
    .option('--json', 'JSON 输出（包含的文件与脱敏计数）')
    .action(async (opts: SupportOpts) => bail(await cmdSupportBundle(deps, opts, runtimes.support)))

  program
    .command('logs')
    .description('查看 Dashboard server 日志（按大小轮转共 3 个文件，行内凭证已脱敏）')
    .option('-f, --follow', '持续输出新增日志（Ctrl+C 结束）')
    .option('-n, --lines <n>', '显示最近 N 行（缺省 100）')
    .action(async (opts: LogsOpts) => bail(await cmdLogs(deps, opts, runtimes.logs)))
}
