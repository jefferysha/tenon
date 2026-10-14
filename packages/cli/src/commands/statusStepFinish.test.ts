import { describe, expect, test } from 'vitest'
import { WORKSPACE_COMMIT_PATHS, type GitFinishProbe } from '../gitWorkspace.js'
import { finishActions, finishedStop } from './statusStepFinish.js'

describe('finishedStop —— 目录已移进 archive/ 之后的 stop，按任务结果换说法', () => {
  test('缺省与完结说「已完结」，已升级说「已升级」，已终止说「已终止」；动作码恒为 finished', () => {
    expect(finishedStop('demo')).toEqual([{ action: 'stop', code: 'finished', message: "任务 'demo' 已完结，没有要做的事了" }])
    expect(finishedStop('demo', 'finished')).toEqual(finishedStop('demo'))
    expect(finishedStop('demo', 'escalated')).toEqual([{ action: 'stop', code: 'finished', message: "任务 'demo' 已升级，没有要做的事了" }])
    expect(finishedStop('demo', 'terminated')).toEqual([{ action: 'stop', code: 'finished', message: "任务 'demo' 已终止，没有要做的事了" }])
  })
})

describe('finishActions —— 收尾提交的形状', () => {
  const GIT: GitFinishProbe = {
    changeDirTracked: true,
    workspaceDirty: true,
    deliverablesDirty: true,
    stepDirty: true,
    delivered: true,
    housekeeping: ['openspec/.gitignore'],
    untrack: [],
    designSystem: ['DESIGN.md', 'design'],
  }

  test('走 OpenSpec 的任务：只提交任务目录、archive/ 与 housekeeping，不带设计文件', () => {
    expect(finishActions('demo', true, { git: GIT, verified: true })).toEqual([{
      action: 'finish-change',
      change: 'demo',
      command: 'tenon task finish demo',
      commit: {
        paths: ['openspec/changes/demo', 'openspec/changes/archive', 'openspec/.gitignore'],
        untrack: [],
        message: 'chore(openspec): archive demo',
      },
      cleanup: null,
    }])
  })

  // 升级前创建的设计体系任务：冻结计划仍走 OpenSpec，设计文件要在收尾提交里单独点名。
  test('走 OpenSpec 的设计体系任务（升级前创建）：设计文件单独点名', () => {
    const [action] = finishActions('demo', true, { git: GIT, verified: false, designSystem: true })
    expect(action).toMatchObject({
      commit: { paths: ['openspec/changes/demo', 'openspec/changes/archive', 'DESIGN.md', 'design', 'openspec/.gitignore'] },
    })
  })

  test('不走 OpenSpec、成功收尾：整个工作区的一次提交（设计文件已在 `.` 之内）', () => {
    const [action] = finishActions('demo', false, { git: GIT, verified: true, designSystem: true })
    expect(action).toMatchObject({
      commit: { paths: WORKSPACE_COMMIT_PATHS, untrack: [], message: 'chore(tenon): finish demo' },
    })
    expect(WORKSPACE_COMMIT_PATHS).toContain('.')
  })

  test('不走 OpenSpec、没有成功收尾（放弃出口）或不是 git 仓：不发提交', () => {
    expect(finishActions('demo', false, { git: GIT, verified: false })[0]).toMatchObject({ commit: null })
    expect(finishActions('demo', false, { git: null, verified: true })[0]).toMatchObject({ commit: null })
  })
})
