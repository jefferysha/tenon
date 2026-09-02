import { ChevronRight, Home } from 'lucide-react'
import { useT } from '../i18n'
import type { View } from './Nav'

export interface PageBreadcrumbsProps {
  view: View
  projectName?: string
  changeName?: string | null
  onView: (view: View) => void
}

function pageLabel(view: View, t: (key: string) => string): string {
  if (view === 'overview') return t('navigation.home')
  return t(`nav.${view}`)
}

/** A small, shared location trail. It is intentionally presentation-only: App remains the router. */
export function PageBreadcrumbs({ view, projectName, changeName, onView }: PageBreadcrumbsProps): JSX.Element {
  const { t } = useT()
  const items: Array<{ label: string; view?: View; current?: boolean; testId?: string }> = [
    { label: t('navigation.home'), view: 'overview', testId: 'breadcrumb-home' },
    { label: t('nav.projects'), view: 'projects', testId: 'breadcrumb-projects' },
  ]
  if (projectName) items.push({ label: projectName, view: 'progress', testId: 'breadcrumb-project' })
  if (view !== 'projects' && view !== 'overview') {
    items.push({ label: pageLabel(view, t), current: changeName == null || changeName === '', testId: 'breadcrumb-page' })
  }
  if (changeName) items.push({ label: changeName, current: true, testId: 'breadcrumb-change' })
  if (view === 'projects') items[items.length - 1] = { label: t('nav.projects'), current: true, testId: 'breadcrumb-page' }
  if (view === 'overview') items.splice(1)

  return (
    <nav className="mb-3 flex min-w-0" aria-label={t('navigation.breadcrumbs_label')} data-testid="breadcrumbs">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-text-3">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="size-3 flex-none text-border-2" strokeWidth={1.75} aria-hidden="true" />}
            {item.current ? (
              <span className="max-w-[28ch] truncate font-semibold text-text" aria-current="page" data-testid={item.testId}>
                {index === 0 && <Home className="mr-1 inline size-3" strokeWidth={1.75} aria-hidden="true" />}
                {item.label}
              </span>
            ) : (
              <button
                type="button"
                className="max-w-[28ch] truncate rounded-md px-1 py-0.5 font-medium text-text-3 outline-none transition-colors hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--ring-blue)"
                data-testid={item.testId}
                onClick={() => onView(item.view ?? 'overview')}
              >
                {index === 0 && <Home className="mr-1 inline size-3" strokeWidth={1.75} aria-hidden="true" />}
                {item.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
