import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dependencyWaves } from './dag-waves.js'

describe('dependencyWaves', () => {
  it('无前置 = 0；否则 1 + 前置的最大波；图外的前置不计；环按回边 0 处理', () => {
    const waves = dependencyWaves([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a', 'b'] },
      { id: 'd', dependsOn: ['nowhere'] },
      { id: 'x', dependsOn: ['y'] },
      { id: 'y', dependsOn: ['x'] },
    ])
    expect(Object.fromEntries(waves)).toMatchObject({ a: 0, b: 1, c: 2, d: 0 })
    expect(waves.get('x')).toBeGreaterThanOrEqual(0)
    expect(waves.get('y')).toBeGreaterThanOrEqual(0)
  })
})

/**
 * 波次只有 kernel 的 dependencyWaves 一个算法（产品评估 P2：服务端 skillRuns 与 Dashboard skillWaves 各有一份自己的）。
 * 这里按源码守住：别处不再定义自己的波次 / 深度递归函数，两个使用方都从 kernel 取。
 */
describe('波次计算只有一处', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const read = (path: string): string => readFileSync(join(root, path), 'utf8')

  it('服务端技能投影与 Dashboard 画布都用 dependencyWaves，不再自带递归', () => {
    const server = read('server/src/skillRuns.ts')
    const dashboard = read('dashboard-app/src/workbench/skillWaves.ts')
    expect(server).toContain('dependencyWaves')
    expect(dashboard).toContain('dependencyWaves')
    for (const source of [server, dashboard]) {
      expect(source).not.toMatch(/function (?:waveOf|depthOf)\b/u)
    }
  })
})
