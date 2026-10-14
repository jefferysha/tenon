import { describe, expect, it } from 'vitest'
import { TEST_CONTROL_DIRS, TEST_SOURCE_EXTENSIONS, hasTestSourceExtension, withoutControlPaths } from './test-paths.js'

describe('控制目录过滤', () => {
  it('去掉首段在控制目录里的路径，其余原样保留并保持顺序', () => {
    expect(withoutControlPaths(['openspec/a.test.ts', '.tenon/x.test.js', '.pipeline/y', 'src/a.test.ts'])).toEqual(['src/a.test.ts'])
    expect([...TEST_CONTROL_DIRS]).toEqual(['openspec', '.tenon', '.pipeline'])
  })

  it('只看首段：名字相近或嵌套在深处的目录不算控制目录', () => {
    const kept = ['src/openspec/a.test.ts', 'openspec-tools/a.test.ts', '.tenon-cache/x.test.js', 'docs/.pipeline/y.ts']
    expect(withoutControlPaths(kept)).toEqual(kept)
    // 恰好等于控制目录名（没有子路径）的条目是目录本身，同样排除。
    expect(withoutControlPaths(['openspec', '.tenon', 'src/a.ts'])).toEqual(['src/a.ts'])
  })

  it('空输入与不含控制目录的输入', () => {
    expect(withoutControlPaths([])).toEqual([])
    expect(withoutControlPaths(['a.ts', 'b/c.ts'])).toEqual(['a.ts', 'b/c.ts'])
  })

  it('不改动传入数组', () => {
    const input = ['openspec/a.ts', 'src/a.ts'] as const
    withoutControlPaths(input)
    expect([...input]).toEqual(['openspec/a.ts', 'src/a.ts'])
  })
})

describe('测试文件源码扩展名', () => {
  it('二十种源码扩展名为真', () => {
    expect(TEST_SOURCE_EXTENSIONS).toHaveLength(20)
    for (const ext of TEST_SOURCE_EXTENSIONS) expect(hasTestSourceExtension(`x/a.test.${ext}`), ext).toBe(true)
  })

  it('扩展名大小写不敏感', () => {
    expect(hasTestSourceExtension('A.TEST.TS')).toBe(true)
  })

  it('报告 / 数据 / 文档 / 快照 / 无扩展名为假', () => {
    for (const path of ['a.spec.report', 'data.spec.json', 'seed.json', 'a.test.snap', 'README.md', 'e2e/run', 'a.log', 'a.', 'ts', '.ts.bak']) {
      expect(hasTestSourceExtension(path), path).toBe(false)
    }
  })

  it('点开头的文件名只看最后一段扩展名', () => {
    expect(hasTestSourceExtension('dir.ts/file')).toBe(false)
    expect(hasTestSourceExtension('dir.ts/file.json')).toBe(false)
  })
})
