import { describe, expect, it } from 'vitest'
import { readWorkflowDeleteResponse, splitWorkflowReferences } from './workbenchApiDecoders'

const refused = (references: unknown[]): Response =>
  new Response(JSON.stringify({ ok: false, code: 'WORKFLOW_REFERENCED', workflow: 'flow', references }), { status: 409 })

describe('删除工作流的引用清单', () => {
  it('认任务、循环、策略模板三种引用', async () => {
    const result = await readWorkflowDeleteResponse(refused([
      { kind: 'active-change', source: 'change:login-fix' },
      { kind: 'loop-binding', source: 'loop:nightly' },
      { kind: 'policy-template-recommended', source: 'template:daily-triage' },
    ]))
    expect(result.kind).toBe('error')
  })

  it('轨道登记表的引用种类已不存在：当作无法识别的响应', async () => {
    expect((await readWorkflowDeleteResponse(refused([{ kind: 'track-default', source: 'track:chat' }]))).kind).toBe('invalid')
    expect((await readWorkflowDeleteResponse(refused([{ kind: 'track-allowed', source: 'track:chat' }]))).kind).toBe('invalid')
  })

  it('splitWorkflowReferences：任务单列去重，其余按循环 / 模板分类去重', () => {
    expect(splitWorkflowReferences([
      { kind: 'active-change', source: 'change:a' },
      { kind: 'active-change', source: 'change:a' },
      { kind: 'loop-binding', source: 'loop:l1' },
      { kind: 'loop-binding', source: 'loop:l1' },
      { kind: 'policy-template-recommended', source: 'template:t1' },
    ])).toEqual({
      tasks: ['a'],
      references: [{ kind: 'loop', name: 'l1' }, { kind: 'template', name: 't1' }],
    })
  })
})
