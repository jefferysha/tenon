/**
 * commander 装配：字段读写四命令（get / set / set-many / cas）。
 *
 * 与 program.ts 的其它 register* 模块同构：这里只做参数绑定与 exit 映射，
 * 判定与写入全在 commands/fields.ts 与 commands/field-writes.ts。
 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdCas, cmdGet, cmdSet, cmdSetMany } from './commands/fields.js'
import { bail } from './program-exit.js'

export function registerFieldCommands(program: Command, deps: CliDeps): void {
  program
    .command('get <name> <field>')
    .description('读字段（stdout: 裸值；字段缺失/未知 → 空行 + exit 0）')
    .action(async (name: string, fieldName: string) => bail(await cmdGet(deps, name, fieldName)))

  program
    .command('set <name> <field> <value>')
    .description('写字段（无输出；四闸/身份/负责人拒写 exit 1）')
    .action(async (name: string, fieldName: string, value: string) =>
      bail(await cmdSet(deps, name, fieldName, value)))

  program
    .command('set-many <name> <kv...>')
    .description('多字段原子写 key=value ...（无输出）')
    .action(async (name: string, kv: string[]) => bail(await cmdSetMany(deps, name, kv)))

  program
    .command('cas <name> <field> <expect> <next>')
    .description('compare-and-set（无输出；不匹配 exit 3）')
    .action(async (name: string, fieldName: string, expect: string, next: string) =>
      bail(await cmdCas(deps, name, fieldName, expect, next)))
}
