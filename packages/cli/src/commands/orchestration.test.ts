import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationLedger, type BoardCommandV2, type CapabilityAssessmentV2, type DevelopmentRequestV2, type RepositoryContextV2 } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { cmdOrchestrationControl, cmdOrchestrationEvents, cmdOrchestrationFreezePipeline, cmdOrchestrationInit, cmdOrchestrationStatus, cmdOrchestrationWatch, parseOrchestrationAfter } from './orchestration.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function deps(cwd: string, out: string[], err: string[]): CliDeps {
  return { cwd, clock: () => '2026-09-02T00:00:00.000Z', io: { out: (line) => out.push(line), err: (line) => err.push(line) } } as unknown as CliDeps
}

describe('orchestration CLI v2', () => {
  it('rejects unsafe cursors before touching the ledger', () => {
    expect(parseOrchestrationAfter('-1')).toBe(-1)
    expect(parseOrchestrationAfter('2049')).toBe(-1)
    expect(parseOrchestrationAfter('12')).toBe(12)
  })

  it('initializes, reports, lists events and controls a real ledger', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tenon-cli-orchestration-')); roots.push(cwd)
    await mkdir(path.join(cwd, 'openspec', 'changes', 'demo'), { recursive: true })
    const output: string[] = []; const errors: string[] = []; const injected = deps(cwd, output, errors)
    expect(await cmdOrchestrationInit(injected, 'demo', 'project-1', 'corr-1')).toBe(0)
    expect(await cmdOrchestrationStatus(injected, 'demo', true)).toBe(0)
    expect(await cmdOrchestrationEvents(injected, 'demo', 0, true)).toBe(0)
    expect(await cmdOrchestrationWatch(injected, 'demo', true, false)).toBe(0)
    expect(await cmdOrchestrationControl(injected, 'demo', 'pause-change', 'operator')).toBe(1)
    expect(errors.at(-1)).toContain('pause-state')
    expect(output.some((line) => line.includes('orchestration-cli-status/v2'))).toBe(true)
  })

  it('freeze-pipeline validates the payload before delegating to the durable writer', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tenon-cli-freeze-')); roots.push(cwd)
    await mkdir(path.join(cwd, 'openspec', 'changes', 'demo'), { recursive: true })
    const output: string[] = []; const errors: string[] = []
    const injected = {
      ...deps(cwd, output, errors),
      orchestrationFreezePipeline: async ({ changeDir, pipeline }: { changeDir: string; pipeline: unknown }) => ({ change_id: path.basename(changeDir), pipeline } as never),
    } as CliDeps
    expect(await cmdOrchestrationFreezePipeline(injected, 'demo', '{bad')).toBe(1)
    expect(errors.at(-1)).toContain('pipeline JSON 无效')
    // This test covers CLI parsing/decoding only; the injected writer is deliberately a seam.
    expect(await cmdOrchestrationFreezePipeline(injected, 'demo', JSON.stringify({ pipeline_id: 'p' }))).toBe(1)
    expect(errors.at(-1)).toContain('pipeline JSON 无效')
    expect(output).toHaveLength(0)
    const file = path.join(cwd, 'pipeline.json')
    await writeFile(file, '{"pipeline_id":"p"}', 'utf8')
    expect(await cmdOrchestrationFreezePipeline(injected, 'demo', undefined, file)).toBe(1)
    expect(errors.at(-1)).toContain('pipeline JSON 无效')
  })

  it('reports the kernel binding rejection through a real ledger writer', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tenon-cli-freeze-ledger-')); roots.push(cwd)
    const changeDir = path.join(cwd, 'openspec', 'changes', 'demo'); await mkdir(changeDir, { recursive: true })
    const now = '2026-09-02T00:00:00.000Z'
    const ledger = createOrchestrationLedger()
    await ledger.initialize(changeDir, { project_id: 'project-1', change_id: 'demo', correlation_id: 'corr-1', updated_at: now })
    const request: DevelopmentRequestV2 = {
      schema_version: 'development-request/v2', record_id: 'request:req-1', project_id: 'project-1', change_id: 'demo', revision: 0,
      correlation_id: 'corr-1', actor: { kind: 'user', id: 'alice' }, created_at: now, request_id: 'req-1', intent: 'ship',
      interaction_policy: 'recommended-defaults', requested_effects: ['read'], constraints: [], user_skills: [], user_mcps: [], auto_select: true,
    }
    const context: RepositoryContextV2 = {
      schema_version: 'repository-context/v2', record_id: 'context:1', project_id: 'project-1', change_id: 'demo', revision: 0,
      correlation_id: 'corr-1', actor: { kind: 'system', id: 'host' }, created_at: now, request_id: 'req-1',
      repository: { ref: 'repo', branch: 'main', base_branch: 'main', head_sha: 'abc', dirty: false },
      workspace_fingerprint: `sha256:${'a'.repeat(64)}`, policy_digest: `sha256:${'b'.repeat(64)}`,
      skill_catalog_digest: `sha256:${'c'.repeat(64)}`, mcp_catalog_digest: `sha256:${'d'.repeat(64)}`, observed_facts: [],
    }
    const assessment: CapabilityAssessmentV2 = {
      schema_version: 'capability-assessment/v2', record_id: 'assessment:1', project_id: 'project-1', change_id: 'demo', revision: 1,
      correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, assessment_id: 'assessment-1', request_id: 'req-1',
      context_record_id: 'context:1', normalization: 'complete', requirements: [], questions: [], risks: [], proposal_evidence_ref: 'evidence:1',
    }
    const append = async (type: BoardCommandV2['type'], payload: Record<string, unknown>, revision: number): Promise<void> => {
      const result = await ledger.append(changeDir, {
        schema_version: 'board-command/v2', command_id: `seed-${type}`, idempotency_key: `seed-${type}`, expected_revision: revision,
        actor: { kind: 'system', id: 'test' }, issued_at: now, correlation_id: 'corr-1', change_id: 'demo', type, ...payload,
      } as BoardCommandV2)
      if (result.kind !== 'committed') throw new Error(`seed failed: ${type}`)
    }
    await append('accept-request', { request }, 0)
    await append('record-context', { context }, 1)
    await append('record-assessment', { assessment }, 2)
    const pipeline = {
      schema_version: 'workflow-pipeline/v2', record_id: 'pipeline:demo', project_id: 'project-1', change_id: 'demo', revision: 3,
      correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: now, pipeline_id: 'demo:p', pipeline_version: '1',
      workflow_id: 'simple', workflow_version: '1', workflow_source: 'user', workflow_fingerprint: `sha256:${'a'.repeat(64)}`,
      track_id: 'backend', track_revision: '1', track_source: 'project', pipeline_source: 'user', graph_id: 'graph:demo',
      assessment_id: 'assessment-other', status: 'frozen', stage_order: ['item-1'], stages: [{ stage_id: 'item-1', name: 'Build', ordinal: 0,
        execution_mode: 'serial', depends_on: [], work_item_ids: ['item-1'], gate: 'none', skills: [], input_refs: [], output_refs: ['result:item-1'] }],
      customizations: { custom_workflow: true, custom_track: false, custom_pipeline: false, user_skill_ids: [], user_mcp_ids: [] },
      pipeline_digest: `sha256:${'b'.repeat(64)}`,
    }
    const output: string[] = []; const errors: string[] = []
    const injected = {
      ...deps(cwd, output, errors),
      orchestrationFreezePipeline: async ({ changeDir: dir, pipeline: value }: { changeDir: string; pipeline: unknown }) => {
        const current = await ledger.readSnapshot(dir); if (current === undefined) throw new Error('missing snapshot')
        const result = await ledger.append(dir, {
          schema_version: 'board-command/v2', command_id: 'freeze-real', idempotency_key: 'freeze-real', expected_revision: current.revision,
          actor: { kind: 'system', id: 'cli' }, issued_at: now, correlation_id: current.correlation_id,
          causation_id: current.event_head_id, change_id: current.change_id, type: 'freeze-pipeline', pipeline: value,
        } as BoardCommandV2)
        if (result.kind === 'rejected') throw new Error(`${result.rejection.reason_code}: ${result.rejection.message}`)
        return result.snapshot
      },
    } as CliDeps
    expect(await cmdOrchestrationFreezePipeline(injected, 'demo', JSON.stringify(pipeline))).toBe(1)
    expect(errors.at(-1)).toContain('pipeline-binding-invalid')
    expect(output).toHaveLength(0)
  })
})
