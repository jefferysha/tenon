import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKFLOW_TODO_STAGES,
  incompletePipelineTasksForExit,
  projectPipelineTodo,
} from './todo-projection.js'
import { renderTaskPlanTasksMd, type TaskPlanRevisionV1 } from '../task-plan/index.js'

function canonicalProjection(groupTitle = 'Verify'): string {
  const revision: TaskPlanRevisionV1 = {
    schema_version: 'task-plan/v1',
    plan_id: 'plan-1',
    revision_id: 'revision-1',
    revision_number: 1,
    status: 'frozen',
    created_at: '2026-08-03T00:00:00.000Z',
    requirements: [],
    acceptance_criteria: [],
    groups: [{ id: 'group-1', title: groupTitle, parent_id: null, work_item_ids: ['wi-1'] }],
    work_items: [{
      id: 'wi-1',
      title: 'Implement API',
      group_id: 'group-1',
      requirement_refs: [],
      acceptance_refs: [],
      depends_on: [],
      resource_claims: [],
      expected_outputs: [],
      validators: [],
    }],
  }
  return renderTaskPlanTasksMd(revision, { digest: 'sha256:abc' })
}

describe('projectPipelineTodo', () => {
  it('default 顺序来自 default.yaml 的生成步骤，并把带阶段标题的 OpenSpec checkbox 投影到对应阶段', () => {
    const todo = projectPipelineTodo({
      phase: 'build',
      tasksMarkdown: `# Tasks

## Open
- [x] Confirm the scope

## 实现
- [ ] Implement the API

## Verify
- [ ] Run browser acceptance
`,
    })

    expect(DEFAULT_WORKFLOW_TODO_STAGES.map((stage) => stage.id)).toEqual(
      ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'],
    )
    expect(todo.stages.map((stage) => stage.label)).toEqual(['立项', '调研', '规格', '实现', '验证', '交付', '完结'])
    expect(todo.stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'current', 'pending', 'pending', 'pending'])
    expect(todo.stages[0]?.tasks).toEqual([{ text: 'Confirm the scope', completed: true }])
    expect(todo.stages[3]?.tasks).toEqual([{ text: 'Implement the API', completed: false }])
    expect(todo.stages[4]?.tasks).toEqual([{ text: 'Run browser acceptance', completed: false }])
  })

  it('没有可识别阶段标题的 checkbox 不消失，而是归到当前 phase', () => {
    const todo = projectPipelineTodo({
      phase: 'explore',
      tasksMarkdown: `# Tasks

## Notes
- [ ] Investigate the current implementation
`,
    })
    expect(todo.stages.find((stage) => stage.id === 'explore')?.tasks).toEqual([
      { text: 'Investigate the current implementation', completed: false },
    ])
  })

  it.each(['Build', 'Verify', '实现', '验证'])(
    'canonical TaskGroup 展示标题 %s 不改变当前 phase exit gate',
    (groupTitle) => {
      expect(incompletePipelineTasksForExit({
        phase: 'build',
        tasksMarkdown: canonicalProjection(groupTitle),
        trustedCanonicalProjection: true,
      })).toEqual({ structured: false, incomplete: 1, items: ['Implement API'] })
    },
  )

  it('canonical Todo 只隐藏受信尾部 WorkItem marker，保留普通或非尾部 comment', () => {
    const canonical = canonicalProjection().replace(
      'Implement API',
      'Implement <!-- work-item:fake --> API <!-- work-item:bad value --> <!-- ordinary -->',
    )
    const todo = projectPipelineTodo({
      phase: 'build',
      tasksMarkdown: canonical,
      trustedCanonicalProjection: true,
    })
    expect(todo.stages.find((stage) => stage.id === 'build')?.tasks).toEqual([
      {
        text: 'Implement <!-- work-item:fake --> API <!-- work-item:bad value --> <!-- ordinary -->',
        completed: false,
      },
    ])

    const legacy = projectPipelineTodo({
      phase: 'build',
      tasksMarkdown: '- [ ] Keep <!-- work-item:user-text -->\n',
    })
    expect(legacy.stages.find((stage) => stage.id === 'build')?.tasks).toEqual([
      { text: 'Keep <!-- work-item:user-text -->', completed: false },
    ])
  })

  it('header spoof 不会获得 canonical marker 展示剥离权限', () => {
    const spoof = canonicalProjection('Notes')
    const todo = projectPipelineTodo({
      phase: 'build',
      tasksMarkdown: spoof,
      trustedCanonicalProjection: false,
    })
    expect(todo.stages.find((stage) => stage.id === 'build')?.tasks).toEqual([
      { text: 'Implement API <!-- work-item:wi-1 -->', completed: false },
    ])
  })

  it('custom workflow 可传自己的有序阶段，不错误展示 default 七步', () => {
    const todo = projectPipelineTodo({
      phase: 'review',
      stages: [{ id: 'draft', label: 'Draft' }, { id: 'review', label: 'Review' }],
      tasksMarkdown: '## Review\n- [x] Review the proposal\n',
    })
    expect(todo.stages).toEqual([
      { id: 'draft', label: 'Draft', status: 'done', tasks: [] },
      { id: 'review', label: 'Review', status: 'current', tasks: [{ text: 'Review the proposal', completed: true }] },
    ])
  })

  it('阶段出口只统计截至当前阶段的未完成任务，未来阶段不会反向阻塞', () => {
    const tasksMarkdown = `# Tasks

## Open
- [x] Confirm scope

## Build
- [ ] Implement runtime

## Verify
- [ ] Run acceptance

## Ship
- [ ] Publish bundle
`
    expect(incompletePipelineTasksForExit({ phase: 'build', tasksMarkdown })).toEqual({
      structured: true,
      incomplete: 1,
      items: ['Implement runtime'],
    })
    expect(incompletePipelineTasksForExit({
      phase: 'build',
      tasksMarkdown: tasksMarkdown.replace('- [ ] Implement runtime', '- [x] Implement runtime'),
    })).toEqual({ structured: true, incomplete: 0, items: [] })
    // 未勾项原文按文件顺序给出，未来阶段的不算（ship 出口看得到 build 与 verify 的遗留）。
    expect(incompletePipelineTasksForExit({ phase: 'ship', tasksMarkdown }).items)
      .toEqual(['Implement runtime', 'Run acceptance', 'Publish bundle'])
  })

  it('无阶段标题的旧 tasks.md 保持兼容：只有 build 沿用全清单完成语义', () => {
    const tasksMarkdown = '- [x] Existing task\n- [ ] Pending task\n'
    expect(incompletePipelineTasksForExit({ phase: 'spec', tasksMarkdown })).toEqual({
      structured: false,
      incomplete: 0,
      items: [],
    })
    expect(incompletePipelineTasksForExit({ phase: 'build', tasksMarkdown })).toEqual({
      structured: false,
      incomplete: 1,
      items: ['Pending task'],
    })
  })
})

describe('branched workflow Todo status', () => {
  const stages = [
    { id: 'change', label: 'Change', transitions: ['verify', 'escalated'] },
    { id: 'verify', label: 'Verify', transitions: ['done', 'change', 'escalated'] },
    { id: 'done', label: 'Done', transitions: [] },
    { id: 'escalated', label: 'Escalated', transitions: [] },
  ] as const

  it('marks only dominators complete, so an escalated branch never fabricates verify/done completion', () => {
    const todo = projectPipelineTodo({ phase: 'escalated', tasksMarkdown: undefined, stages })
    expect(todo.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ['change', 'done'],
      ['verify', 'pending'],
      ['done', 'pending'],
      ['escalated', 'current'],
    ])
  })

  it('retains the linear successful path for done', () => {
    const todo = projectPipelineTodo({ phase: 'done', tasksMarkdown: undefined, stages })
    expect(todo.stages.map((stage) => stage.status)).toEqual(['done', 'done', 'current', 'pending'])
  })
})
