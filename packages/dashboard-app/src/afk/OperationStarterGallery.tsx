import { Sparkles } from 'lucide-react'
import type { AutomationStarterTemplate } from '../api/client'
import { useT } from '../i18n'
import { handleRadioKey } from '../shared/radioKeyboard'
import { riskLabel, starterCopy } from './operationsPresentation'

interface OperationStarterGalleryProps {
  templates: AutomationStarterTemplate[]
  selected: string
  onSelect: (id: string) => void
}

export function OperationStarterGallery({ templates, selected, onSelect }: OperationStarterGalleryProps): JSX.Element {
  const { t } = useT()
  return (
    <>
      <div className="flex items-center gap-2"><Sparkles size={15} aria-hidden="true" /><h3 className="font-bold text-text">{t('operations.starter_title')}</h3></div>
      <p className="mt-1 text-caption leading-5 text-text-3">{t('operations.starter_note')}</p>
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-md bg-fill p-3 text-center text-micro text-text-3">
        <span><b className="block text-text">{t('operations.starter_axis_type')}</b>{t('operations.starter_axis_type_note')}</span>
        <span><b className="block text-text">{t('operations.starter_axis_workflow')}</b>{t('operations.starter_axis_workflow_note')}</span>
        <span><b className="block text-text">{t('operations.starter_axis_skills')}</b>{t('operations.starter_axis_skills_note')}</span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('operations.starter_title')}>
        {templates.map((item, index) => {
          const copy = starterCopy(item, t)
          return (
            <button key={item.id} type="button" role="radio" aria-checked={selected === item.id} tabIndex={selected === item.id ? 0 : -1} data-testid={`ops-starter-${item.id}`} data-selected={selected === item.id} className="rounded-md border border-border bg-bg p-3.5 text-left data-[selected=true]:border-(--accent) data-[selected=true]:bg-accent-t" onClick={() => onSelect(item.id)} onKeyDown={(event) => handleRadioKey(event, index, templates.length, (next) => {
              const candidate = templates[next]
              if (candidate) onSelect(candidate.id)
            })}>
              <span className="flex items-center justify-between gap-3"><b className="text-base text-text">{copy.title}</b><span className="rounded-full bg-fill px-2 py-1 text-micro font-semibold text-text-3">{riskLabel(item.risk, t)}</span></span>
              <span className="mt-1.5 block text-caption leading-5 text-text-3">{copy.description}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
