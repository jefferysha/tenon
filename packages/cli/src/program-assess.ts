import type { Command } from 'commander'
import { cmdAssess, type AssessOpts } from './commands/assess.js'
import type { CliDeps } from './deps.js'
import { bail } from './program-exit.js'

/** `tenon assess`：建任务前评估轻重（装配在这里，program.ts 只调用 `registerAssessCommand`）。 */
export function registerAssessCommand(program: Command, deps: CliDeps): void {
  program
    .command('assess')
    .description('建任务前评估轻重：用与改动风险探针相同的规则与阈值评估一组预计要改的文件（退出码 0 不超限 · 3 超限 · 1 用法错误或该轨道没有改动风险阈值）')
    .option('--files <paths...>', '预计要改的仓库内相对路径（不接受绝对路径、.. 段、指向仓库外的符号链接；只按路径分类，不读文件内容）')
    .option('--workflow <workflow>', '按哪个工作流评估（缺省 default）')
    .option('--track <track>', '阈值取自哪条轨道的 diff-risk 测试（default 工作流缺省 lite；平铺工作流不必写）')
    .option('--json', 'JSON 输出：workflow、track、metrics、exceeded、reasons、recommendation')
    .action(async (opts: AssessOpts) => bail(await cmdAssess(deps, opts)))
}
