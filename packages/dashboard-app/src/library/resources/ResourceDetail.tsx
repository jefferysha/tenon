import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '../../i18n'
import { getToken } from '../../api/transport'
import type { ResourceDocument } from '../../api/resourceTypes'
import { RESOURCE_LINK_KEYS } from '../../api/resourceTypes'
import { DetailColumn } from '../../shell/ThreeColumns'
import { BUTTON_GHOST, BUTTON_ICON } from '../../shared/uiRecipes'
import { CopyAsCustomButton, DeleteMenu, DetailTitle, ReadOnlyNote } from '../libraryChrome'

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }): JSX.Element {
  return (
    <section className="mb-5 grid gap-2" data-testid={testId}>
      <h2 className="text-caption font-semibold text-text-3">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }): JSX.Element {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-3" data-testid={testId}>
      <span className="text-base text-text-3">{label}</span>
      <span className="min-w-0 truncate text-base text-text" title={value}>{value}</span>
    </div>
  )
}

/** 安装命令一行 + 行尾的剪贴板按钮（真正的「复制到剪贴板」；与「复制为自定义」不是一回事）。 */
function InstallLine({ line, index }: { line: string; index: number }): JSX.Element {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const label = copied ? t('resources.copied') : t('resources.copy_command')
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-sm bg-fill pl-3" data-testid={`res-install-${index}`}>
      <code className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-caption whitespace-nowrap text-text">{line}</code>
      <button
        type="button"
        className={`${BUTTON_ICON} flex-none rounded-sm`}
        aria-label={label}
        title={label}
        data-testid={`res-install-copy-${index}`}
        onClick={() => {
          void navigator.clipboard?.writeText(line).then(() => setCopied(true), () => undefined)
        }}
      >
        {copied ? <Check className="size-4 text-(--accent)" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      </button>
    </div>
  )
}

/**
 * 右列：许可、安装、链接、技能、框架、样式、场景、核验。名称只显示 name（标识在悬停提示里），
 * 动作在标题右侧：「复制为自定义」；自定义条目多出「编辑」与 ⋯ 里的删除。
 */
export function ResourceDetail({
  document, busy, errorKey, onCopy, onEdit, onDelete, onReload,
}: {
  document: ResourceDocument
  busy: boolean
  errorKey: string | null
  onCopy: () => void
  onEdit: () => void
  onDelete: () => void
  onReload: () => void
}): JSX.Element {
  const { t } = useT()
  const entry = document.entry
  const custom = document.source === 'custom'
  const canWrite = getToken() !== ''

  return (
    <DetailColumn
      testId="res-detail"
      panelId="res-panel"
      header={(
        <DetailTitle
          testId="res"
          title={entry.name}
          hint={entry.id}
          custom={custom}
          actions={(
            <>
              {!canWrite && <ReadOnlyNote testId="res-no-token" />}
              <CopyAsCustomButton testId="res-copy" disabled={!canWrite || busy} onClick={onCopy} />
              {custom && (
                <>
                  <button type="button" className={BUTTON_GHOST} data-testid="res-edit" disabled={!canWrite || busy} onClick={onEdit}>
                    {t('resources.edit')}
                  </button>
                  <DeleteMenu testId="res-more" disabled={!canWrite || busy} onDelete={onDelete} />
                </>
              )}
            </>
          )}
        />
      )}
    >
      {errorKey !== null && (
        <div className="mb-4 grid gap-2 rounded-md border border-red-b bg-red-t px-4 py-3" role="alert" data-testid="res-error">
          <span className="text-body font-semibold text-red-d">{t(`resources.errors.${errorKey}`)}</span>
          <button type="button" className={`${BUTTON_GHOST} justify-self-start`} data-testid="res-reload" onClick={onReload}>
            {t('resources.reload')}
          </button>
        </div>
      )}
      <Section title={t('resources.section.license')} testId="res-section-license">
        <Row label={t('resources.field.spdx')} value={entry.license.spdx} testId="res-spdx" />
        <Row
          label={t('resources.field.redistributable')}
          value={t(entry.license.redistributable ? 'resources.yes' : 'resources.no')}
          testId="res-redistributable"
        />
        <Row
          label={t('resources.field.attribution')}
          value={t(entry.license.attribution ? 'resources.yes' : 'resources.no')}
        />
        <Row label={t('resources.field.commercial')} value={t(`resources.commercial.${entry.license.commercial}`)} />
        {entry.license.notice !== undefined && (
          <Row label={t('resources.field.notice')} value={entry.license.notice} testId="res-notice" />
        )}
        <a
          className="truncate text-base text-(--accent) underline-offset-2 hover:underline"
          href={entry.license.url}
          target="_blank"
          rel="noreferrer"
          data-testid="res-license-url"
        >
          {entry.license.url}
        </a>
      </Section>
      {entry.install.length > 0 && (
        <Section title={t('resources.section.install')} testId="res-section-install">
          {entry.install.map((line, index) => <InstallLine key={line} line={line} index={index} />)}
        </Section>
      )}
      <Section title={t('resources.section.links')} testId="res-section-links">
        <div className="flex flex-wrap gap-2">
          {RESOURCE_LINK_KEYS.filter((key) => entry.links[key] !== undefined).map((key) => (
            <a
              key={key}
              className={`${BUTTON_GHOST} px-3`}
              href={entry.links[key]}
              target="_blank"
              rel="noreferrer"
              data-testid={`res-link-${key}`}
            >
              {t(`resources.link.${key}`)}
            </a>
          ))}
        </div>
      </Section>
      {entry.skills.length > 0 && (
        <Section title={t('resources.section.skills')} testId="res-section-skills">
          <p className="font-mono text-caption whitespace-nowrap overflow-x-auto text-text-2">{entry.skills.join(' ')}</p>
        </Section>
      )}
      <Section title={t('resources.section.frameworks')} testId="res-section-frameworks">
        <p className="text-base whitespace-nowrap overflow-x-auto text-text-2">
          {entry.frameworks.length === 0 ? t('resources.any') : entry.frameworks.join(' ')}
        </p>
      </Section>
      <Section title={t('resources.section.styling')} testId="res-section-styling">
        <p className="text-base whitespace-nowrap overflow-x-auto text-text-2">
          {entry.styling.length === 0 ? t('resources.any') : entry.styling.join(' ')}
        </p>
      </Section>
      {entry.use !== undefined && (
        <Section title={t('resources.section.use')} testId="res-section-use">
          <p className="text-base text-text-2">{entry.use}</p>
        </Section>
      )}
      <Section title={t('resources.section.verified')} testId="res-section-verified">
        <p className="font-mono text-caption text-text-2">{entry.verified_at}</p>
      </Section>
    </DetailColumn>
  )
}
