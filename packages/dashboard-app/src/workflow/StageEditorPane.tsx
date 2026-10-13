import { useCallback, useMemo, useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import type { WorkflowOrchestration } from '@tenon/kernel/workflow/orchestration'
import type { WbExecutorRef, WbReviewerRef, WbStepDef } from '../api/governanceTypes'
import { useT } from '../i18n'
import type { WorkflowEditor } from '../workbench/useWorkflowEditor'
import { revealList } from '../shared/motion'
import { AgentComposer } from './AgentComposer'
import { draftOrchestration } from './draftOrchestration'
import { GateSection } from './GateSection'
import { SkillComposer } from './SkillComposer'
import { SkillDetailDrawer } from './SkillDetail'
import { SaveBar } from './SaveBar'
import { StageFlowSection } from './StageFlowSection'

export interface StageEditorPaneProps {
  editor: WorkflowEditor
  step: WbStepDef
  /** 草稿的编排（工作流页算一次传下来）；缺省时按草稿就地算（不含 manifest 叠加）。 */
  orchestration?: WorkflowOrchestration | null
}

/** 右栏各段进场的错开间隔（s）。 */
export const SECTION_STAGGER = 0.03

// 模块级空列表：每次渲染都给画布与 AgentComposer 同一个引用，而不是新的 `[]`。
const NO_EXECUTORS: readonly WbExecutorRef[] = []
const NO_REVIEWERS: readonly WbReviewerRef[] = []

/**
 * 工作流页右栏：可编辑标题（工作流名与轨道只在左栏出现一次）；段落顺序 技能 → 门禁。
 * 「技能」段是与总览同一张画布的单列形态（执行者 / 技能 / 测试 / 评审者四条泳道，测试泳道只读地列旧步骤测试）；
 * 退回与测试策略并入门禁段（门禁 → 退回 → 测试策略），必须产出（`required-output`）是门禁段里的一种离开条件。
 * 每步的输入输出不在这里手写：任务里它们是真实发生的产出，见工作台。
 */
export function StageEditorPane({ editor, step, orchestration: provided }: StageEditorPaneProps): JSX.Element {
  const { t } = useT()
  const def = editor.def
  const editable = editor.canWrite
  const [composerOpen, setComposerOpen] = useState(false)
  const [agentRole, setAgentRole] = useState<'executors' | 'reviewers' | null>(null)
  const [skillDetail, setSkillDetail] = useState<string | null>(null)
  // 本组件按阶段 id 重挂载（WorkflowView 的 key）：每次切换阶段，各段依次轻微上浮淡入。
  const paneRef = useRef<HTMLElement>(null)
  useGSAP(() => { revealList('[data-stage-sections] > *', SECTION_STAGGER) }, { scope: paneRef })
  const registry = editor.skillRegistry
  // 编排由 kernel 的 orchestrate 算（与服务端同一实现）：技能 = 声明的技能，按 runner 顺序。
  const localOrchestration = useMemo(
    () => provided !== undefined || def === null ? null : draftOrchestration(def),
    [provided, def],
  )
  const orchestration = provided ?? localOrchestration
  const stageOf = (id: string) => orchestration?.stages.find((candidate) => candidate.id === id)
  const stageLabel = editor.labelOf(step.id)
  const openComposer = useCallback(() => setComposerOpen(true), [])

  return (
    <section ref={paneRef} className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface-detail" data-testid="stage-editor-pane">
      {/* relative：sr-only 等绝对定位后代要以本滚动容器为包含块，否则它们会越过裁切把整页撑出滚动条。 */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-8 max-[900px]:px-4 max-[900px]:pt-5">
        {/* 无凭证是错误，直接放右栏顶部（保存条不会出现）；保存失败的原因由保存条自己给。 */}
        {!editable && <p className="mb-3 truncate whitespace-nowrap text-caption text-red-d" role="alert" data-testid="wb-no-token">{t('workflow.no_token')}</p>}
        <div className="flex items-start gap-3" data-testid="stage-actions">
          <span className="sr-only" data-testid={`wb-lane-name-${step.id}`}>{stageLabel}</span>
          <input
            className="min-w-0 flex-1 rounded-xs border-b border-transparent bg-transparent pb-0.5 text-page font-bold tracking-[-.01em] text-text outline-none transition-colors hover:border-border focus:border-accent-b disabled:cursor-default disabled:hover:border-transparent"
            value={step.label}
            disabled={!editable}
            aria-label={t('workflow.stage_name')}
            data-testid={`wb-lane-name-input-${step.id}`}
            onChange={(event) => editor.renameStep(step.id, event.target.value)}
          />
        </div>

        <div className="mt-4 grid divide-y divide-border" data-stage-sections="">
          <StageFlowSection
            stage={stageOf(step.id)}
            editable={editable}
            onEditSkills={openComposer}
            onEditAgents={setAgentRole}
            onOpenSkill={setSkillDetail}
          />

          <GateSection editor={editor} step={step} />
        </div>
      </div>
      {/* 保存条在滚动区之外：出现时挤小滚动区，不盖住最后一段（门禁 / 退回 / 测试策略）。 */}
      <SaveBar editor={editor} className="px-10 py-3 max-[900px]:px-4" />

      <SkillComposer
        open={composerOpen}
        stageLabel={stageLabel}
        skills={step.skills}
        registry={registry}
        onClose={() => setComposerOpen(false)}
        onSave={(next) => editor.setSkills(step.id, next)}
      />
      <AgentComposer
        open={agentRole !== null}
        role={agentRole ?? 'executors'}
        stageLabel={stageLabel}
        executors={step.agents?.executors ?? NO_EXECUTORS}
        reviewers={step.agents?.reviewers ?? NO_REVIEWERS}
        tests={step.tests ?? []}
        agents={editor.agents}
        onClose={() => setAgentRole(null)}
        onSave={(patch) => editor.setAgents(step.id, patch)}
      />
      <SkillDetailDrawer name={skillDetail} onClose={() => setSkillDetail(null)} />
    </section>
  )
}
