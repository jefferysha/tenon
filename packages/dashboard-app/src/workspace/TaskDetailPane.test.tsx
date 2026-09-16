import { cleanup, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChangeSnapshot } from '../types'
import { I18nProvider } from '../i18n'
import { StageIoPanel } from './StageIoPanel'
import type { IoRow } from './stageIo'
import { stagesOf, type TaskRow } from './taskModel'
import { TaskDetailPane } from './TaskDetailPane'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const STEPS = ['spec', 'build', 'verify']

function change(over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  return {
    name: 'demo',
    path: '/repo/openspec/changes/demo',
    phase: 'build',
    phase_status: 'pending',
    track: 'backend',
    preset: 'full',
    archived: 'false',
    updated_at: '2026-09-10T00:00:00Z',
    workflowPlanFingerprint: 'f'.repeat(64),
    workflowRules: {
      executionModel: 'step-graph',
      steps: STEPS,
      transitions: { build: [{ event: 'build-complete', to: 'verify' }] },
      gateByStep: { build: 'review' },
      labelByStep: {},
      outputsByStep: { build: ['build_sha', 'plan'] },
    },
    workflowExecution: { readinessByTransition: {} },
    ...over,
    fields: { workflow: 'mine', build_sha: 'sha', plan: '', ...(over.fields ?? {}) },
  } as unknown as ChangeSnapshot
}

function row(snapshot: ChangeSnapshot): TaskRow {
  return {
    key: `/repo ${snapshot.name}`,
    root: '/repo',
    change: snapshot,
    rules: snapshot.workflowRules,
    workflow: 'mine',
    archived: false,
    stages: stagesOf(snapshot, undefined, (key: string) => key),
    summary: { kind: 'running' },
  }
}

/** 聚合语境（fetchDefinition=false）：IO 退化为快照里的输出字段，不发任何请求。 */
function renderPane(snapshot: ChangeSnapshot): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no request expected')))
  vi.stubGlobal('fetch', fetchSpy)
  render(<I18nProvider><TaskDetailPane row={row(snapshot)} fetchDefinition={false} /></I18nProvider>)
  return fetchSpy
}

describe('TaskDetailPane · 门禁行与输出计数', () => {
  it('输出页签显示 已齐/总数；门禁行显示 评审 · k/n（输出 + 一条人工确认）；不再请求运行时产物', () => {
    const fetchSpy = renderPane(change())
    expect(within(screen.getByTestId('task-io-tab-outputs')).getByText('1/2')).toBeInTheDocument()
    expect(screen.getByTestId('task-io-tab-inputs')).toHaveTextContent('0')
    expect(screen.getByTestId('task-gate-row')).toHaveTextContent('评审')
    expect(screen.getByTestId('task-gate-row')).toHaveTextContent('1/3')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.queryByTestId('runtime-artifacts')).toBeNull()
  })

  it('人工确认已批准时门禁计数 +1', () => {
    renderPane(change({ reviewHandshake: { status: 'approved', event: 'build-complete', requestedAt: 'a', acknowledgedAt: 'b' } }))
    expect(screen.getByTestId('task-gate-row')).toHaveTextContent('2/3')
  })

  it('阶段没有任何输入输出：整块 IO 不渲染，也没有门禁行', () => {
    const snapshot = change({
      workflowRules: { ...change().workflowRules, gateByStep: {}, outputsByStep: {} },
    })
    renderPane(snapshot)
    expect(screen.queryByTestId('stage-io')).toBeNull()
    expect(screen.queryByTestId('task-gate-row')).toBeNull()
  })
})

describe('StageIoPanel · 过期原因与缺失技能', () => {
  const documentRow = (over: Partial<IoRow>): IoRow => ({
    slot: { kind: 'document', id: 'proposal', role: 'produce', scope: 'change', producers: ['openspec-propose'], consumers: [] },
    status: 'stale',
    path: 'openspec/changes/demo/proposal.md',
    value: 'openspec/changes/demo/proposal.md',
    producer: 'openspec-propose',
    at: null,
    reason: 'changed',
    producers: ['openspec-propose'],
    ...over,
  })

  it('过期行的状态徽标带原因一词与 data-reason；缺失行显示应产出的技能', () => {
    render(<I18nProvider>
      <StageIoPanel
        direction="outputs"
        items={[documentRow({}), documentRow({ slot: { kind: 'document', id: 'tasks', role: 'produce', scope: 'change', producers: ['openspec-propose'], consumers: [] }, status: 'missing', path: null, value: '', producer: null, reason: null })]}
        activePath={null}
        definitionState="ready"
        onOpen={() => undefined}
      />
    </I18nProvider>)
    const stale = screen.getByTestId('stage-output-document-proposal')
    expect(stale).toHaveAttribute('data-status', 'stale')
    expect(within(stale).getByTitle('内容已变')).toHaveAttribute('data-reason', 'changed')
    expect(screen.getByTestId('stage-output-document-tasks')).toHaveTextContent('openspec-propose')
    cleanup()
  })
})
