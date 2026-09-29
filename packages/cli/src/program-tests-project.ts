/** `tenon test discover|catalog|known` 注册：项目共享的测试配置（目录、已知失败），与具体任务无关。 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdCatalogAdd, cmdCatalogRemove, cmdCatalogSet, cmdCatalogShow, cmdCatalogValidate } from './commands/test-catalog.js'
import type { ServiceOptions, SuiteOptions } from './commands/test-catalog-edit.js'
import { cmdTestDiscover } from './commands/test-discover.js'
import { cmdKnownAdd, cmdKnownList, cmdKnownRemove } from './commands/test-known.js'
import { bail, collect } from './program-exit.js'

type CatalogCliOptions = SuiteOptions & ServiceOptions & { readonly service?: boolean; readonly from?: string }

function suiteFlags(command: Command): Command {
  return command
    .option('--kind <kind>', '测试种类（unit/integration/regression/e2e/playwright/browser/benchmark/typecheck/lint/…）')
    .option('--runner <runner>', 'vitest/jest/mocha/node-test/pytest/go/cargo/playwright/cypress/…（缺省从命令推断）')
    .option('--command <cmd>', '运行命令（要产出可解析的报告）')
    .option('--label <text>', '显示名')
    .option('--cwd <dir>', '工作目录（仓库内相对路径）')
    .option('--timeout <s>', '超时秒数')
    .option('--file-glob <glob>', '本套件拥有的测试文件 glob（可重复）', collect)
    .option('--cover-glob <glob>', '影响范围 glob：改到这些源码时建议纳入（可重复）', collect)
    .option('--select-files <template>', '按文件运行的命令模板，含 {files}')
    .option('--select-grep <template>', '按用例名运行的命令模板，含 {pattern}')
    .option('--report-format <format>', 'junit/playwright-json/vitest-json/jest-json/go-json/tap/benchmark-json/k6-summary/exit-code')
    .option('--report-path <path>', '报告路径（相对 cwd，须在 test-results/ playwright-report/ coverage/ 之下）')
    .option('--coverage-format <format>', 'istanbul-summary | lcov | cobertura')
    .option('--coverage-path <path>', '覆盖率报告路径')
    .option('--artifact <path>', '产物路径，文件或目录（可重复）', collect)
    .option('--env <NAME>', '需要的环境变量名（可重复）', collect)
    .option('--uses <service>', '依赖的服务 id（可重复）', collect)
    .option('--retries <n>', '失败用例重试次数')
    .option('--parallel', '可与同批其他 parallel 套件并发')
    .option('--tag <tag>', '标签（可重复）', collect)
    .option('--browser <name>', 'Playwright project 名（可重复）', collect)
    .option('--runs <n>', '基准：采样次数')
    .option('--warmup <n>', '基准：预热次数')
    .option('--metric <spec>', '基准指标 name=p95_ms,better=lower,max_regression_pct=10,max=250,unit=ms（可重复）', collect)
}

function serviceFlags(command: Command): Command {
  return command
    .option('--service', '操作的是服务而不是套件')
    .option('--start <cmd>', '服务：启动命令')
    .option('--ready-url <url>', '服务：就绪探测 URL（2xx/3xx）')
    .option('--ready-port <port>', '服务：就绪探测端口')
    .option('--ready-log <text>', '服务：日志出现该文本即就绪')
    .option('--ready-timeout <s>', '服务：就绪等待秒数')
    .option('--stop <signal>', '服务：停止信号 SIGTERM | SIGINT | SIGKILL')
}

export function registerTestProjectCommands(test: Command, deps: CliDeps): void {
  test
    .command('discover')
    .description('识别项目里的测试工具，给出建议的目录套件；--write 追加进 .tenon/tests/catalog.yaml（已存在的 id 不覆盖）')
    .option('--write', '写入目录')
    .option('--json', 'JSON 输出')
    .action(async (opts: { write?: boolean; json?: boolean }) => bail(await cmdTestDiscover(deps, { write: opts.write === true, json: opts.json === true })))
  const catalog = test
    .command('catalog')
    .description('项目测试目录：show / validate / add / set / rm')
    .action(() => {
      deps.io.err('用法：tenon test catalog show|validate|add|set|rm ...')
      bail(1)
    })
  catalog
    .command('show [id]')
    .description('列出目录里的套件与服务，或显示一个条目')
    .option('--json', 'JSON 输出')
    .action(async (id: string | undefined, opts: { json?: boolean }) => bail(await cmdCatalogShow(deps, id, { json: opts.json === true })))
  catalog
    .command('validate')
    .description('校验 catalog.yaml，逐条列出 catalog.yaml:<行> 问题（有问题 exit 2）')
    .option('--json', 'JSON 输出')
    .action(async (opts: { json?: boolean }) => bail(await cmdCatalogValidate(deps, { json: opts.json === true })))
  serviceFlags(suiteFlags(catalog
    .command('add [id]')
    .description('添加套件（--from <测试方向> 用方向模板起步）或服务（--service）')
    .option('--from <direction>', '测试方向库里的方向 id')))
    .action(async (id: string | undefined, opts: CatalogCliOptions) => bail(await cmdCatalogAdd(deps, id, opts)))
  serviceFlags(suiteFlags(catalog
    .command('set <id>')
    .description('修改套件或服务的字段（给出的字段整体替换，列表字段整份替换）')))
    .action(async (id: string, opts: CatalogCliOptions) => bail(await cmdCatalogSet(deps, id, opts)))
  catalog
    .command('rm <id>')
    .description('移除套件或服务（服务还被套件引用时拒绝）')
    .option('--service', '移除的是服务')
    .action(async (id: string, opts: { service?: boolean }) => bail(await cmdCatalogRemove(deps, id, { service: opts.service === true })))
  const known = test
    .command('known')
    .description('已知失败清单：add / rm / list')
    .action(() => {
      deps.io.err('用法：tenon test known add|rm|list ...')
      bail(1)
    })
  known
    .command('add')
    .description('登记一个已知失败（带原因、到期日；同一 套件 + 用例 再次 add 即续期）')
    .option('--suite <id>', '目录套件 id')
    .option('--test <ref>', '用例 "<文件> › <用例名>"')
    .option('--reason <text>', '为什么现在失败、谁在修')
    .option('--expires <date>', '到期日 YYYY-MM-DD')
    .option('--link <url>', '相关 issue / PR 链接')
    .action(async (opts: { suite?: string; test?: string; reason?: string; expires?: string; link?: string }) => bail(await cmdKnownAdd(deps, opts)))
  known
    .command('rm')
    .description('把用例移出已知失败清单（修好了就移出）')
    .option('--suite <id>', '目录套件 id')
    .option('--test <ref>', '用例 "<文件> › <用例名>"')
    .action(async (opts: { suite?: string; test?: string }) => bail(await cmdKnownRemove(deps, opts)))
  known
    .command('list')
    .description('列出已知失败（过期的标出）')
    .option('--json', 'JSON 输出')
    .action(async (opts: { json?: boolean }) => bail(await cmdKnownList(deps, { json: opts.json === true })))
}
