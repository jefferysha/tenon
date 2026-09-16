import { useT } from '../../i18n'
import { getToken } from '../../api/transport'
import type { ResourceDocument } from '../../api/resourceTypes'
import { RESOURCE_LINK_KEYS } from '../../api/resourceTypes'
import { DetailColumn, StatusPill } from '../../shell/ThreeColumns'
import { BUTTON_DANGER, BUTTON_GHOST } from '../../shared/uiRecipes'
import { licenseModeKeys, licenseTone } from './resourceLabels'

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }): JSX.Element {
  return (
    <section className="mb-5 grid gap-2" data-testid={testId}>
      <h2 className="text-caption font-semibold uppercase tracking-[.08em] text-text-3">{title}</h2>
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

/** 右列：许可、安装、链接、技能、框架、样式、场景、核验；自定义条目才有编辑与删除。 */
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
  const modes = licenseModeKeys(entry)

  return (
    <DetailColumn
      testId="res-detail"
      panelId="res-panel"
      header={(
        <div className="grid gap-2">
          <p className="text-caption font-semibold uppercase tracking-[.08em] text-(--accent)" data-testid="res-eyebrow">
            {t(`resources.category.${entry.category}`)}
          </p>
          <h1 className="text-page font-bold tracking-[-.01em] text-text" data-testid="res-title">{entry.name}</h1>
          <p className="font-mono text-caption whitespace-nowrap overflow-x-auto text-text-3" data-testid="res-slug">{entry.id}</p>
          <StatusPill tone={licenseTone(entry)} testId="res-license-pill">
            {t(`resources.license_mode.${modes[0] ?? 'redistributable'}`)}
          </StatusPill>
        </div>
      )}
      footer={(
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_GHOST} data-testid="res-copy" disabled={!canWrite || busy} onClick={onCopy}>
            {t('resources.copy')}
          </button>
          {custom && (
            <>
              <button type="button" className={BUTTON_GHOST} data-testid="res-edit" disabled={!canWrite || busy} onClick={onEdit}>
                {t('resources.edit')}
              </button>
              <button type="button" className={BUTTON_DANGER} data-testid="res-delete" disabled={!canWrite || busy} onClick={onDelete}>
                {t('resources.delete')}
              </button>
            </>
          )}
          {!canWrite && <span className="text-caption text-text-3" data-testid="res-no-token">{t('resources.no_token')}</span>}
        </div>
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
          {entry.install.map((line) => (
            <code key={line} className="block overflow-x-auto rounded-sm bg-fill px-3 py-2 font-mono text-caption whitespace-nowrap text-text">
              {line}
            </code>
          ))}
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
