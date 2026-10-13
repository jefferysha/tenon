import { describe, expect, test } from 'vitest'
import { defaultOpenSpecScaffoldFiles, defaultTasksScaffoldFile } from './default-openspec-scaffold.js'

describe('defaultTasksScaffoldFile', () => {
  test('只渲染 tasks.md（观察模式的新任务只要它），内容与完整骨架里的 tasks.md 逐字相同', () => {
    const steps = [{ id: 'open', label: '打开' }, { id: 'verify', label: '验证' }]
    const only = defaultTasksScaffoldFile('demo', 'zh-CN', steps, 'workflow-defined')
    expect(only.relativePath).toBe('tasks.md')
    expect(only.content).toContain('## 打开')
    expect(only.content).toContain('## 验证')
    expect(only).toEqual(defaultOpenSpecScaffoldFiles('demo', 'zh-CN', steps, 'workflow-defined')[2])
  })

  test('英文 locale 渲染英文 tasks.md', () => {
    expect(defaultTasksScaffoldFile('english-change', 'en').content).toContain('# Tasks')
  })
})

describe('defaultOpenSpecScaffoldFiles', () => {
  test('默认中文文件和阶段标签由纯 renderer 生成', () => {
    const files = defaultOpenSpecScaffoldFiles('demo', 'zh-CN', [
      { id: 'open', label: '打开' },
      { id: 'verify', label: '验证' },
    ])

    expect(files.map((file) => file.relativePath)).toEqual([
      'proposal.md', 'design.md', 'tasks.md',
    ])
    expect(files[0]?.content).toContain('# 提案')
    expect(files[1]?.content).toContain('# 设计')
    expect(files[2]?.content).toContain('## 立项')
    expect(files[2]?.content).toContain('## 验证')
  })

  test('显式英文 locale 生成完整英文候选', () => {
    const files = defaultOpenSpecScaffoldFiles('english-change', 'en')

    expect(files[0]?.content).toContain('# Proposal')
    expect(files[1]?.content).toContain('# Design')
    expect(files[2]?.content).toContain('# Tasks')
  })
})
