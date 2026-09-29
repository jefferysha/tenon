/**
 * 测试方向库的只读加载：内建（随 payload 分发）与自定义（全局配置目录）两处的 `<id>.yaml`，后面的根覆盖前面的同名方向。
 * 损坏的方向文件不进列表（不能当模板用），也不让整个库读不出来。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTestDirection, type TestDirectionDef } from '@tenon/kernel'

export async function loadTestDirections(roots: readonly string[]): Promise<readonly TestDirectionDef[]> {
  const byId = new Map<string, TestDirectionDef>()
  for (const root of roots) {
    let names: string[]
    try {
      names = (await readdir(root)).filter((name) => name.endsWith('.yaml')).sort()
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const definition = parseTestDirection(await readFile(join(root, name), 'utf8'))
        if (definition.id === name.replace(/\.yaml$/u, '')) byId.set(definition.id, definition)
      } catch {
        continue
      }
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}
