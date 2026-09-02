import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshotV2 } from '@tenon/kernel'
import { I18nProvider } from '../i18n'
import { OrchestrationV2Panel } from './OrchestrationV2Panel'
import { fetchOrchestrationV2Snapshot, postOrchestrationV2Command, postOrchestrationV2Control, subscribeOrchestrationV2 } from '../api/orchestrationV2Client'

vi.mock('../api/orchestrationV2Client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orchestrationV2Client')>()
  return { ...actual, fetchOrchestrationV2Snapshot: vi.fn(), postOrchestrationV2Command: vi.fn(), postOrchestrationV2Control: vi.fn(), subscribeOrchestrationV2: vi.fn(() => vi.fn()) }
})

const snapshot = (status: BoardSnapshotV2['status'], revision = 3): BoardSnapshotV2 => ({
  schema_version: 'board-snapshot/v2', record_id: 'change:demo', project_id: 'project-1', change_id: 'demo', revision,
  correlation_id: 'corr-1', actor: { kind: 'system', id: 'kernel' }, created_at: '2026-09-02T00:00:00.000Z', status,
  work_items: [{
    schema_version: 'work-item/v2', record_id: 'work-item:api', project_id: 'project-1', change_id: 'demo', revision,
    correlation_id: 'corr-1', actor: { kind: 'system', id: 'kernel' }, created_at: '2026-09-02T00:00:00.000Z', work_item_id: 'api', title: 'Build API', status: status === 'completed' ? 'completed' : 'running', depends_on: [], required_artifact_refs: [], validation_refs: [], mode: 'parallel', attempt_count: 1, blockers: [],
  }], runs: [], results: [], validations: [], gates: [], leases: [], blockers: [], next_actions: [], updated_at: '2026-09-02T00:00:00.000Z',
})

beforeEach(() => {
  localStorage.setItem('tenon-dashboard-lang', 'zh')
  vi.mocked(fetchOrchestrationV2Snapshot).mockReset()
  vi.mocked(postOrchestrationV2Control).mockReset()
  vi.mocked(postOrchestrationV2Command).mockReset()
  vi.mocked(subscribeOrchestrationV2).mockClear()
})

