import type { WbSkillEntry } from '../api/governanceTypes'
import { useT } from '../i18n'
import { SkillSourceIcon } from './SkillSourceIcon'
import { cn } from '@/lib/utils'

/**
 * 阶段技能的只读波次视图：一行一波（同行并行、行与行串行），左侧步序脊柱，右侧技能卡片
 * （来源图标 + 名称 + SKILL.md description）。点卡片看技能详情。
 */
export function SkillWaveCards({ waves, registry, onOpen }: {
  waves: readonly (readonly string[])[]
  registry: readonly WbSkillEntry[] | null
  onOpen: (id: string) => void
}): JSX.Element {
  const { t } = useT()
  if (waves.length === 0) {
    return <p className="rounded-md border border-dashed border-border px-4 py-5 text-center text-body text-text-3" role="status" data-testid="skill-waves-empty">{t('workflow.no_skills')}</p>
  }
  return (
    <ol className="grid" data-testid="skill-waves">
      {waves.map((wave, index) => {
        const parallel = wave.length > 1
        const last = index === waves.length - 1
        return (
          <li key={index} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3" aria-label={t('workflow.wave_label', { n: index + 1 })} data-testid={`skill-wave-${index}`} data-parallel={parallel}>
            <div className="flex flex-col items-center">
              <span className="grid size-7 flex-none place-items-center rounded-full bg-fill font-mono text-caption font-semibold text-text-2" aria-hidden="true">{index + 1}</span>
              {!last && <span className="my-1 w-px flex-1 bg-border-2" aria-hidden="true" />}
            </div>
            <div className={cn(!last && 'pb-4')}>
              {parallel && <p className="mb-2 pt-1 text-caption font-semibold text-(--accent)">∥ {t('workflow.parallel')} · {wave.length}</p>}
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
                {wave.map((id) => {
                  const entry = registry?.find((candidate) => candidate.name === id)
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="grid w-full gap-1.5 rounded-md border border-border bg-card px-4 py-3 text-left shadow-xs outline-none transition-[border-color,box-shadow] hover:border-accent-b hover:shadow-sm focus-visible:ring-2 focus-visible:ring-(--accent)"
                        title={t('workflow.preview_skill', { id })}
                        data-testid={`skill-card-${id}`}
                        onClick={() => onOpen(id)}
                      >
                        <span className="flex items-center gap-2">
                          {entry !== undefined && <SkillSourceIcon source={entry.source} />}
                          <span className="min-w-0 truncate font-mono text-base font-semibold text-text">{id}</span>
                        </span>
                        {entry?.description !== undefined && entry.description !== '' && (
                          <span className="line-clamp-2 text-caption text-text-2" data-testid={`skill-card-desc-${id}`}>{entry.description}</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
