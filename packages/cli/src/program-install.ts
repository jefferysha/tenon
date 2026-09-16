import { InvalidArgumentError, type Command } from 'commander'
import type { CliDeps } from './deps.js'
import {
  cmdDashboard,
  type DashboardOpts,
  type DashboardRuntime,
} from './commands/dashboard.js'
import { cmdInternalSkillUpstream } from './commands/internal-skill-upstream.js'
import { cmdRuntime, type RuntimeCommandOpts } from './commands/runtime.js'
import {
  cmdHostTargetPlan,
  type HostTargetPlanOpts,
} from './commands/host-target-plan.js'
import { cmdSetup, type SetupOpts } from './commands/setup.js'
import { cmdUpdate, type UpdateOpts } from './commands/update.js'
import { bail } from './program-exit.js'

function rejectRepeatedOption(flag: '--host' | '--operation') {
  return (value: string, previous: string | undefined): string => {
    if (previous !== undefined) {
      throw new InvalidArgumentError(`不得重复指定 ${flag}`)
    }
    return value
  }
}

export function registerInstallCommands(
  program: Command,
  deps: CliDeps,
  dashboardRuntime?: DashboardRuntime,
): void {
  program
    .command('setup [sub]')
    .description('安装完整 Tenon：必须选择一个宿主（如 --codex）；不会同时修改 Codex 与 Claude')
    .option('--codex', '安装/验证 Codex 原生插件')
    .option('--claude', '安装/验证 Claude 原生插件')
    .option('--cursor', '部署 Cursor adapter')
    .option('--gemini', '部署 Gemini adapter')
    .option('--copilot', '部署 Copilot adapter')
    .option('--pi', '部署 Pi adapter')
    .option('--devin', '部署 Devin adapter')
    .option('--zed', '部署 Zed adapter')
    .option('--aider', '部署 Aider adapter')
    .option('--continue', '部署 Continue adapter')
    .option('--cline', '部署 Cline adapter')
    .option('--amp', '部署 Amp adapter')
    .option('--target <dir>', '非原生 adapter 的项目目标目录（缺省当前目录）')
    .option('--auto-update', '为所选原生宿主启用每日一次的自动升级检查')
    .option('--dry-run', '仅打印所选宿主安装计划，不写文件、不执行 adapter 或 marketplace 操作')
    .option('-y, --yes', '跳过兼容 skills/setup 的 y/N 确认位')
    .action(async (sub: string | undefined, opts: SetupOpts) => {
      bail(await cmdSetup(deps, sub, opts))
    })

  program
    .command('update')
    .description('刷新一个已安装的原生 Tenon 插件；升级后请新开会话加载 skills 和 hooks')
    .option('--codex', '更新 Codex marketplace 中的 tenon')
    .option('--claude', '更新 Claude marketplace 中的 tenon')
    .option('--cursor', '从当前已更新的包重新部署 Cursor adapter')
    .option('--gemini', '从当前已更新的包重新部署 Gemini adapter')
    .option('--copilot', '从当前已更新的包重新部署 Copilot adapter')
    .option('--pi', '从当前已更新的包重新部署 Pi adapter')
    .option('--devin', '从当前已更新的包重新部署 Devin adapter')
    .option('--zed', '从当前已更新的包重新部署 Zed adapter')
    .option('--aider', '从当前已更新的包重新部署 Aider adapter')
    .option('--continue', '从当前已更新的包重新部署 Continue adapter')
    .option('--cline', '从当前已更新的包重新部署 Cline adapter')
    .option('--amp', '从当前已更新的包重新部署 Amp adapter')
    .option('--target <dir>', '非原生 adapter 的项目目标目录（缺省当前目录）')
    .option('--dry-run', '仅打印升级计划，不执行 marketplace 或 adapter 操作')
    .option('-y, --yes', '供自动更新调用的非交互确认')
    .option('--auto', '由已明确启用的自动更新任务调用（不改变用户的 opt-in 状态）')
    .action(async (opts: UpdateOpts) => {
      bail(await cmdUpdate(deps, opts))
    })

  program
    .command('host-target-plan')
    .description('只读输出已注册宿主 catalog，或一个 setup/update JSON 计划；不执行宿主写操作')
    .option('--host <host>', 'TENON_HOSTS 中的已注册宿主 id', rejectRepeatedOption('--host'))
    .option('--operation <operation>', 'setup | update', rejectRepeatedOption('--operation'))
    .option('--json', '输出 host-target-plan/v1 JSON DTO')
    .action((opts: HostTargetPlanOpts) => {
      bail(cmdHostTargetPlan(deps, opts))
    })

  program
    .command('runtime <sub>')
    .description('查看 managed runtime，或仅回滚到上一份完整校验通过的 release')
    .option('--rollback', '仅 runtime repair 使用：切换到上一份已验证 release')
    .option('--json', '机器可读输出')
    .action(async (sub: string, opts: RuntimeCommandOpts) => {
      bail(await cmdRuntime(deps, sub, opts))
    })

  program
    .command('dashboard')
    .description('启动插件内置的单一 dashboard SPA/API 入口（默认 127.0.0.1:18765）')
    .option('--port <port>', '覆盖监听端口（例如旧端口 8765）')
    .option('--background', '以受管后台服务启动，并等待本机健康检查')
    .option('--open', '健康检查通过后自动打开本机 dashboard（隐含 --background）')
    .option('--dry-run', '验证已发布 dashboard 资产并打印启动计划，不启动 server')
    .action(async (opts: DashboardOpts) => {
      bail(await cmdDashboard(deps, opts, dashboardRuntime))
    })

  program
    .command('internal-skill-upstream <mode>', { hidden: true })
    .description('[内部] 开发 checkout 获取上游技能 fetch（npm run skills:fetch）')
    .option('--root <path>', '开发 checkout 根目录')
    .option('--json', '输出获取报告 JSON')
    .action(async (mode: string, opts: { root?: string; json?: boolean }) => {
      bail(await cmdInternalSkillUpstream(deps, mode, opts))
    })
}