describe('OrchestrationV2Panel', () => {
  it('paints the durable snapshot and applies only newer stream frames', async () => {
    vi.mocked(fetchOrchestrationV2Snapshot).mockResolvedValue(snapshot('executing'))
    let onFrame: Parameters<typeof subscribeOrchestrationV2>[2] | undefined
    vi.mocked(subscribeOrchestrationV2).mockImplementation((_root, _change, callback) => { onFrame = callback; return vi.fn() })
    render(<I18nProvider><OrchestrationV2Panel root="/repo" change="demo" /></I18nProvider>)
    expect(await screen.findByTestId('orchestration-v2-panel')).toBeVisible()
    expect(screen.getByTestId('orchestration-v2-revision')).toHaveTextContent('rev 3')
    expect(screen.getByText('Build API')).toBeVisible()
    await act(async () => { onFrame?.({ kind: 'snapshot', value: snapshot('completed', 2) }) })
    expect(screen.getByTestId('orchestration-v2-status')).toHaveTextContent('executing')
    await act(async () => { onFrame?.({ kind: 'snapshot', value: snapshot('completed', 4) }) })
    await waitFor(() => expect(screen.getByTestId('orchestration-v2-status')).toHaveTextContent('completed'))
  })

  it('keeps work-item detail collapsed until the user asks for it', async () => {
    vi.mocked(fetchOrchestrationV2Snapshot).mockResolvedValue(snapshot('executing'))
    render(<I18nProvider><OrchestrationV2Panel root="/repo" change="demo" /></I18nProvider>)
    await screen.findByTestId('orchestration-v2-panel')

    expect(screen.queryByRole('list', { name: '工作项状态' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('工作项状态 · 1'))
    const list = await screen.findByRole('list', { name: '工作项状态' })
    expect(list).toHaveTextContent('Build API')
    expect(list).toHaveTextContent('running')
  })

  it('resets expanded work-item detail when the selected change changes', async () => {
    vi.mocked(fetchOrchestrationV2Snapshot)
      .mockResolvedValueOnce(snapshot('executing'))
      .mockResolvedValueOnce(snapshot('completed'))
    const view = render(<I18nProvider><OrchestrationV2Panel root="/repo" change="demo" /></I18nProvider>)
    await screen.findByTestId('orchestration-v2-panel')
    await userEvent.click(screen.getByText('工作项状态 · 1'))
    await screen.findByRole('list', { name: '工作项状态' })

    view.rerender(<I18nProvider><OrchestrationV2Panel root="/repo" change="next" /></I18nProvider>)
    await waitFor(() => expect(screen.queryByRole('list', { name: '工作项状态' })).not.toBeInTheDocument())
  })

  it('sends a revision-checked pause command and hides controls when read-only', async () => {
    const current = snapshot('executing')
    vi.mocked(fetchOrchestrationV2Snapshot).mockResolvedValue(current)
    vi.mocked(postOrchestrationV2Control).mockResolvedValue(snapshot('paused', 4))
    render(<I18nProvider><OrchestrationV2Panel root="/repo" change="demo" /></I18nProvider>)
    await screen.findByTestId('orchestration-v2-panel')
    await userEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(postOrchestrationV2Control).toHaveBeenCalledWith('/repo', current, 'pause-change')
    render(<I18nProvider><OrchestrationV2Panel root="/repo" change="demo" readOnly /></I18nProvider>)
    await waitFor(() => expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument())
  })

  it('renders run, result, validation, gate and blocker projections without raw output', async () => {
    const current = snapshot('verifying')
    const item = { ...current.work_items[0]!, status: 'blocked' as const, blockers: ['missing-evidence'], depends_on: ['design'] }
    const rich: BoardSnapshotV2 = {
      ...current,
      pipeline: {
        schema_version: 'workflow-pipeline/v2', record_id: 'pipeline:demo', project_id: 'project-1', change_id: 'demo', revision: 3,
        correlation_id: 'corr-1', actor: { kind: 'system', id: 'planner' }, created_at: current.created_at,
        pipeline_id: 'enterprise:frontend:main', pipeline_version: '7', workflow_id: 'enterprise', workflow_version: '2', workflow_source: 'project', workflow_fingerprint: `sha256:${'b'.repeat(64)}`,
        track_id: 'frontend', track_revision: 'team-1', track_source: 'user', pipeline_source: 'project', graph_id: 'graph:demo', assessment_id: 'assessment:demo', status: 'frozen', stage_order: ['build'],
        stages: [{ stage_id: 'build', name: 'Build', ordinal: 0, execution_mode: 'serial', depends_on: [], work_item_ids: ['api'], gate: 'none', skills: [{ binding_id: 'binding:api:api', skill_id: 'api', skill_version: '1.0.0', order: 0, role: 'workflow', source: 'project', mode: 'serial', depends_on: [], mcp_ids: [], validator_ids: [] }], input_refs: [], output_refs: [] }],
        customizations: { custom_workflow: true, custom_track: true, custom_pipeline: true, user_skill_ids: [], user_mcp_ids: [] }, pipeline_digest: `sha256:${'c'.repeat(64)}`,
      },
      work_items: [item],
      runs: [{ schema_version: 'skill-run/v2', record_id: 'run:1', project_id: 'project-1', change_id: 'demo', revision: 3, correlation_id: 'corr-1', actor: { kind: 'worker', id: 'w' }, created_at: current.created_at, run_id: 'run-1', attempt_id: 'attempt-1', attempt: 1, work_item_id: 'api', skill_id: 'api', skill_version: '1.0.0', mcp_ids: ['github'], status: 'completed', input_refs: [], result_id: 'result-1' }],
      results: [{ schema_version: 'skill-result/v2', record_id: 'result:1', project_id: 'project-1', change_id: 'demo', revision: 3, correlation_id: 'corr-1', actor: { kind: 'worker', id: 'w' }, created_at: current.created_at, result_id: 'result-1', run_id: 'run-1', status: 'completed', contract_status: 'validated', output_schema_id: 'api/output-v1', artifacts: [{ id: 'artifact-1', kind: 'json', ref: 'artifact://safe', digest: `sha256:${'a'.repeat(64)}` }], validation_refs: ['report-1'], diagnostics: [] }],
      validations: [{ schema_version: 'validation-report/v2', record_id: 'validation:1', project_id: 'project-1', change_id: 'demo', revision: 3, correlation_id: 'corr-1', actor: { kind: 'system', id: 'validator' }, created_at: current.created_at, report_id: 'report-1', work_item_id: 'api', result_id: 'result-1', validator_id: 'unit', validator_version: '1', status: 'pass', target_digests: [], evidence_refs: ['evidence:1'], checks: [] }],
      gates: [{ schema_version: 'gate-evaluation/v2', record_id: 'gate:1', project_id: 'project-1', change_id: 'demo', revision: 3, correlation_id: 'corr-1', actor: { kind: 'user', id: 'u' }, created_at: current.created_at, gate_id: 'gate-1', kind: 'verification', status: 'pending', required_evidence_refs: [], decision_revision: 3 }],
      blockers: ['missing-evidence'], next_actions: ['bind-artifact'],
    }
    vi.mocked(fetchOrchestrationV2Snapshot).mockResolvedValue(rich)
    render(<I18nProvider><OrchestrationV2Panel root="/repo" change="demo" /></I18nProvider>)
    await screen.findByTestId('orchestration-v2-panel')
    expect(screen.getByTestId('orchestration-v2-pipeline')).toHaveTextContent('enterprise@2')
    expect(screen.getByTestId('orchestration-v2-pipeline')).toHaveTextContent('frontend')
    expect(screen.getByTestId('orchestration-v2-pipeline')).toHaveTextContent('Build')
    expect(screen.getByTestId('orchestration-v2-pipeline')).toHaveTextContent('api@1.0.0')
    expect(screen.getByRole('region', { name: '运行与租约', hidden: true })).toHaveTextContent('api@1.0.0')
    expect(screen.getByRole('region', { name: '产出与验证', hidden: true })).toHaveTextContent('artifact://safe')
    expect(screen.getByRole('region', { name: '验证报告', hidden: true })).toHaveTextContent('unit@1')
    expect(screen.getByRole('region', { name: '门禁', hidden: true })).toHaveTextContent('pending')
    expect(screen.getByRole('region', { name: '阻塞原因' })).toHaveTextContent('missing-evidence')
    expect(screen.queryByText('raw_output')).not.toBeInTheDocument()
  })
})
