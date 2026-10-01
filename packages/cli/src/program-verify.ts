/** `tenon verify --ci` 与 `tenon evidence export` 的注册。 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdEvidenceExport, type EvidenceExportOpts } from './commands/evidence-export.js'
import { cmdVerifyCi, type VerifyCiCmdOpts } from './commands/verify-ci.js'
import { bail, collect } from './program-exit.js'

export function registerVerifyCommands(program: Command, deps: CliDeps): void {
  program
    .command('verify')
    .description('在 CI 里对已提交的内容独立重算：记录链、计划 ↔ 记录 ↔ 目录、用例级判定、候选代码、受保护文件批准、锚点（有不通过 exit 2）')
    .option('--ci', 'CI 模式（没有用户本机封存；必填）')
    .option('--change <name>', '只校验这个任务（活跃或已归档）')
    .option('--all-open', '校验 openspec/changes/ 下全部未完结的任务')
    .option('--since <ref>', '校验 merge-base(<ref>, HEAD)..HEAD 的提交改到的任务（PR 用 origin/<目标分支>）')
    .option('--step <id>', '按这个工作流步骤的测试策略判定（缺省取任务当前步骤）')
    .option('--format <format>', 'text | json | sarif | markdown（缺省 text）')
    .option('--out <file>', '把所选格式写进文件；stdout 改打印 text 摘要')
    .option('--also <format=file>', '同一次运行再写一份，例如 sarif=tenon.sarif（可重复）', collect)
    .option('--candidate <mode>', 'error | warn | off：记录绑定的工作区指纹与本次检出的树不一致时的处理（缺省 error）')
    .option('--require-anchor', '要求 refs/notes/tenon 上有锚点，且链头等于锚点（落后或缺失都算失败）')
    .action(async (opts: VerifyCiCmdOpts) => bail(await cmdVerifyCi(deps, opts)))

  const evidence = program
    .command('evidence')
    .description('证据导出：export <change> --format agent-trace|otel|git-notes|trailer')
    .action(() => {
      deps.io.err('用法：tenon evidence export <change> --format agent-trace|otel|git-notes|trailer')
      bail(1)
    })
  evidence
    .command('export <change>')
    .description('把任务的证据导出成 Agent Trace / OTel GenAI span（JSON，不联网）/ git note / 提交尾注；默认只打印，--apply 才写仓库')
    .option('--format <format>', 'agent-trace | otel | git-notes | trailer')
    .option('--out <file>', '把输出写进文件')
    .option('--commit <rev>', 'note / Agent Trace 针对的提交（缺省 HEAD）')
    .option('--user <slug>', '取这个用户目录的记录链（缺省任务负责人）')
    .option('--apply', 'git-notes：写 refs/notes/tenon；trailer：amend HEAD 追加尾注（显式才写）')
    .option('--anchor', 'git-notes：在 note 里锚定当前链头，verify --ci 据此核对（opt-in）')
    .option('--contributor <type>', 'agent-trace：human | ai | mixed | unknown（缺省 unknown，不替人声明）')
    .option('--model <provider/model>', 'agent-trace：断言 contributor 时的模型，例如 anthropic/claude-opus-4-5')
    .action(async (change: string, opts: EvidenceExportOpts) => bail(await cmdEvidenceExport(deps, change, opts)))
}
