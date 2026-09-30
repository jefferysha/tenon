import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import type { ChangeSnapshot } from '../types'
import { TaskDetailPane } from './TaskDetailPane'
import { stagesOf, type TaskRow } from './taskModel'
import {
  FIXTURE_RUN, FIXTURE_USER, planBrief, recordDetail, recordList, verifyReport,
} from '../api/testSystemFixtures'

vi.mock('@xyflow/react', () => import('../workflow/reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

function change(over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  return {
    name: 'add-login',
    path: '/repo/openspec/changes/add-login',
    phase: 'verify',
    phase_status: 'pending',
    track: 'frontend',
    preset: 'full',
    archived: 'false',
    updated_at: '2026-09-10T00:00:00Z',
    workflowPlanFingerprint: 'f'.repeat(64),
    workflowRules: {
      executionModel: 'step-graph',
      steps: ['build', 'verify'],
      transitions: { verify: [{ event: 'verify-pass', to: 'ship' }] },
      gateByStep: { verify: 'review' },
      labelByStep: {},
      outputsByStep: { verify: [] },
    },
    workflowExecution: { readinessByTransition: {} },
    owner: null,
    creator: null,
    fields: { workflow: 'default' },
    ...over,
  } as unknown as ChangeSnapshot
}

function row(snapshot: ChangeSnapshot): TaskRow {
  return {
    key: `/repo ${snapshot.name}`, root: '/repo', change: snapshot, rules: snapshot.workflowRules, workflow: 'default',
    archived: false, owner: null, stages: stagesOf(snapshot, undefined, (key: string) => key), summary: { kind: 'running' },
  }
}

function mount(snapshot: ChangeSnapshot) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('/api/tests/record?')) return new Response(JSON.stringify({ ok: true, record: recordDetail() }), { status: 200 })
    if (url.startsWith('/api/tests/records?')) return new Response(JSON.stringify({ ok: true, limit: 50, ...recordList() }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
  render(
    <I18nProvider>
      <TooltipProvider>
        <TaskDetailPane row={row(snapshot)} fetchDefinition={false} />
      </TooltipProvider>
    </I18nProvider>,
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('TaskDetailPane · 测试页签（策略判定）', () => {
  const withPolicy = (): ChangeSnapshot => change({ testPolicy: [verifyReport()], testPlan: planBrief(), testUser: FIXTURE_USER })

  it('所选阶段有策略判定：页签出现，计数是 满足的种类/要求的种类；点开是新的页签内容，不是旧表', async () => {
    mount(withPolicy())
    const tab = screen.getByTestId('task-io-tab-tests')
    expect(tab.textContent).toContain('测试')
    expect(tab.textContent).toContain('1/4')
    await userEvent.click(tab)
    expect(screen.getByTestId('task-tests')).toBeInTheDocument()
    expect(screen.queryByTestId('stage-tests-head')).toBeNull()
    expect(screen.getByTestId('tests-stat-suite').textContent).toBe('3套件')
  })

  it('点套件名打开运行详情：目标用户是快照里的 testUser，运行 id 来自判定；再点同一处关闭抽屉后可再开', async () => {
    const calls = mount(withPolicy())
    await userEvent.click(screen.getByTestId('task-io-tab-tests'))
    await userEvent.click(screen.getByTestId('tests-suite-web-e2e'))
    expect(await screen.findByTestId('suite-run-drawer')).toBeInTheDocument()
    await waitFor(() => expect(calls.some((url) => url.startsWith('/api/tests/record?') && url.includes(`user=${FIXTURE_USER}`) && url.includes(`run=${FIXTURE_RUN}`))).toBe(true))
    await screen.findByTestId('run-body')
    expect(within(screen.getByTestId('suite-run-drawer')).getByTitle('web-e2e')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('suite-run-drawer-close'))
    await waitFor(() => expect(screen.queryByTestId('suite-run-drawer')).toBeNull())
  })

  it('过期的套件：抽屉带失效原因（判定里的绑定）', async () => {
    mount(withPolicy())
    await userEvent.click(screen.getByTestId('task-io-tab-tests'))
    await userEvent.click(screen.getByTestId('tests-suite-web-e2e'))
    await screen.findByTestId('run-body')
    expect(screen.getByTestId('run-stale-candidate')).toBeInTheDocument()
    expect(screen.getByTestId('run-stale-plan')).toBeInTheDocument()
  })

  it('切换阶段后关闭已打开的运行详情，且没有判定的阶段不再有页签', async () => {
    mount(withPolicy())
    await userEvent.click(screen.getByTestId('task-io-tab-tests'))
    await userEvent.click(screen.getByTestId('tests-suite-web-unit'))
    expect(await screen.findByTestId('suite-run-drawer')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('suite-run-drawer')).toBeNull())
    await userEvent.click(screen.getByTestId('stage-rail-build'))
    expect(screen.queryByTestId('task-io-tab-tests')).toBeNull()
    expect(screen.queryByTestId('task-tests')).toBeNull()
  })

  it('只有旧步骤测试（没有策略判定）：沿用旧的行表', async () => {
    mount(change({
      tests: [{ stepId: 'verify', items: [{ id: 'unit', label: '单测', direction: 'unit', required: true, status: 'passed' }] }],
    }))
    await userEvent.click(screen.getByTestId('task-io-tab-tests'))
    expect(screen.getByTestId('stage-tests-head')).toBeInTheDocument()
    expect(screen.queryByTestId('task-tests')).toBeNull()
    expect(screen.getByTestId('task-io-tab-tests').textContent).toContain('1/1')
  })

  it('既没有策略判定也没有旧测试：没有测试页签', () => {
    mount(change())
    expect(screen.queryByTestId('task-io-tab-tests')).toBeNull()
  })
})
