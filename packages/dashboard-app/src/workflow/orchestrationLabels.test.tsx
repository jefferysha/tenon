import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlowStage } from '../api/workflowOrchestrationClient'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '../i18n'
import { builtinStepLabel, builtinDirectionLabel } from '../i18n/builtinLabels'
import { translations, type Dict, type Lang } from '../i18n/translations'
import { OrchestrationFlow } from './OrchestrationFlow'
import { localizeStages } from './orchestrationLabels'

vi.mock('@xyflow/react', () => import('./reactFlowTestDouble'))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const entry = (kind: 'skill' | 'test' | 'reviewer', id: string, label: string, extra: Partial<FlowStage['entries'][number]> = {}): FlowStage['entries'][number] =>
  ({ kind, id, label, wave: 0, dependsOn: [], required: true, source: 'declared' as const, ...extra })

const STAGES: FlowStage[] = [
  { id: 'open', label: '立项', gate: null, entries: [entry('skill', 'openspec-propose', 'openspec-propose')] },
  { id: 'verify', label: '验证', gate: 'review', entries: [entry('test', 'code-size', '代码规模'), entry('test', 'unit', '单元测试（自改）'), entry('test', 'kind:unit', 'unit', { testKind: 'unit' })] },
  { id: 'build', label: '开发', gate: null, entries: [] },
]

function tFor(lang: Lang): (key: string) => string {
  return (key) => {
    let node: string | Dict | undefined = translations[lang]
    for (const part of key.split('.')) {
      if (node === undefined || typeof node === 'string') return key
      node = node[part]
    }
    return typeof node === 'string' ? node : key
  }
}

function labels(lang: Lang) {
  return {
    step: (workflow: string | null | undefined, step: string, label: string) => builtinStepLabel(tFor(lang), workflow, step, label),
    track: (_workflow: string | null | undefined, _track: string, label: string) => label,
    direction: (direction: string, label: string) => builtinDirectionLabel(tFor(lang), direction, label),
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('localizeStages · 画布上的内置名字', () => {
  it('英文：出厂阶段名、出厂测试项名换英文；改过的阶段名 / 测试项名、按种类画的测试节点原样', () => {
    const shown = localizeStages(STAGES, 'default', labels('en'))
    expect(shown.map((stage) => stage.label)).toEqual(['Open', 'Verify', '开发'])
    expect(shown[1]?.entries.map((item) => item.label)).toEqual(['Code size', '单元测试（自改）', 'unit'])
    // 只换 label：id、顺序、状态不动。
    expect(shown.map((stage) => stage.id)).toEqual(['open', 'verify', 'build'])
    expect(shown[1]?.entries.map((item) => item.id)).toEqual(['code-size', 'unit', 'kind:unit'])
  })

  it('中文：返回原数组（没有任何名字要换，布局不重算）', () => {
    expect(localizeStages(STAGES, 'default', labels('zh'))).toBe(STAGES)
  })

  it('自建工作流：阶段名不翻译（测试项名按方向 id 匹配，与工作流无关）', () => {
    const shown = localizeStages(STAGES, 'mine', labels('en'))
    expect(shown.map((stage) => stage.label)).toEqual(['立项', '验证', '开发'])
    expect(shown[1]?.entries[0]?.label).toBe('Code size')
    expect(localizeStages(STAGES, null, labels('en'))[0]?.label).toBe('立项')
  })
})

describe('OrchestrationFlow · 英文界面', () => {
  function renderFlow(workflow: string | null, mode: 'overview' | 'stage' = 'overview', stages: FlowStage[] = STAGES) {
    return render(
      <I18nProvider>
        <TooltipProvider>
          <OrchestrationFlow mode={mode} workflow={workflow} stages={stages} ariaLabel="overview" />
        </TooltipProvider>
      </I18nProvider>,
    )
  }

  it('总览列头与出厂测试项节点显示英文；编辑过的名字原样', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    renderFlow('default')
    expect(screen.getByTestId('orch-stage-open')).toHaveTextContent('Open')
    expect(screen.getByTestId('orch-stage-verify')).toHaveTextContent('Verify')
    expect(screen.getByTestId('orch-stage-build')).toHaveTextContent('开发')
    expect(screen.getByTestId('orch-node-test-code-size')).toHaveTextContent('Code size')
    expect(screen.getByTestId('orch-node-test-unit')).toHaveTextContent('单元测试（自改）')
  })

  it('中文界面：出厂名不变', () => {
    renderFlow('default')
    expect(screen.getByTestId('orch-stage-open')).toHaveTextContent('立项')
    expect(screen.getByTestId('orch-node-test-code-size')).toHaveTextContent('代码规模')
  })

  it('阶段画布（单列）里出厂测试项名同样换英文', () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    renderFlow('default', 'stage', [STAGES[1] as FlowStage])
    expect(screen.getByTestId('orch-node-test-code-size')).toHaveTextContent('Code size')
  })
})
