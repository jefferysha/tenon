import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { materializeWorkflowIo } from './effective-io.js'
import { parseWorkflow } from './parse.js'
import type { WorkflowDef } from './types.js'
import { selectTrackBranch } from './validate.js'

// default 只有分支：IO 物化针对一条 pipeline，用 frontend 分支。
const defaultDef = selectTrackBranch(parseWorkflow(DEFAULT_WORKFLOW_SOURCE), 'frontend')

describe('materializeWorkflowIo', () => {
  it('gives every default step at least one output and merges document slots with field slots', () => {
    const io = materializeWorkflowIo(defaultDef)
    for (const step of defaultDef.steps) {
      expect(io[step.id]?.outputs.length, step.id).toBeGreaterThan(0)
    }
    expect(io.open?.outputs.map((slot) => slot.id)).toEqual(['proposal', 'openspec-design', 'tasks'])
    expect(io.build?.outputs).toEqual([
      { kind: 'field', id: 'build_sha', type: 'string', producer: null, consumers: ['verify'] },
    ])
    expect(io.ship?.outputs.map((slot) => slot.id)).toEqual(['applied-spec', 'pr_url'])
    expect(io.archive?.outputs).toEqual([{ kind: 'field', id: 'archived', type: 'boolean', producer: null, consumers: [] }])
  })

  it('resolves field producers from the nearest upstream output and document owners from the policy', () => {
    const io = materializeWorkflowIo(defaultDef)
    const buildInputs = io.build?.inputs ?? []
    const field = (id: string) => buildInputs.find((slot) => slot.kind === 'field' && slot.id === id)
    const document = (id: string) => buildInputs.find((slot) => slot.kind === 'document' && slot.id === id)
    expect(field('design_doc')).toMatchObject({ producer: 'explore' })
    // 文档 kind 'plan' 与字段 'plan' 同名并存：一个是台账文档，一个是 change 字段，各自独立成槽。
    expect(field('plan')).toMatchObject({ producer: 'spec' })
    expect(document('plan')).toMatchObject({ producers: ['spec'], locked: true })
    expect(document('proposal')).toMatchObject({ producers: ['open'], locked: true })
    expect(io.explore?.outputs.find((slot) => slot.id === 'design_doc')).toMatchObject({ consumers: ['spec', 'build'] })
  })

  it('marks default document slots locked and custom document_contract slots editable', () => {
    expect(materializeWorkflowIo(defaultDef).open?.outputs[0]).toMatchObject({ locked: true })
    const custom: WorkflowDef = {
      name: 'short',
      documentContract: {
        version: 'v1',
        slots: [{ kind: 'proposal', ownerStep: 'draft', producers: ['openspec-propose'] }],
        reads: [{ step: 'done', kinds: ['proposal'] }],
      },
      steps: [
        { id: 'draft', label: '起草', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'done' }] },
        { id: 'done', label: '完成', gate: null, skills: [], inputs: [], outputs: [{ field: 'archived', type: 'boolean' }], guards: [], transitions: [] },
      ],
    }
    const io = materializeWorkflowIo(custom)
    expect(io.draft?.outputs).toEqual([
      { kind: 'document', id: 'proposal', producers: ['openspec-propose'], consumers: ['done'], locked: false },
    ])
    expect(io.done?.inputs).toEqual([
      { kind: 'document', id: 'proposal', producers: ['draft'], consumers: [], locked: false },
    ])
  })

  it('returns only field slots when a workflow has no document governance', () => {
    const plain: WorkflowDef = {
      name: 'plain',
      steps: [
        { id: 'a', label: 'A', gate: null, skills: [], inputs: [], outputs: [{ field: 'plan', type: 'file_path' }], guards: [], transitions: [{ event: 'go', to: 'b' }] },
        { id: 'b', label: 'B', gate: null, skills: [], inputs: [{ field: 'plan', type: 'file_path' }], outputs: [], guards: [], transitions: [] },
      ],
    }
    const io = materializeWorkflowIo(plain)
    expect(io.a?.outputs).toEqual([{ kind: 'field', id: 'plan', type: 'file_path', producer: null, consumers: ['b'] }])
    expect(io.b?.inputs).toEqual([{ kind: 'field', id: 'plan', type: 'file_path', producer: 'a', consumers: [] }])
    expect(io.b?.outputs).toEqual([])
  })
})
