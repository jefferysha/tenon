import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { useT } from '../../i18n'
import { fetchTestArtifactText } from '../../api/testEvidenceClient'
import { formatApiError } from '../../api/transport'
import { TestSection } from '../../tests/TestSection'
import { COUNT_BADGE } from '../../tests/testStyles'
import { BUTTON_GHOST } from '../../shared/uiRecipes'
import type { SuiteRun } from '../../api/testSystemTypes'
import { runHref, type RunContext } from './runContext'

export const LOG_TAIL_BYTES = 262_144

type Tail =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly text: string }
  | { readonly status: 'error'; readonly error: unknown }

/** 日志：按需读取尾部（最后 256 KiB），完整日志走下载；日志超上限被截断时标一个词。 */
export function RunLogSection({ run, ctx }: { run: SuiteRun; ctx: RunContext }): JSX.Element {
  const { t } = useT()
  const [tail, setTail] = useState<Tail>({ status: 'idle' })
  const log = run.log
  useEffect(() => { setTail({ status: 'idle' }) }, [ctx.runId, run.suite])
  function load(): void {
    setTail({ status: 'loading' })
    fetchTestArtifactText(runHref(ctx, log.artifact, LOG_TAIL_BYTES)).then(
      (text) => setTail({ status: 'ready', text }),
      (error: unknown) => setTail({ status: 'error', error }),
    )
  }
  return (
    <TestSection
      title={t('tests.run.section.log')}
      testId="run-log"
      action={(
        <>
          {log.truncated && <span className={COUNT_BADGE} title={t('tests.run.log.truncated_hint')} data-testid="run-log-truncated">{t('tests.run.log.truncated')}</span>}
          <button type="button" className={BUTTON_GHOST} disabled={!log.present || tail.status === 'loading'} data-testid="run-log-tail" onClick={load}>{t('tests.run.log.tail')}</button>
          {log.present
            ? (
              <a className={`${BUTTON_GHOST} no-underline`} href={runHref(ctx, log.artifact)} download data-testid="run-log-full">
                <Download className="size-4" aria-hidden="true" />{t('tests.run.log.full')}
              </a>
            )
            : <span className="whitespace-nowrap text-caption text-text-3" data-testid="run-log-absent">—</span>}
        </>
      )}
    >
      {tail.status === 'error' && <p className="truncate whitespace-nowrap text-body text-red-d" role="alert" data-testid="run-log-error">{formatApiError(tail.error, t)}</p>}
      {tail.status === 'ready' && (
        <pre className="max-h-64 overflow-auto whitespace-pre rounded-sm border border-border bg-(--code-bg) p-3 font-mono text-caption text-text-2" data-testid="run-log-text">{tail.text}</pre>
      )}
    </TestSection>
  )
}
