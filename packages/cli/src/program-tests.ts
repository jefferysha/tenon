/** `tenon test` 子命令注册：run / status / baseline / report / code-size，以及测试体系的 plan / register / sync（目录、已知失败见 program-tests-project.ts）。 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdTestBaseline } from './commands/test-baseline.js'
import { cmdTestBaselineSuite } from './commands/test-baseline-suite.js'
import { cmdTestCodeSize } from './commands/test-code-size.js'
import { cmdTestPlan } from './commands/test-plan.js'
import { cmdTestRegister, cmdTestUnregister, cmdTestWaive } from './commands/test-register.js'
import { cmdTestReport } from './commands/test-report.js'
import { cmdTestRun } from './commands/test-run.js'
import { cmdTestRunSuites } from './commands/test-run-suites.js'
import { cmdTestStatus } from './commands/test-status.js'
import { cmdTestSync } from './commands/test-sync.js'
import { registerTestProjectCommands } from './program-tests-project.js'
import { bail } from './program-exit.js'

export function collect(value: string, previous: readonly string[] = []): string[] {
  return [...previous, value]
}

interface RunCliOptions {
  suite?: string[]
  kind?: string[]
  stage?: string | boolean
  all?: boolean
  changed?: boolean
  json?: boolean
}

export function registerTestCommands(program: Command, deps: CliDeps): void {
  const test = program
    .command('test')
    .description('测试体系：discover / catalog / plan / register / sync / run / status / baseline / known / report / code-size')
    .action(() => {
      deps.io.err('用法：tenon test discover|catalog|plan|register|unregister|waive|sync|run|status|baseline|known|report|code-size ...')
      bail(1)
    })
  registerTestProjectCommands(test, deps)
  test
    .command('plan <change>')
    .description('查看任务测试计划；--seed 生成初稿（diff 碰到的套件、策略要求种类的套件、未登记的测试文件）')
    .option('--seed', '生成 / 补全计划初稿（只增不减）')
    .option('--json', 'JSON 输出')
    .action(async (change: string, opts: { seed?: boolean; json?: boolean }) =>
      bail(await cmdTestPlan(deps, change, { seed: opts.seed === true, json: opts.json === true })))
  test
    .command('register <change>')
    .description('登记：--suite 套件 / --file 测试文件 / --case + --test 场景或任务到用例的映射')
    .option('--suite <id>', '目录套件 id（配合 --file 时指定认领它的套件）')
    .option('--scope <scope>', 'full | changed | files | grep（缺省 full）')
    .option('--pattern <regex>', 'scope grep 的用例名过滤')
    .option('--select-file <path>', 'scope files 的测试文件（可重复）', collect)
    .option('--file <path>', '本任务新增或修改的测试文件（可重复）', collect)
    .option('--kind <kind>', '测试文件的种类（无套件认领的资源文件用）')
    .option('--case <covers>', 'spec:<capability>/<Scenario 标题> 或 task:<编号>')
    .option('--test <ref>', '映射的用例 "<文件> › <用例名>"（可重复）', collect)
    .action(async (change: string, opts: {
      suite?: string; scope?: string; pattern?: string; selectFile?: string[]; file?: string[]; kind?: string; case?: string; test?: string[]
    }) => bail(await cmdTestRegister(deps, change, opts)))
  test
    .command('unregister <change>')
    .description('取消登记：--suite / --file / --case [--test] / --waiver-kind / --waiver-covers')
    .option('--suite <id>', '取消登记的套件')
    .option('--file <path>', '取消登记的测试文件')
    .option('--case <covers>', '取消映射（配合 --test 只去掉一个用例）')
    .option('--test <ref>', '映射里要去掉的用例')
    .option('--waiver-kind <kind>', '撤销按种类的豁免')
    .option('--waiver-covers <covers>', '撤销按场景 / 任务的豁免')
    .action(async (change: string, opts: { suite?: string; file?: string; case?: string; test?: string; waiverKind?: string; waiverCovers?: string }) =>
      bail(await cmdTestUnregister(deps, change, opts)))
  test
    .command('waive <change>')
    .description('登记豁免：策略要求但本任务不适用（需要评审批准后才解除阻塞）')
    .option('--kind <kind>', '豁免的测试种类')
    .option('--covers <covers>', '豁免的场景 / 任务，spec:<capability>/<Scenario 标题> 或 task:<编号>')
    .option('--reason <text>', '不适用的原因')
    .action(async (change: string, opts: { kind?: string; covers?: string; reason?: string }) => bail(await cmdTestWaive(deps, change, opts)))
  test
    .command('sync <change>')
    .description('对账：diff 里未登记的测试文件、无套件认领的孤儿文件、已不存在的登记项（有待处理 exit 2）')
    .option('--json', 'JSON 输出')
    .action(async (change: string, opts: { json?: boolean }) => bail(await cmdTestSync(deps, change, { json: opts.json === true })))
  test
    .command('run <change> [test-id]')
    .description('执行测试并登记结果（通过 exit 0、失败 exit 2、用法或环境错误 exit 1）；带 <test-id> 是旧的步骤测试，否则按套件批量运行')
    .option('--suite <id>', '目录套件 id（可重复）', collect)
    .option('--kind <kind>', '计划里该种类的全部套件（可重复）', collect)
    .option('--stage [step]', '本阶段策略要求的运行集（缺省当前步骤；没有选择参数时也是它）')
    .option('--all', '计划里的全部套件（全量）')
    .option('--changed', '只跑改动范围')
    .option('--json', 'JSON 输出（v2 为记录全文 + 出口检查）')
    .action(async (change: string, testId: string | undefined, opts: RunCliOptions) => {
      if (testId !== undefined) {
        if (opts.suite !== undefined || opts.kind !== undefined || opts.stage !== undefined || opts.all === true || opts.changed === true) {
          deps.io.err('ERROR: <test-id> 是旧的步骤测试，不能和 --suite / --kind / --stage / --all / --changed 一起用')
          bail(1)
          return
        }
        bail(await cmdTestRun(deps, change, testId, { json: opts.json === true }))
        return
      }
      bail(await cmdTestRunSuites(deps, change, {
        ...(opts.suite === undefined ? {} : { suite: opts.suite }),
        ...(opts.kind === undefined ? {} : { kind: opts.kind }),
        ...(opts.stage === undefined ? {} : { stage: opts.stage }),
        all: opts.all === true, changed: opts.changed === true, json: opts.json === true,
      }))
    })
  test
    .command('status <change>')
    .description('该步骤每项测试的状态、耗时与最近执行时间（有拦截 exit 2）')
    .option('--step <id>', '指定步骤；缺省取当前阶段')
    .option('--json', 'JSON 输出')
    .action(async (change: string, opts: { step?: string; json?: boolean }) =>
      bail(await cmdTestStatus(deps, change, { ...(opts.step === undefined ? {} : { step: opts.step }), json: opts.json === true })))
  test
    .command('baseline <change> [test-id]')
    .description('用一次通过运行的指标作基线：--suite 是目录套件（按机器画像，进 git），<test-id> 是旧的步骤测试（按用户）')
    .requiredOption('--run <run-id>', '作为基线的运行 id')
    .option('--suite <id>', '目录里的基准套件')
    .action(async (change: string, testId: string | undefined, opts: { run: string; suite?: string }) => {
      if (opts.suite !== undefined) {
        bail(await cmdTestBaselineSuite(deps, change, { suite: opts.suite, run: opts.run }))
        return
      }
      if (testId === undefined) {
        deps.io.err('ERROR: 需要 --suite <id>（目录套件）或 <test-id>（旧的步骤测试）')
        bail(1)
        return
      }
      bail(await cmdTestBaseline(deps, change, testId, { run: opts.run }))
    })
  test
    .command('report <change>')
    .description('由登记结果生成验证报告的测试段（含追溯矩阵、套件、覆盖率、基准）；--write 替换目标文件里的标记区间')
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
