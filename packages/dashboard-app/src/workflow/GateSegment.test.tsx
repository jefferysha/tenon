import { act, cleanup, render, screen } from '@testing-library/react'
import { Flip } from 'gsap/Flip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WbStepDef } from '../api/governanceTypes'
import { I18nProvider } from '../i18n'
import { SLIDING_INDICATOR_CLS } from '../shared/useSlidingIndicator'
import { GateSegment } from './GateSegment'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function ui(value: WbStepDef['gate']): JSX.Element {
  return (
    <I18nProvider>
      <TooltipProvider>
        <GateSegment stepId="explore" value={value} disabled={false} onChange={() => undefined} />
      </TooltipProvider>
    </I18nProvider>
  )
}

describe('GateSegment 滑块', () => {
  it('用共享滑动指示块（白滑块），换值时 Flip 0.18s 滑过去', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
    const from = vi.spyOn(Flip, 'from')
    const { rerender } = render(ui('review'))
    const indicator = screen.getByTestId('wb-lane-gate-explore-indicator')
    expect(indicator.className.split(' ')).toEqual(expect.arrayContaining([...SLIDING_INDICATOR_CLS.split(' '), 'bg-card', 'shadow-sm']))
    expect(indicator).toHaveAttribute('data-placed', 'true')
    expect(document.querySelectorAll('[data-segment-thumb]')).toHaveLength(0)
    rerender(ui('auto'))
    await act(async () => { await Promise.resolve() })
    expect(from).toHaveBeenCalledTimes(1)
    expect(from.mock.calls[0]?.[1]).toMatchObject({ duration: 0.18, ease: 'power3.out' })
  })
})
