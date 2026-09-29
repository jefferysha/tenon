/**
 * `tenon agent` 子命令注册。
 * 库：list / show / new / add / validate / copy / rm / export；任务里的运行：next / prompt / record。
 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdAgentNext, cmdAgentPrompt, cmdAgentRecord } from './commands/agent.js'
import {
  cmdAgentAdd, cmdAgentCopy, cmdAgentExport, cmdAgentList, cmdAgentRm, cmdAgentShow, cmdAgentValidate,
} from './commands/agent-library.js'
import { cmdAgentNew, type AgentNewOpts } from './commands/agent-new.js'
import { bail } from './program-exit.js'

function registerLibraryCommands(agent: Command, deps: CliDeps): void {
  agent
    .command('list')
    .description('列出 agent（官方 / 自定义 / 项目），按身份排序；冲突与被覆盖的条目带标记')
    .option('--role <role>', 'executor | reviewer')
    .option('--source <source>', 'official | custom | project')
    .option('--json', 'JSON 输出')
    .action(async (opts: { role?: string; source?: string; json?: boolean }) => bail(await cmdAgentList(deps, opts)))
  agent
    .command('show <name>')
    .description('打印生效的 agent 文件（项目级优先于自定义）')
    .option('--json', 'JSON 输出（字段 + 正文）')
    .action(async (name: string, opts: { json?: boolean }) => bail(await cmdAgentShow(deps, name, opts.json === true)))
  agent
    .command('new [name]')
    .description('生成并登记一个 agent；终端交互时缺的项逐个问，非交互须给全 <name> --role --description')
    .option('--role <role>', 'executor | reviewer')
    .option('--description <text>', '一句话说明（≤200 字，一行）')
    .option('--skills <ids>', '技能，逗号分隔')
    .option('--tools <names>', '工具，逗号分隔（缺省按身份给）')
    .option('--model <model>', '模型（宿主不认识的型号在生成宿主文件时省略）')
    .option('--hosts <ids>', '适用宿主，逗号分隔（缺省 = 全部）')
    .option('--scope <scope>', 'user（缺省，用户级）| project（<项目>/.tenon/agents，随仓库共享）')
    .option('--from <agent>', '以现有 agent（通常是官方）为底：字段作默认值、正文沿用')
    .action(async (name: string | undefined, opts: AgentNewOpts) => bail(await cmdAgentNew(deps, name, opts)))
  agent
    .command('add <file>')
    .description('校验一个 agent 文件并登记进库（名字取 frontmatter 的 name）')
    .option('--scope <scope>', 'user（缺省）| project')
    .option('--replace', '同层已有同名 agent 时覆盖')
    .action(async (file: string, opts: { scope?: string; replace?: boolean }) => bail(await cmdAgentAdd(deps, file, opts)))
  agent
    .command('validate <target>')
    .description('校验 agent 文件或库中的 agent：frontmatter、正文、技能存在、工具名按宿主合法')
    .action(async (target: string) => bail(await cmdAgentValidate(deps, target)))
  agent
    .command('copy <from> <to>')
    .description('复制一个 agent（官方也可以）为新的自定义或项目级 agent')
    .option('--scope <scope>', 'user（缺省）| project')
    .action(async (from: string, to: string, opts: { scope?: string }) => bail(await cmdAgentCopy(deps, from, to, opts)))
  agent
    .command('rm <name>')
    .description('删除自定义或项目级 agent；官方只读，被工作流引用时拒绝并列出引用（exit 2）')
    .option('--scope <scope>', 'user | project（缺省 = 生效的那一层）')
    .action(async (name: string, opts: { scope?: string }) => bail(await cmdAgentRm(deps, name, opts)))
  agent
    .command('export <name>')
    .description('打印 agent 的宿主原生文件（Claude .md / Codex .toml）')
    .option('--host <host>', 'claude | codex')
    .action(async (name: string, opts: { host?: string }) => bail(await cmdAgentExport(deps, name, opts.host)))
}

export function registerAgentCommands(program: Command, deps: CliDeps): void {
  const agent = program
    .command('agent')
    .description('agent：库（list / show / new / add / validate / copy / rm / export）与任务里的运行（next / prompt / record）')
    .action(() => {
      deps.io.err('用法：tenon agent list|show|new|add|validate|copy|rm|export|next|prompt|record ...')
      bail(1)
    })
  registerLibraryCommands(agent, deps)
  agent
    .command('next <change>')
    .description('当前步骤每个 agent 的身份、状态与下一波（有拦截仍 exit 0，拦截在 blockers 里）')
    .option('--json', 'JSON 输出')
    .action(async (change: string, opts: { json?: boolean }) =>
      bail(await cmdAgentNext(deps, change, opts.json === true)))
  agent
    .command('prompt <change> <agent>')
    .description('开始（或续跑）一个 agent 并打印交接内容；为宿主生成 tenon-<name> 子代理文件；未轮到 / 宿主不支持 exit 2')
    .option('--host <id>', '宿主 id（claude / codex 时生成专属子代理文件）；agent 声明了 hosts 时据此校验')
    .option('--json', 'JSON 输出（run_id / subagent_type / native / model / tools / skills / report_path / prompt）')
    .action(async (change: string, agentName: string, opts: { host?: string; json?: boolean }) =>
      bail(await cmdAgentPrompt(deps, change, agentName, {
        ...(opts.host === undefined ? {} : { host: opts.host }),
        json: opts.json === true,
      })))
  agent
    .command('record <change> <run-id>')
    .description('读报告末尾的 tenon-result 块登记结论；报告无效 exit 1，候选已变 exit 2')
    .option('--subagent <type>', '实际用的子代理类型（专属子代理不可用、退回通用子代理时写明）')
    .option('--json', 'JSON 输出（记录全文）')
    .action(async (change: string, runId: string, opts: { json?: boolean; subagent?: string }) =>
      bail(await cmdAgentRecord(deps, change, runId, opts.json === true, {
        ...(opts.subagent === undefined ? {} : { subagent: opts.subagent }),
      })))
}
