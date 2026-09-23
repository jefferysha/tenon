/** `tenon agent` 子命令注册：next / prompt / record。 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdAgentNext, cmdAgentPrompt, cmdAgentRecord } from './commands/agent.js'
import { bail } from './program-exit.js'

export function registerAgentCommands(program: Command, deps: CliDeps): void {
  const agent = program
    .command('agent')
    .description('步骤 agent：next（看状态与下一波）/ prompt（开始或续跑并打印交接内容）/ record（登记结论）')
    .action(() => {
      deps.io.err('用法：tenon agent next|prompt|record ...')
      bail(1)
    })
  agent
    .command('next <change>')
    .description('当前步骤每个 agent 的身份、状态与下一波（有拦截仍 exit 0，拦截在 blockers 里）')
    .option('--json', 'JSON 输出')
    .action(async (change: string, opts: { json?: boolean }) =>
      bail(await cmdAgentNext(deps, change, opts.json === true)))
  agent
    .command('prompt <change> <agent>')
    .description('开始（或续跑）一个 agent 并打印交接内容；未轮到 / 宿主不支持 exit 2；未声明的 agent exit 1')
    .option('--host <id>', '宿主 id；agent 声明了 hosts 时据此校验')
    .option('--json', 'JSON 输出（run_id / model / tools / skills / report_path / prompt）')
    .action(async (change: string, agentName: string, opts: { host?: string; json?: boolean }) =>
      bail(await cmdAgentPrompt(deps, change, agentName, {
        ...(opts.host === undefined ? {} : { host: opts.host }),
        json: opts.json === true,
      })))
  agent
    .command('record <change> <run-id>')
    .description('读报告末尾的 tenon-result 块登记结论；报告无效 exit 1，候选已变 exit 2')
    .option('--json', 'JSON 输出（记录全文）')
    .action(async (change: string, runId: string, opts: { json?: boolean }) =>
      bail(await cmdAgentRecord(deps, change, runId, opts.json === true)))
}
