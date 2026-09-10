import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTrack, type EffectiveWorkflowPlan, type SkillTable } from '@tenon/kernel'
import { projectSkillRuns } from './skillRuns.js'
import { buildSnapshot } from './snapshot.js'
import { initChange, makeProject, newStore } from './test-support.js'
import { resolveSnapshotEffectivePlan } from './workflowSnapshot.js'

async function skillRuns(root: string, store: ReturnType<typeof newStore>) {
  const snapshot = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
  const runs = snapshot.projects[0]?.changes[0]?.skillRuns
  if (runs === undefined) throw new Error('skillRuns missing')
  return runs
}

describe('skillRuns projection', () => {
  it('当前步按 history 判 idle → running → done；早于当前 done、晚于当前 idle；矩阵技能按轨道并入', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'demo', { track: 'backend' })

    let runs = await skillRuns(root, store)
    expect(runs.map((step) => step.stepId)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    const open = runs[0]!
    expect(open.skills.map((skill) => skill.id)).toEqual(expect.arrayContaining(['tenon-open', 'openspec-propose']))
    expect(open.skills.every((skill) => skill.status === 'idle' && skill.wave === 0)).toBe(true)
    expect(runs[1]!.skills.every((skill) => skill.status === 'idle')).toBe(true)
    // backend 轨没有 handoff（只属 pm）
    expect(runs[4]!.skills.map((skill) => skill.id)).not.toContain('handoff')
    expect(runs[4]!.skills.map((skill) => skill.id)).toContain('verification-before-completion')

    const history = join(changeDir, '.pipeline-history.jsonl')
    await appendFile(history, `${JSON.stringify({ ts: '2026-07-07T00:01:00Z', kind: 'tool-start', raw: 'Skill: openspec-propose' })}\n`, 'utf8')
    runs = await skillRuns(root, store)
    expect(runs[0]!.skills.find((skill) => skill.id === 'openspec-propose')?.status).toBe('running')
    expect(runs[0]!.skills.find((skill) => skill.id === 'tenon-open')?.status).toBe('idle')

    await appendFile(history, `${JSON.stringify({ ts: '2026-07-07T00:02:00Z', kind: 'tool', raw: 'Skill: superpowers:openspec-propose' })}\n`, 'utf8')
    runs = await skillRuns(root, store)
    expect(runs[0]!.skills.find((skill) => skill.id === 'openspec-propose')?.status).toBe('done')
  })

  it('manifest-overlay 计划另叠加 manifest mandatory 表（去重），a|b 备选任一有证据即 done', async () => {
    const root = await makeProject()
    const changeDir = await initChange(newStore(), root, 'demo', { track: 'backend' })
    const current = resolveSnapshotEffectivePlan(root, 'default', {}, undefined, builtinTrack('backend'))
    const plan = current as EffectiveWorkflowPlan
    const table = { open: { backend: ['openspec-propose|opsx:propose'], _all: ['fallback'] } } as unknown as SkillTable
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({ ts: 't', kind: 'tool', raw: 'Skill: opsx:propose' })}\n`, 'utf8')
    const runs = await projectSkillRuns(changeDir, plan, 'open', builtinTrack('backend'), table)
    expect(runs[0]!.skills.map((skill) => [skill.id, skill.status])).toEqual([['tenon-open', 'idle'], ['openspec-propose', 'done'], ['openspec-propose|opsx:propose', 'done']])
    const none = await projectSkillRuns(changeDir, plan, 'open', builtinTrack('backend'))
    expect(none[0]!.skills.map((skill) => skill.id)).toEqual(['tenon-open', 'openspec-propose'])
  })

  it('进入当前步之前的技能记录不算：只看最后一次 transition 到本步之后', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'demo', { track: 'backend' })
    const history = join(changeDir, '.pipeline-history.jsonl')
    await appendFile(history, [
      JSON.stringify({ ts: '2026-07-07T00:01:00Z', kind: 'tool', raw: 'Skill: tenon-open' }),
      JSON.stringify({ ts: '2026-07-07T00:02:00Z', kind: 'transition', field: 'phase', from: 'explore', to: 'open' }),
    ].map((line) => `${line}\n`).join(''), 'utf8')
    const runs = await skillRuns(root, store)
    expect(runs[0]!.skills.find((skill) => skill.id === 'tenon-open')?.status).toBe('idle')
  })
})
