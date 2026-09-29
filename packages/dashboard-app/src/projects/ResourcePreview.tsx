import type { ReactNode } from 'react'
import { resourceEntryLines } from '@tenon/kernel/resources/frontend-selection'
import { licenseModes } from '@tenon/kernel/resources/query'
import { useT } from '../i18n'
import { RESOURCE_LINK_KEYS, type ResourceEntry } from '../api/resourceTypes'
import { BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'

export interface ResourcePreviewProps {
  entry: ResourceEntry
  added: boolean
  /** 能否加入（已有相容的前端框架）；已加入的条目总能移除。 */
  allowed: boolean
  onToggle: () => void
}

function Row({ label, testId, children }: { label: string; testId?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-3 text-caption whitespace-nowrap" data-testid={testId}>
      <span className="truncate text-text-3" title={label}>{label}</span>
      <span className="flex min-w-0 items-baseline gap-2 text-text">{children}</span>
    </div>
  )
}

/** 外链只认 https（目录校验同一条规则），其余按纯文本。 */
function Link({ href, text = href, testId }: { href: string; text?: string; testId?: string }): JSX.Element {
  if (!href.startsWith('https://')) return <span className="min-w-0 truncate" title={href}>{text}</span>
  return (
    <a
      className="min-w-0 truncate rounded-xs text-(--accent) underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-(--accent)"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      data-testid={testId}
    >
      {text}
    </a>
  )
}

/** 将要写进项目的文本块：单行不折行，过长横向滚动。 */
function WriteBlock({ lines, testId }: { lines: readonly string[]; testId: string }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-sm bg-fill px-3 py-2 font-mono text-caption whitespace-nowrap text-text" data-testid={testId}>
      <div className="w-max min-w-full">{lines.map((line) => <div key={line}>{line}</div>)}</div>
    </div>
  )
}

/**
 * 资源预览（与模板预览同构）：头部 名称 + 加入 / 移除；正文 说明 · 框架 · 许可 · 链接 · 将写入项目的内容。
 * 组件库 / 图标写进前端模板的指令文件，DESIGN.md 在创建时取到项目根。
 */
export function ResourcePreview({ entry, added, allowed, onToggle }: ResourcePreviewProps): JSX.Element {
  const { t } = useT()
  const designMd = entry.category === 'design-md'
  const modes = licenseModes(entry).map((mode) => t(`resources.license_mode.${mode.replace(/-/gu, '_')}`)).join(' · ')
  const links = RESOURCE_LINK_KEYS.filter((key) => key !== 'design_md' && entry.links[key] !== undefined)
  const seed = entry.links.design_md
  const frameworks = entry.frameworks.length === 0 ? t('resources.any') : entry.frameworks.join(' ')
  return (
    <div className="flex min-h-0 flex-col rounded-md border border-border bg-card" data-testid="np-res-preview">
      <div className="flex min-h-12 flex-none items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-text" title={entry.name} data-testid="np-res-preview-name">{entry.name}</span>
        <span title={allowed || added ? undefined : t('projects.template_needs_frontend')}>
          <button
            type="button"
            className={added ? BUTTON_GHOST : BUTTON_SOLID}
            disabled={!allowed && !added}
            data-testid="np-res-toggle"
            onClick={onToggle}
          >
            {t(added ? 'projects.remove' : 'projects.add')}
          </button>
        </span>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-3 py-3">
        {entry.use !== undefined && <p className="text-caption text-text-2" data-testid="np-res-use">{entry.use}</p>}
        <div className="grid gap-1.5">
          {!designMd && (
            <Row label={t('resources.section.frameworks')} testId="np-res-frameworks">
              <span className="truncate" title={frameworks}>{frameworks}</span>
            </Row>
          )}
          <Row label={t('resources.section.license')} testId="np-res-license">
            <Link href={entry.license.url} text={entry.license.spdx} testId="np-res-license-link" />
            <span className="truncate text-text-3" title={modes}>{modes}</span>
          </Row>
          {links.map((key) => (
            <Row key={key} label={t(`resources.link.${key}`)} testId={`np-res-link-${key}`}>
              <Link href={entry.links[key] ?? ''} />
            </Row>
          ))}
        </div>
        <section className="grid gap-1.5" data-testid="np-res-writes">
          <h3 className="text-caption font-semibold text-text-3">{t('projects.res_writes')}</h3>
          <p className="truncate text-caption text-text-2">{designMd ? 'DESIGN.md' : t('projects.res_writes_instructions')}</p>
          <WriteBlock lines={designMd ? (seed === undefined ? [] : [seed]) : resourceEntryLines(entry)} testId="np-res-writes-text" />
        </section>
      </div>
    </div>
  )
}
