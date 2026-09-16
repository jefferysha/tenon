/** `tenon test` 子命令注册：run / status / baseline / report / code-size。 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdTestBaseline } from './commands/test-baseline.js'
import { cmdTestCodeSize } from './commands/test-code-size.js'
import { cmdTestReport } from './commands/test-report.js'
import { cmdTestRun } from './commands/test-run.js'
import { cmdTestStatus } from './commands/test-status.js'
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
  test
    .command('status <change>')
    .description('该步骤每项测试的状态、耗时与最近执行时间（有拦截 exit 2）')
    .option('--step <id>', '指定步骤；缺省取当前阶段')
    .option('--json', 'JSON 输出')
    .action(async (change: string, opts: { step?: string; json?: boolean }) =>
      bail(await cmdTestStatus(deps, change, { ...(opts.step === undefined ? {} : { step: opts.step }), json: opts.json === true })))
  test
    .command('baseline <change> <test-id>')
    .description('用一次通过运行的指标作为当前用户的基线（旧值进 history）')
    .requiredOption('--run <run-id>', '作为基线的运行 id')
    .action(async (change: string, testId: string, opts: { run: string }) =>
      bail(await cmdTestBaseline(deps, change, testId, opts)))
  test
    .command('report <change>')
    .description('由登记结果生成验证报告的测试段；--write 替换目标文件里的标记区间')
    .option('--step <id>', '统计到该步骤为止；缺省取当前阶段')
    .option('--write <path>', '仓库内已存在的报告文件')
    .option('--locale <locale>', 'zh-CN | en（缺省 zh-CN）')
    .action(async (change: string, opts: { step?: string; write?: string; locale?: string }) => {
      if (opts.locale !== undefined && opts.locale !== 'zh-CN' && opts.locale !== 'en') {
        deps.io.err('ERROR: --locale 只支持 zh-CN | en')
        bail(1)
        return
      }
      bail(await cmdTestReport(deps, change, {
        ...(opts.step === undefined ? {} : { step: opts.step }),
        ...(opts.write === undefined ? {} : { write: opts.write }),
        ...(opts.locale === undefined ? {} : { locale: opts.locale }),
      }))
    })
  test
    .command('code-size')
    .description('代码规模探针：与 base 的 merge-base 做 numstat，输出一行 JSON 指标')
    .option('--base <ref>', '比较基线；缺省取 TENON_BASE_BRANCH，再缺省 HEAD')
    .option('--json', 'JSON 输出（默认即 JSON，保留以对齐方向模板命令）')
    .action(async (opts: { base?: string; json?: boolean }) =>
      bail(await cmdTestCodeSize(deps, { ...(opts.base === undefined ? {} : { base: opts.base }), json: opts.json === true })))
}
