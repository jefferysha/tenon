import { FolderKanban } from 'lucide-react'
import { useT } from '../i18n'
import type { View } from './Nav'
import { BUTTON_SOLID, PANEL } from '../shared/uiRecipes'

export function ProjectRequiredState({ onOpenProjects, view }: { onOpenProjects: () => void; view: View }): JSX.Element {
  const { t } = useT()
  return (
    <section
      className={`mx-auto mt-10 flex w-full max-w-[620px] flex-col items-start p-6 mobile:mt-6 mobile:p-5 ${PANEL}`}
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
        className={`${BUTTON_SOLID} mt-5`}
        data-testid="project-required-open"
        onClick={onOpenProjects}
      >
        {t('navigation.project_required_action')}
      </button>
    </section>
  )
}
