import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdDesignCheck, cmdDesignPropose, cmdDesignValidate } from './commands/design.js'
import { cmdResourcesList, cmdResourcesShow, type ResourcesListOpts } from './commands/resources.js'
import { bail } from './program-exit.js'

export function registerResourceCommands(program: Command, deps: CliDeps): void {
  const resources = program
    .command('resources')
    .description('资源目录只读视图：list / show <id>（--json 稳定输出）')
    .action(() => {
      deps.io.err('用法：tenon resources <list|show> …（详见 tenon resources --help）')
      bail(1)
    })
  resources
    .command('list')
    .description('按类别 / 框架 / 样式 / 许可 / 关键字筛选条目（固定列 ID 类别 许可 名称）')
    .option('--category <category>', '组件库 blocks template icons animation motion-components design-md state styling')
    .option('--framework <framework>', 'web react next vue nuxt angular svelte react-native flutter swiftui compose')
    .option('--styling <styling>', 'tailwind css css-modules sass less css-in-js vanilla-extract unocss panda native')
    .option('--license <mode>', 'redistributable | link-only | attribution')
    .option('--query <text>', 'id / 名称 / 场景 的子串匹配')
    .option('--json', 'JSON 输出（entries + errors）')
    .action(async (opts: ResourcesListOpts) => bail(await cmdResourcesList(deps, opts)))
  resources
    .command('show <id>')
    .description('显示一条资源的许可、安装、链接与技能')
    .option('--json', 'JSON object 输出')
    .action(async (id: string, opts: { json?: boolean }) => bail(await cmdResourcesShow(deps, id, opts)))
}

export function registerDesignCommands(program: Command, deps: CliDeps): void {
  const design = program
    .command('design')
    .description('项目设计体系：check（结构）/ validate（hue 校验 + 提案合并）/ propose <change>')
    .action(() => {
      deps.io.err('用法：tenon design <check|validate|propose> …（详见 tenon design --help）')
      bail(1)
    })
  design
    .command('check')
    .description('DESIGN.md 结构检查：缺失 / 起步 / 不完整 / 就绪')
    .option('--json', 'JSON object 输出（status + problems）')
    .action(async (opts: { json?: boolean }) => bail(await cmdDesignCheck(deps, opts)))
  design
    .command('validate')
    .description('结构就绪后跑上游 hue 校验器，并检查设计变更提案是否已合并')
    .option('--change <change>', '任务名（缺省取 TENON_CHANGE_NAME）')
    .action(async (opts: { change?: string }) => bail(await cmdDesignValidate(deps, opts)))
  design
    .command('propose <change>')
    .description('写 openspec/changes/<change>/design-system.md 提案骨架')
    .action(async (change: string) => bail(await cmdDesignPropose(deps, change)))
}
