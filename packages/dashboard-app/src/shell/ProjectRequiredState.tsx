import { FolderKanban } from 'lucide-react'
import { useT } from '../i18n'
import type { View } from './Nav'

export function ProjectRequiredState({ onOpenProjects, view }: { onOpenProjects: () => void; view: View }): JSX.Element {
  const { t } = useT()
  return (
    <section
      className="mx-auto mt-10 flex w-full max-w-[620px] flex-col items-start rounded-2xl border border-border bg-card p-6 shadow-sm mobile:mt-6 mobile:p-5"
      data-testid="project-required"
      aria-labelledby="project-required-title"
    >
      <div className="mb-4 grid size-10 place-items-center rounded-xl bg-accent-t text-accent-d" aria-hidden="true">
        <FolderKanban className="size-5" strokeWidth={1.75} />
      </div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-text-3">{t(`nav.${view}`)}</p>
      <h1 id="project-required-title" className="text-xl font-bold tracking-[-0.02em] text-text">{t('navigation.project_required_title')}</h1>
      <p className="mt-2 max-w-[52ch] text-sm leading-6 text-text-2">{t('navigation.project_required_desc')}</p>
      <button
        type="button"
        className="mt-5 inline-flex min-h-10 items-center justify-center rounded-xl bg-btn-bg px-4 text-sm font-bold text-btn-fg outline-none transition-colors hover:bg-btn-bg-hover focus-visible:ring-3 focus-visible:ring-(--ring-blue)"
        data-testid="project-required-open"
        onClick={onOpenProjects}
      >
        {t('navigation.project_required_action')}
      </button>
    </section>
  )
}
