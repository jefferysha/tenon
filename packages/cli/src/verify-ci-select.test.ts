import { describe, expect, it } from 'vitest'
import { changeNameOfPath } from './commands/verify-ci-select.js'

describe('changeNameOfPath', () => {
  it('任务目录、归档目录（去日期前缀）、用户记录目录都指向任务名', () => {
    expect(changeNameOfPath('openspec/changes/demo/.pipeline.yaml')).toBe('demo')
    expect(changeNameOfPath('openspec/changes/archive/2026-08-01-demo/tasks.md')).toBe('demo')
    expect(changeNameOfPath('openspec/changes/archive/demo/tasks.md')).toBe('demo')
    expect(changeNameOfPath('.tenon/users/a-at-x.io/tests/demo/20260801T000000Z-abc123.json')).toBe('demo')
  })

  it('其他路径、任务目录自身、非法任务名都不属于任何任务', () => {
    expect(changeNameOfPath('src/a.ts')).toBeUndefined()
    expect(changeNameOfPath('openspec/changes/demo')).toBeUndefined()
    expect(changeNameOfPath('openspec/specs/auth/spec.md')).toBeUndefined()
    expect(changeNameOfPath('.tenon/tests/catalog.yaml')).toBeUndefined()
    expect(changeNameOfPath('.tenon/users/a-at-x.io/audit.jsonl')).toBeUndefined()
    expect(changeNameOfPath('openspec/changes/bad name/x.md')).toBeUndefined()
  })
})
