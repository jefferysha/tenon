import type { WorkflowOrchestration } from '@tenon/kernel/workflow/orchestration'
import { useT } from '../i18n'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { OrchestrationFlow } from './OrchestrationFlow'
import { SaveBar } from './SaveBar'

/** 左栏「总览」行在 URL 里的 step 值：阶段 id 只允许 a-zA-Z0-9_-，带冒号的值不会与任何阶段撞名。 */
export const OVERVIEW_STEP = ':overview'

/**
 * 工作流页「总览」：右栏整宽一张画布，每阶段一列，列内是 runner 真实顺序的 执行者 → 技能 → 测试 → 评审者，
 * 列头带门禁图标，回流为列头之间的虚线弧，悬停列头看输出流向。点列头：缩得很小时缓动放大到该阶段，能读清时进入该阶段。
 */
export function WorkflowOverviewPane({ editor, orchestration, onOpenStage }: {
  editor: WorkflowEditor
  orchestration: WorkflowOrchestration
  onOpenStage: (stage: string) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface-detail" data-testid="workflow-overview-pane">
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-10 pt-7 pb-8 max-[900px]:px-4 max-[900px]:pt-5">
        <h1 className="whitespace-nowrap text-page font-bold tracking-[-.01em] text-text">{t('workflow.overview')}</h1>
        <OrchestrationFlow
          mode="overview"
          stages={orchestration.stages}
          returns={orchestration.returns}
          flows={orchestration.flows}
          onOpenStage={onOpenStage}
          ariaLabel={t('workflow.overview')}
          className="min-h-[420px] flex-1"
        />
      </div>
      <SaveBar editor={editor} className="px-10 py-3 max-[900px]:px-4" />
    </section>
  )
}
