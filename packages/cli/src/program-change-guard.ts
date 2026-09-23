/**
 * 作用于既有 change 的命令在动作之前先确认 change 存在：不存在时与 `tenon status/get` 同一句
 * `ERROR: change 不存在: <name>`、exit 1，而不是泄漏 `ENOENT … .pipeline.yaml` 或
 * `ENOENT … .pipeline.lock.claim-<uuid>` 这类内部存储路径。
 *
 * 只对下表列出的命令生效（第一个位置参数就是 change 名）；读经注入的 store 走 readChangeForDisplay，
 * 与只读命令同一条归档回落，所以已归档的 change 不会被误判为不存在。只有 ENOENT 被翻译，其它读错误
 * 原样交给命令自己报告。
 */
import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { isValidChangeName, readChangeForDisplay } from './paths.js'
import { CliExit } from './program-exit.js'

export const CHANGE_COMMANDS: ReadonlySet<string> = new Set([
  'set', 'set-many', 'cas', 'transition', 'check', 'advance', 'handoff',
  'test run', 'test status', 'test baseline', 'test report',
  'agent next', 'agent prompt', 'agent record',
  'workflow plan',
  'document status', 'document read', 'document record', 'document scaffold',
  'artifact register',
])

function commandPath(command: Command): string {
  const names: string[] = []
  for (let cur: Command | null = command; cur !== null && cur.parent !== null; cur = cur.parent) names.unshift(cur.name())
  return names.join(' ')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

export function registerChangeExistenceGuard(program: Command, deps: CliDeps): void {
  program.hook('preAction', async (_root, action) => {
    if (!CHANGE_COMMANDS.has(commandPath(action))) return
    const name = action.args[0]
    if (name === undefined || !isValidChangeName(name)) return
    try {
      await readChangeForDisplay((dir) => deps.store.read(dir), deps.cwd, name)
    } catch (error) {
      if (!isMissing(error)) return
      deps.io.err(`ERROR: change 不存在: ${name}`)
      throw new CliExit(1)
    }
  })
}
