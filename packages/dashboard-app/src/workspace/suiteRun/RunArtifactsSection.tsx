import { FileText, Download } from 'lucide-react'
import { useT } from '../../i18n'
import { FixCommand } from '../../tests/FixCommand'
import { TestSection } from '../../tests/TestSection'
import { formatBytes } from '../../tests/testFormat'
import { COUNT_BADGE } from '../../tests/testStyles'
import type { RunArtifact, SuiteRun } from '../../api/testSystemTypes'
import { runHref, showTraceCommand, type RunContext } from './runContext'

const OTHER_CAP = 50

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

function DownloadLink({ ctx, artifact, testId }: { ctx: RunContext; artifact: RunArtifact; testId: string }): JSX.Element {
  const { t } = useT()
  return (
    <a
      className="inline-flex flex-none items-center gap-1 whitespace-nowrap text-caption text-(--accent) underline"
      href={runHref(ctx, artifact.path)}
      download
      aria-label={`${t('tests.run.artifact.download')} ${nameOf(artifact.path)}`}
      data-testid={testId}
    >
      <Download className="size-3.5" aria-hidden="true" />
      {t('tests.run.artifact.download')}
    </a>
  )
}

function Group({ title, count, testId, children }: { title: string; count: number; testId: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid gap-2" data-testid={testId}>
      <div className="flex items-center gap-2 whitespace-nowrap text-caption text-text-3">
        <span>{title}</span>
        <span className={COUNT_BADGE}>{count}</span>
      </div>
      {children}
    </div>
  )
}

/** 产物：截图网格（点开放大）、视频、trace（下载 + 复制 show-trace 命令）、HTML 报告（只下载，不渲染）、其它文件。 */
export function RunArtifactsSection({ run, ctx, onZoom }: { run: SuiteRun; ctx: RunContext; onZoom: (path: string) => void }): JSX.Element | null {
  const { t } = useT()
  const present = run.artifacts.filter((artifact) => artifact.present)
  if (present.length === 0) return null
  const images = present.filter((artifact) => artifact.media === 'image')
  const videos = present.filter((artifact) => artifact.media === 'video')
  const traces = present.filter((artifact) => artifact.media === 'trace')
  const reports = present.filter((artifact) => artifact.media === 'html').sort((left, right) => Number(right.entry) - Number(left.entry))
  const others = present.filter((artifact) => !['image', 'video', 'trace', 'html'].includes(artifact.media))
  return (
    <TestSection
      title={t('tests.run.section.artifacts')}
      count={present.length}
      testId="run-artifacts"
      action={run.artifactsTruncated ? <span className={COUNT_BADGE} title={t('tests.run.artifact.truncated')} data-testid="run-artifacts-truncated">{run.artifacts.length}+</span> : undefined}
    >
      {images.length > 0 && (
        <Group title={t('tests.run.artifact.screenshots')} count={images.length} testId="run-screenshots">
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
            {images.map((artifact) => (
              <li key={artifact.path} className="min-w-0">
                <button
                  type="button"
                  className="grid w-full min-w-0 gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                  aria-label={`${t('tests.run.artifact.zoom')} ${nameOf(artifact.path)}`}
                  title={artifact.path}
                  data-testid="run-screenshot"
                  onClick={() => onZoom(artifact.path)}
                >
                  <img src={runHref(ctx, artifact.path)} alt={nameOf(artifact.path)} loading="lazy" className="aspect-video w-full rounded-sm border border-border object-cover" />
                  <span className="truncate whitespace-nowrap font-mono text-caption text-text-2">{nameOf(artifact.path)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Group>
      )}
      {videos.length > 0 && (
        <Group title={t('tests.run.artifact.videos')} count={videos.length} testId="run-videos">
          <ul className="grid gap-3">
            {videos.map((artifact) => (
              <li key={artifact.path} className="grid min-w-0 gap-1">
                <video controls preload="none" src={runHref(ctx, artifact.path)} aria-label={nameOf(artifact.path)} className="max-h-64 w-full rounded-sm border border-border bg-(--code-bg)" data-testid="run-video" />
                <span className="truncate whitespace-nowrap font-mono text-caption text-text-2" title={artifact.path}>{nameOf(artifact.path)}</span>
              </li>
            ))}
          </ul>
        </Group>
      )}
      {traces.length > 0 && (
        <Group title={t('tests.run.artifact.traces')} count={traces.length} testId="run-traces">
          <ul>
            {traces.map((artifact, index) => (
              <li key={artifact.path} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)] items-center gap-3 border-b border-border py-1 whitespace-nowrap last:border-0" data-testid="run-trace">
                <span className="truncate font-mono text-body text-text" title={artifact.path}>{nameOf(artifact.path)}</span>
                <DownloadLink ctx={ctx} artifact={artifact} testId={`run-trace-download-${index}`} />
                <FixCommand command={showTraceCommand(ctx, artifact.path)} testId={`run-trace-command-${index}`} />
              </li>
            ))}
          </ul>
        </Group>
      )}
      {reports.length > 0 && (
        <Group title={t('tests.run.artifact.reports')} count={reports.length} testId="run-reports">
          <ul>
            {reports.map((artifact, index) => (
              <li key={artifact.path} className="grid min-h-10 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-border py-1 whitespace-nowrap last:border-0" data-testid="run-report" data-entry={artifact.entry}>
                <FileText className="size-4 text-text-3" aria-hidden="true" />
                <span className="truncate font-mono text-body text-text" title={artifact.path}>{artifact.entry ? `${nameOf(artifact.path)} · ${t('tests.run.artifact.entry')}` : nameOf(artifact.path)}</span>
                <DownloadLink ctx={ctx} artifact={artifact} testId={`run-report-download-${index}`} />
              </li>
            ))}
          </ul>
        </Group>
      )}
      {others.length > 0 && (
        <Group title={t('tests.run.artifact.files')} count={others.length} testId="run-files">
          <ul>
            {others.slice(0, OTHER_CAP).map((artifact, index) => (
              <li key={artifact.path} className="grid min-h-9 grid-cols-[minmax(0,1fr)_5rem_auto] items-center gap-3 border-b border-border py-1 whitespace-nowrap last:border-0" data-testid="run-file">
                <span className="truncate font-mono text-body text-text" title={artifact.path}>{artifact.path}</span>
                <span className="font-mono text-caption text-text-3">{formatBytes(artifact.bytes)}</span>
                <DownloadLink ctx={ctx} artifact={artifact} testId={`run-file-download-${index}`} />
              </li>
            ))}
          </ul>
          {others.length > OTHER_CAP && <span className={COUNT_BADGE} data-testid="run-files-more">+{others.length - OTHER_CAP}</span>}
        </Group>
      )}
    </TestSection>
  )
}
