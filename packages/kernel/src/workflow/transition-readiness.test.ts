import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { emptyFields } from '../state/parse.js'
import { compileWorkflow } from './compile.js'
import { effectiveWorkflowPlanFromIr } from './effective-plan.js'
import { readinessByTransition } from './transition-readiness.js'
import type { WorkflowDef } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 一步带必须产出守卫（路径里有 `{change}`），一步收尾。 */
function observedWorkflow(): WorkflowDef {
  return {
    name: 'observed',
    steps: [
      {
        id: 'explore', label: 'Explore', gate: null, skills: [], inputs: [], outputs: [],
        guards: [{ type: 'required-output', path: 'openspec/changes/{change}/proposal.md' }],
        transitions: [{ event: 'explore-complete', to: 'done' }],
      },
      { id: 'done', label: 'Done', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
    ],
  }
}

async function readiness(requiredOutput: (step: string, pattern: string) => Promise<boolean>) {
  const root = await mkdtemp(join(tmpdir(), 'tenon-readiness-path-'))
  roots.push(root)
  const fields = emptyFields()
  Object.assign(fields, { phase: 'explore' })
  const plan = effectiveWorkflowPlanFromIr('observed', compileWorkflow(observedWorkflow()))
  const result = await readinessByTransition(plan, { fields, opaqueTail: '' }, { changeDirAbs: root, requiredOutput })
  return { change: basename(root), result }
}

describe('readinessByTransition 的必须产出阻断', () => {
  test('没写出来：guard-failed 阻断带上路径，{change} 已换成任务名', async () => {
    const { change, result } = await readiness(async () => false)
    expect(result.explore?.['explore-complete']).toEqual({
      ready: false,
      blockers: [{
        kind: 'guard-failed',
        guardType: 'required-output',
        actual: 'missing',
        path: `openspec/changes/${change}/proposal.md`,
      }],
    })
  })

  test('写出来了：就绪，没有阻断', async () => {
    const { result } = await readiness(async () => true)
    expect(result.explore?.['explore-complete']).toEqual({ ready: true, blockers: [] })
  })
})
