import { InvalidArgumentError, type Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdHandoff } from './commands/handoff.js'
import { cmdWorkflowPlan } from './commands/workflow-plan.js'
import { bail } from './program-exit.js'

export function registerHandoffCommand(program: Command, deps: CliDeps): void {
  program
    .command('handoff <name>')
    .description('相位 handoff 上下文压缩（对标 Tenon runtime CONTEXT-COMPRESSION，D11）')
    .option('--phase <p>', '覆写相位（默认当前相位）')
    .option('--bundle', '生成 ledger-bound Context Bundle v1（legacy handoff 默认行为不变）')
    .option('--target <step>', 'Context Bundle 的消费阶段')
    .option('--budget-bytes <n>', 'Context Bundle 最大内嵌 UTF-8 bytes（默认 120000）', (value: string) => {
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new InvalidArgumentError('budget-bytes 必须是正安全整数')
      }
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed)) {
        throw new InvalidArgumentError('budget-bytes 必须是正安全整数')
      }
      return parsed
    })
    .option('--json', 'JSON 输出（含压缩率）')
    .action(async (name: string, opts: {
      phase?: string
      bundle?: boolean
      target?: string
      budgetBytes?: number
      json?: boolean
    }) => bail(await cmdHandoff(deps, name, opts)))
}

export function registerWorkflowCommands(program: Command, deps: CliDeps): void {
  const workflow = program
    .command('workflow')
    .description('Workflow 运行计划：从 Change 的冻结快照读取步骤、Skill、门禁和转换')
    .action(() => {
      deps.io.err('用法：tenon workflow plan <change> [--json]')
      bail(1)
    })
  workflow
    .command('plan <change>')
    .description('输出 Change 的有效运行计划；已启动 Change 优先使用不可变快照')
    .option('--json', 'Agent 可编程 JSON 输出')
    .action(async (change: string, opts: { json?: boolean }) =>
      bail(await cmdWorkflowPlan(deps, change, opts)))
}
