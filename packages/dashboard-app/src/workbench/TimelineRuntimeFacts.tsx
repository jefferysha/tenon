import { AlertTriangle, ChevronDown, Eye, LockKeyhole } from 'lucide-react'
import { useT } from '../i18n'
import type { WbSkillEntry } from '../api/client'
import { PreviewRow } from './TimelineHookRows'
import type { BoardLane } from './boardLane'
import type { HooksConfigState } from './hooksConfig'

export interface TimelineRuntimeFactsProps {
  selected: BoardLane
  hooks: HooksConfigState
  skillRegistry?: WbSkillEntry[] | null
  /** 注册表按名索引（编排器已算好，安装状态统计复用同一份表）。 */
  registryByName: ReadonlyMap<string, WbSkillEntry>
  prompt: string
}

/**
 * 阶段运行时事实侧栏：技能数、启用 hook 数、产出、依赖与提示词长度的只读快照。
 * 每条事实的 ready 点只在数据面**确实描述**该维度时才判绿——数据缺失时给「运行时决定」这类
 * 诚实占位，不谎报「全部就绪」（同 BoardLane 的 undefined 占位纪律）。
 */
export function TimelineRuntimeFacts({
  selected,
  hooks,
  skillRegistry,
  registryByName,
  prompt,
}: TimelineRuntimeFactsProps): JSX.Element {
  const { t } = useT()
  const skills = selected.skills
  const enabledHooks = hooks.hooks !== null
    ? hooks.hooks.filter((hook) => !(`${hook.id}.${selected.id}` in hooks.matrix))
    : null
  const missingSkills = skills && skillRegistry !== null && skillRegistry !== undefined
    ? skills.filter((id) => registryByName.get(id)?.installed !== true).length
    : null
  const dependencyCount = Object.values(selected.skillDeps ?? {}).reduce((total, deps) => total + deps.length, 0)

  return (
    <aside data-testid="wb-timeline-preview" className="sticky top-(--nav-offset) rounded-lg bg-fill p-4 max-[1000px]:static">
      <div className="flex items-center gap-2">
        <Eye className="h-4 w-4 text-(--accent)" aria-hidden="true" />
        <h3 className="text-base font-semibold text-text">{t('workbench.timeline_facts')}</h3>
        <ChevronDown className="ml-auto h-4 w-4 text-text-3" aria-hidden="true" />
      </div>
      <div className="mt-4 space-y-2" data-testid="wb-runtime-facts">
        <PreviewRow label={t('workbench.timeline_skill_fact')} value={skills === undefined ? t('workbench.timeline_skill_runtime') : t('workbench.timeline_skill_count', { skills: skills.length, dependencies: dependencyCount })} ready={skills === undefined || skills.length > 0} />
        <PreviewRow label={t('workbench.timeline_hook_fact')} value={enabledHooks === null ? t('workbench.timeline_loading') : t('workbench.timeline_hook_count', { enabled: enabledHooks.length, total: hooks.hooks?.length ?? 0 })} ready={enabledHooks !== null && enabledHooks.length > 0} />
        {/* 未声明产出字段的阶段没有「运行时产出」可言——恒绿会让绿点整体失去指示意义。 */}
        <PreviewRow label={t('workbench.timeline_runtime_outputs')} value={t(selected.nonemptyGuard ? 'workbench.timeline_output_fact_integrity' : 'workbench.timeline_output_fact_progress')} ready={selected.outputs.length > 0} />
        {/* skillDeps === undefined = 数据面不描述依赖（同 BoardLane 的诚实占位纪律）：
            既不能谎报「全部可并行」，也不能给恒绿点。 */}
        <PreviewRow
          label={t('workbench.timeline_dependency_fact')}
          value={selected.skillDeps === undefined
            ? t('workbench.timeline_skill_runtime')
            : dependencyCount > 0
              ? t('workbench.timeline_dependency_count', { n: dependencyCount })
              : t('workbench.timeline_all_parallel')}
          ready={selected.skillDeps !== undefined}
        />
        <PreviewRow label={t('workbench.timeline_prompt_fact')} value={prompt.trim() ? t('workbench.timeline_prompt_length', { n: prompt.trim().length }) : t('workbench.timeline_prompt_missing')} ready={prompt.trim().length > 0} />
      </div>
      {missingSkills !== null && missingSkills > 0 && (
        <p className="mt-3 flex gap-2 rounded-md bg-amber-t px-3 py-2 text-caption leading-5 text-amber-d"><AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />{t('workbench.timeline_missing_skills')}</p>
      )}
      <div className="mt-3 flex items-center gap-2 rounded-md bg-card px-3 py-2 text-caption text-text-2">
        <LockKeyhole className="h-4 w-4 text-text-3" aria-hidden="true" />
        <span>{t('workbench.timeline_snapshot')}</span><strong className="ml-auto font-semibold text-text">{t('workbench.timeline_frozen')}</strong>
      </div>
    </aside>
  )
}
