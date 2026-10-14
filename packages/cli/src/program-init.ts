import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdInit, type InitCmdOpts } from './commands/init.js'
import { bail } from './program-exit.js'

/** `init <name>`：从 program.ts 拆出（命令装配文件有体量上限），帮助文本的英文版在 i18n/help-en-core.ts。 */
export function registerInitCommand(program: Command, deps: CliDeps): void {
  program
    .command('init <name>')
    .description('初始化 change（在 git 仓库的主检出里默认建在 .worktrees/<name> 的独立 worktree；stdout 无输出，路径信息走 stderr）')
    // track/preset 非 requiredOption：缺省时 TTY 下走交互向导补齐、非交互 fail-loud（见 cmdInit）；
    // 若用 requiredOption，commander 会抢在 action 前就报错，向导没机会跑。
    .option('--track <track>', '工作流的轨道（tenon tracks list 查看）；有分支的工作流必填，平铺工作流省略')
    .option('--domain <track>', '轻量任务记下的领域轨道（同一工作流里的另一条轨道）；任务升级时用它给出后续重型任务的轨道')
    .option('--preset <preset>', 'full | hotfix | tweak（default 工作流必填；显式 --workflow 自定义工作流时可省略）')
    .option('--workflow <workflow>', '自定义 workflow 名（.pipeline/workflows/<name>.yaml），缺省 default')
    .option('--document-locale <locale>', '治理文档语言：zh-CN（默认）| en')
    .option('--in-place', '不建任务 worktree，原地初始化（仅在用户明确要求时使用）')
    .option('--json', 'stdout 输出一行 JSON：change、path、worktree（绝对路径或 null）、worktree_reason')
    .action(async (name: string, opts: InitCmdOpts) => bail(await cmdInit(deps, name, opts)))
}
