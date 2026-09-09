import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AdapterInstallWizard } from './AdapterInstallWizard'
import { I18nProvider } from '../i18n'
import type { DefinitionCatalogAdapter } from '../api/client'

function adapter(overrides: Partial<DefinitionCatalogAdapter> & { id: string }): DefinitionCatalogAdapter {
  return {
    label: overrides.id,
    kind: 'adapter',
    tier: 'B',
    cli_flag: `--${overrides.id}`,
    target_scope: 'project',
    capabilities: { inject: 'native', veto: 'native', track: 'native' },
    veto_fail_closed: false,
    supported_operations: ['setup', 'update'],
    state: 'unknown',
    ...overrides,
  }
}

const CATALOG = {
  schema_version: 'definition-catalog/v1',
  revision: 'r1',
  fingerprint: 'f1',
  generated_at: '2026-09-08T00:00:00.000Z',
  project: { root: '/repo', identity: 'p1' },
  adapters: [
    // codex：全原生，作为对照组——降级的呈现必须与它可见地不同。
    adapter({ id: 'codex', kind: 'native', tier: 'A', target_scope: 'user', state: 'detected' }),
    // cursor：inject 降级 + veto 原生且 fail-closed（registry 里唯一的硬拦承诺）。
    adapter({ id: 'cursor', capabilities: { inject: 'degraded', veto: 'native', track: 'native' }, veto_fail_closed: true }),
    // zed：三项全降级，tier C。
    adapter({ id: 'zed', tier: 'C', capabilities: { inject: 'degraded', veto: 'degraded', track: 'degraded' } }),
  ],
  workflows: [],
  tracks: [],
  pipelines: [],
}

function renderWizard(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => CATALOG }))
  render(<I18nProvider><AdapterInstallWizard root="/repo" /></I18nProvider>)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('adapter installer capability disclosure', () => {
  it('renders every capability grade per host and marks degraded differently from native beyond colour', async () => {
    renderWizard()
    const native = await screen.findByTestId('adapter-capabilities-codex')
    const degraded = screen.getByTestId('adapter-capabilities-cursor')

    const nativeInject = native.querySelector('[data-testid="adapter-capability-inject"]')
    const degradedInject = degraded.querySelector('[data-testid="adapter-capability-inject"]')
    expect(nativeInject?.getAttribute('data-capability-status')).toBe('native')
    expect(degradedInject?.getAttribute('data-capability-status')).toBe('degraded')
    // 同一能力、不同档位 → 不同 veto 也得能读出来（cursor 的 veto 是原生的）。
    expect(degraded.querySelector('[data-testid="adapter-capability-veto"]')?.getAttribute('data-capability-status')).toBe('native')

    // 视觉区分不能只靠颜色：形状（圆角 vs 胶囊）、边框样式（实线 vs 虚线）和字形标记都必须不同，
    // 否则灰度截图、色盲和高对比模式下三态会塌缩成同一片灰。
    const nativeClass = nativeInject?.className ?? ''
    const degradedClass = degradedInject?.className ?? ''
    expect(nativeClass).toContain('rounded-full')
    expect(nativeClass).toContain('border-solid')
    expect(degradedClass).toContain('rounded-sm')
    expect(degradedClass).toContain('border-dashed')
    expect(nativeInject?.textContent).not.toBe(degradedInject?.textContent)
    expect(nativeInject?.querySelector('[aria-hidden="true"]')?.textContent)
      .not.toBe(degradedInject?.querySelector('[aria-hidden="true"]')?.textContent)
  })

  it('explains on screen what a degraded capability costs, and says nothing extra for a fully native host', async () => {
    renderWizard()
    await screen.findByTestId('adapter-capabilities-codex')
    // 说明与徽章同屏，不是 tooltip-only：触屏和键盘用户也要能读到「降级意味着什么」。
    expect(screen.getByTestId('adapter-capability-note-cursor-inject').textContent).not.toBe('')
    expect(screen.queryByTestId('adapter-capability-note-cursor-veto')).toBeNull()
    expect(screen.getByTestId('adapter-capability-note-zed-veto').textContent).not.toBe('')
    for (const capability of ['inject', 'veto', 'track']) {
      expect(screen.queryByTestId(`adapter-capability-note-codex-${capability}`)).toBeNull()
    }
  })

  it('surfaces the veto fail-closed promise and marks fail-open hosts as the weaker default', async () => {
    renderWizard()
    await screen.findByTestId('adapter-capabilities-codex')
    expect(screen.getByTestId('adapter-veto-fail-mode-cursor').getAttribute('data-veto-fail-closed')).toBe('true')
    expect(screen.getByTestId('adapter-veto-fail-mode-codex').getAttribute('data-veto-fail-closed')).toBe('false')
    expect(screen.getByTestId('adapter-veto-fail-mode-cursor').textContent)
      .not.toBe(screen.getByTestId('adapter-veto-fail-mode-codex').textContent)
  })

  it('ships a legend so a badge is readable without hovering it', async () => {
    renderWizard()
    await waitFor(() => expect(screen.getByTestId('adapter-capability-legend')).toBeInTheDocument())
    for (const status of ['native', 'degraded', 'none']) {
      expect(screen.getByTestId(`adapter-capability-legend-${status}`)).toBeInTheDocument()
    }
  })

  it('never claims a capability the catalog did not report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...CATALOG,
        adapters: [adapter({ id: 'ghost', capabilities: { inject: 'none', veto: 'none', track: 'none' } })],
      }),
    }))
    render(<I18nProvider><AdapterInstallWizard root="/repo" /></I18nProvider>)
    const badges = await screen.findByTestId('adapter-capabilities-ghost')
    for (const capability of ['inject', 'veto', 'track']) {
      expect(badges.querySelector(`[data-testid="adapter-capability-${capability}"]`)?.getAttribute('data-capability-status')).toBe('none')
    }
    // veto 不存在时不能再谈 fail-closed / fail-open：那是关于「有拦截」的承诺。
    expect(screen.queryByTestId('adapter-veto-fail-mode-ghost')).toBeNull()
  })
})
