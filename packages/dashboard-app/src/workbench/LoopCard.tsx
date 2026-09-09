import { useEffect, useRef, useState } from 'react'
import { postLoopLevel, postLoopUpdate } from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
export { LOOP_RUNNERS, WB_TW, WbAdvanced } from './loopCardModel'
export { LpSlider } from './LoopControls'
export { useLoops, type LoopsState } from './useLoops'
import { BADGE_TW, ProvBadge, WB_TW, computePatch, draftOf, loopDraftValueEqual, rebaseLoopDraft, type LoopDraft } from './loopCardModel'
import { RECO_TOKENS_K, clamp } from './LoopControls'
import type { LoopsState } from './useLoops'
import { LoopAdvancedFields } from './LoopAdvancedFields'
import { LoopCardActions } from './LoopCardActions'
import { LoopGoalFields } from './LoopGoalFields'
import { LoopRelationship } from './LoopRelationship'
import { promotionDecisionKey } from './governanceModel'
const LEVELS = ['L1', 'L2', 'L3'] as const
export interface LoopCardProps {
  root: string
  loops: LoopsState
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}
export function LoopCard({ root, loops, onDirtyChange, onBusyChange }: LoopCardProps): JSX.Element {
  const { t, lang } = useT()
  const row = loops.selected
  const [draft, setDraft] = useState<LoopDraft | null>(null)
  const draftRef = useRef<LoopDraft | null>(null)
  draftRef.current = draft
  const [saving, setSaving] = useState(false)
  const [saveErrors, setSaveErrors] = useState<string[] | null>(null)
  const [saveOk, setSaveOk] = useState(false)
  const [levelError, setLevelError] = useState<string | null>(null)
  const [levelBusy, setLevelBusy] = useState(false)
  const [confirmLevel, setConfirmLevel] = useState<(typeof LEVELS)[number] | null>(null)
  const [confirmDecisionKey, setConfirmDecisionKey] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const saveGeneration = useRef(0)
  const levelGeneration = useRef(0)
  const reviewGeneration = useRef(0)
  const pendingSaveFields = useRef(new Set<keyof LoopDraft>())
  const draftIdentity = useRef('')
  const draftBase = useRef<LoopDraft | null>(null)
  const editRevision = useRef(0)
  const fieldRevisions = useRef(new Map<keyof LoopDraft, number>())
  const [, setBaseRevision] = useState(0)
  const identity = useRef({ root, rowId: row?.id ?? null })
  identity.current = { root, rowId: row?.id ?? null }
  const localeIdentity = useRef({ t, lang })
  localeIdentity.current = { t, lang }
  useEffect(() => {
    ++saveGeneration.current
    ++levelGeneration.current
    ++reviewGeneration.current
    setSaving(false)
    pendingSaveFields.current.clear()
    setLevelBusy(false)
    setReviewBusy(false)
    setConfirmLevel(null)
    setConfirmDecisionKey(null)
  }, [root, row?.id])
  useEffect(() => {
    setSaveErrors(null)
    setLevelError(null)
    setReviewError(null)
  }, [lang])
  const [promptCopied, setPromptCopied] = useState(false)
  const [showMatches, setShowMatches] = useState(false)
  useEffect(() => {
    const nextIdentity = JSON.stringify([root, row?.id ?? null])
    const nextBase = row ? draftOf(row) : null
    setDraft((current) => {
      const sameIdentity = draftIdentity.current === nextIdentity
      if (sameIdentity && current !== null && nextBase !== null) {
        for (const key of fieldRevisions.current.keys()) {
          if (
            !pendingSaveFields.current.has(key)
            && loopDraftValueEqual(current[key], nextBase[key])
          ) fieldRevisions.current.delete(key)
        }
      }
      const rebased = sameIdentity && current !== null && nextBase !== null
        ? rebaseLoopDraft(current, nextBase, fieldRevisions.current)
        : nextBase
      if (!sameIdentity) fieldRevisions.current.clear()
      draftIdentity.current = nextIdentity
      draftBase.current = nextBase
      draftRef.current = rebased
      return rebased
    })
    setBaseRevision((value) => value + 1)
    setSaveErrors(null)
    setLevelError(null)
    setReviewError(null)
  }, [root, row])
  const base = draftBase.current
  const patch = draft && base ? computePatch(draft, base) : {}
  const dirty = Object.keys(patch).length > 0
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => {
    onDirtyChange?.(false)
  }, [onDirtyChange])
  const mutationBusy = saving || levelBusy || reviewBusy
  useEffect(() => {
    onBusyChange?.(mutationBusy)
  }, [mutationBusy, onBusyChange])
  useEffect(() => () => {
    onBusyChange?.(false)
  }, [onBusyChange])
  const promotionFacts = promotionDecisionKey(root, row)
  const activeConfirmLevel = confirmDecisionKey === promotionFacts ? confirmLevel : null
  useEffect(() => {
    if (confirmDecisionKey !== null && confirmDecisionKey !== promotionFacts) {
      setConfirmLevel(null)
      setConfirmDecisionKey(null)
    }
  }, [confirmDecisionKey, promotionFacts])
  const closePromotion = (): void => { setConfirmLevel(null); setConfirmDecisionKey(null) }
  function edit(part: Partial<LoopDraft>): void {
    setDraft((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...part }
      for (const key of Object.keys(part) as Array<keyof LoopDraft>) {
        const equalsBase = loopDraftValueEqual(next[key], draftBase.current?.[key])
        if (equalsBase && !pendingSaveFields.current.has(key)) fieldRevisions.current.delete(key)
        else fieldRevisions.current.set(key, ++editRevision.current)
      }
      draftRef.current = next
      return next
    })
    setSaveOk(false)
  }
  async function save(): Promise<void> {
    if (!row || !draft || !dirty || saving) return
    const targetRoot = root
    const targetId = row.id
    const generation = ++saveGeneration.current
    const targetPatch = patch
    const targetDraft = draft
    const targetKeys = Object.keys(targetPatch) as Array<keyof LoopDraft>
    const targetRevisions = new Map(
      targetKeys
        .map((key) => [key, fieldRevisions.current.get(key)] as const),
    )
    pendingSaveFields.current = new Set(targetKeys)
    setSaving(true)
    setSaveErrors(null)
    setSaveOk(false)
    try {
      await postLoopUpdate({ root: targetRoot, id: targetId, patch: targetPatch })
      if (generation !== saveGeneration.current || identity.current.root !== targetRoot || identity.current.rowId !== targetId) return
      if (draftBase.current !== null) {
        const acceptedBase = { ...draftBase.current }
        for (const key of Object.keys(targetPatch) as Array<keyof LoopDraft>) {
          Object.assign(acceptedBase, { [key]: targetDraft[key] })
        }
        draftBase.current = acceptedBase
        setBaseRevision((value) => value + 1)
      }
      for (const [key, revision] of targetRevisions) {
        if (fieldRevisions.current.get(key) === revision) fieldRevisions.current.delete(key)
      }
      setSaveOk(true)
      loops.reload()
    } catch (err) {
      if (generation === saveGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        const current = localeIdentity.current
        setSaveErrors([formatApiError(err, current.t, { exposeServerDetail: current.lang === 'zh' })])
      }
    } finally {
      if (generation === saveGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        pendingSaveFields.current.clear()
        const currentDraft = draftRef.current
        const currentBase = draftBase.current
        if (currentDraft !== null && currentBase !== null) {
          for (const key of fieldRevisions.current.keys()) {
            if (loopDraftValueEqual(currentDraft[key], currentBase[key])) fieldRevisions.current.delete(key)
          }
        }
        setSaving(false)
      }
    }
  }
  function requestLevel(target: (typeof LEVELS)[number]): void {
    if (!row || dirty || levelBusy || target === row.autonomy_level) return
    if (LEVELS.indexOf(target) > LEVELS.indexOf(row.autonomy_level)) {
      setConfirmLevel(target)
      setConfirmDecisionKey(promotionFacts)
    } else {
      void applyLevel(target)
    }
  }
  async function applyLevel(target: string): Promise<void> {
    if (!row || dirty) {
      closePromotion()
      return
    }
    const targetRoot = root
    const targetId = row.id
    const generation = ++levelGeneration.current
    setLevelBusy(true)
    setLevelError(null)
    try {
      await postLoopLevel({ root: targetRoot, id: targetId, target })
      if (generation !== levelGeneration.current || identity.current.root !== targetRoot || identity.current.rowId !== targetId) return
      loops.reload()
    } catch (err) {
      if (generation === levelGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        const current = localeIdentity.current
        setLevelError(current.t('workbench.lp_level_fail', {
          msg: formatApiError(err, current.t, { exposeServerDetail: current.lang === 'zh' }),
        }))
      }
    } finally {
      if (generation === levelGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        setLevelBusy(false)
      }
    }
  }
  async function reviewAction(status: 'active' | 'paused'): Promise<void> {
    if (!row || dirty || reviewBusy) return
    const targetRoot = root
    const targetId = row.id
    const generation = ++reviewGeneration.current
    setReviewBusy(true)
    setReviewError(null)
    try {
      await postLoopUpdate({ root: targetRoot, id: targetId, patch: { status } })
      if (generation !== reviewGeneration.current || identity.current.root !== targetRoot || identity.current.rowId !== targetId) return
      loops.reload() // 显式重拉：draft 标记已被 server 清，新快照到达即徽章消失
    } catch (err) {
      if (generation === reviewGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        const current = localeIdentity.current
        setReviewError(formatApiError(err, current.t, { exposeServerDetail: current.lang === 'zh' }))
      }
    } finally {
      if (generation === reviewGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        setReviewBusy(false)
      }
    }
  }
  if (loops.loadError) {
    return (
      <section className={WB_TW.card} data-testid="wb-loop-card">
        <div className={WB_TW.head}><b className={WB_TW.headB}>{t('workbench.lp_title')}</b></div>
        <p className={WB_TW.loadError} data-tone="error" data-testid="lp-load-error" role="alert">{loops.loadError}</p>
      </section>
    )
  }
  if (loops.rows === null) {
    return (
      <section className={WB_TW.card} data-testid="wb-loop-card">
        <div className={WB_TW.head}><b className={WB_TW.headB}>{t('workbench.lp_title')}</b></div>
        <p className={WB_TW.loading} role="status" aria-live="polite">{t('common.loading')}</p>
      </section>
    )
  }
  if (!row || !draft) {
    const prompt = t('workbench.lp_empty_prompt')
    return (
      <section className={WB_TW.card} data-testid="wb-loop-card">
        <div className={WB_TW.head}><b className={WB_TW.headB}>{t('workbench.lp_title')}</b></div>
        <div className="pt-2.5 pb-1" data-testid="lp-empty" role="status" aria-live="polite">
          <p className="mb-1 text-body font-bold">{t('workbench.lp_empty_title')}</p>
          <p className={WB_TW.note}>{t('workbench.lp_empty_go')}</p>
          <div className="my-3 rounded-sm border border-dashed border-border-2 bg-fill px-3.5 py-3" data-testid="lp-empty-prompt">
            <p className="mb-2.5 text-caption leading-[1.65] text-text-2">{prompt}</p>
            <Button
              variant="ghost"
              size="sm"
              className={cn(WB_TW.btnGhost, 'h-7 px-3 text-caption')}
              data-testid="lp-empty-copy"
              aria-label={t('workbench.lp_empty_copy_aria')}
              onClick={() => {
                void navigator.clipboard?.writeText(prompt).then(() => setPromptCopied(true))
              }}
            >
              {promptCopied ? t('workbench.lp_empty_copied') : t('workbench.lp_empty_copy')}
            </Button>
            {promptCopied && <span className="sr-only" role="status" aria-live="polite">{t('workbench.lp_empty_copied')}</span>}
          </div>
          <p className={cn(WB_TW.note, 'mt-2')}>{t('workbench.lp_empty_note')}</p>
        </div>
      </section>
    )
  }
  const active = draft.status === 'active'
  const retired = draft.status === 'retired'
  const isPendingReview = row.draft === true
  const tokensK = draft.max_tokens_per_day === null ? RECO_TOKENS_K : clamp(Math.round(draft.max_tokens_per_day / 10000) * 10, 10, 500)
  return (
    <section className={WB_TW.card} data-testid="wb-loop-card">
      <div className={WB_TW.head}>
        <b className={WB_TW.headB}>{t('workbench.lp_title')}</b>
        <Switch
          className={WB_TW.switch}
          checked={active}
          disabled={retired}
          aria-label={t('workbench.lp_enable')}
          data-testid="lp-enable"
          onCheckedChange={() => {
            if (!retired) edit({ status: active ? 'paused' : 'active' })
          }}
        />
        <span
          className={cn(BADGE_TW, active ? 'bg-transparent pl-0 text-green-d' : retired ? 'bg-red-t text-red-d' : 'bg-fill text-text-3')}
          data-state={active ? 'run' : retired ? 'retired' : 'paused'}
          data-testid="lp-pill"
        >
          {t(active ? 'workbench.lp_running' : retired ? 'workbench.lp_retired' : 'workbench.lp_paused')}
        </span>
        <ProvBadge field="status" />
        {/* loop-init L5：草稿待审阅徽章——蓝底 color-mix 从 --accent 派生（决议 #9）；testid 走
            lp-draft-* 审阅语义，与既有编辑态无关。 */}
        {isPendingReview && (
          <span
            className={cn(BADGE_TW, 'bg-[color-mix(in_srgb,var(--accent)_14%,var(--card))] text-accent-d')}
            data-testid="lp-draft-badge"
          >
            {t('workbench.lp_draft_badge')}
          </span>
        )}
        {loops.rows.length > 1 && (
          <select
            className={cn(WB_TW.input, 'h-[26px] w-auto px-2 font-mono text-caption')}
            aria-label={t('workbench.lp_loop_select')}
            data-testid="lp-loop-select"
            value={row.id}
            disabled={dirty}
            title={dirty ? t('workbench.lp_select_dirty') : undefined}
            onChange={(e) => loops.select(e.target.value)}
          >
            {loops.rows.map((r) => (
              <option key={r.id} value={r.id}>{r.id}</option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        {dirty && <span className={WB_TW.statusDirty} data-state="dirty" data-testid="lp-dirty" role="status" aria-live="polite">{t('workbench.lp_dirty')}</span>}
        {saveOk && !dirty && <span className={WB_TW.statusOk} data-state="ok" data-testid="lp-save-ok" role="status" aria-live="polite">{t('workbench.lp_save_ok')}</span>}
        <Button size="sm" className={WB_TW.btnSolid} data-testid="lp-save" onClick={() => void save()} disabled={!dirty || saving}>
          {t('workbench.lp_save')}
        </Button>
        <span className={WB_TW.headSub}>{t('workbench.lp_head_sub')}</span>
      </div>
      {saveErrors && (
        <ul className={WB_TW.saveErrors} data-testid="lp-save-errors" role="alert">
          {saveErrors.map((e) => (
            <li key={e} className={WB_TW.saveErrorsLi}>{e}</li>
          ))}
        </ul>
      )}
      <LoopRelationship row={row} open={showMatches} onOpen={setShowMatches} t={t} />
      <LoopGoalFields draft={draft} onEdit={edit} />
      <LoopAdvancedFields
        row={row}
        draft={draft}
        tokensK={tokensK}
        levelBusy={levelBusy}
        actionDisabled={dirty}
        levelError={levelError}
        onEdit={edit}
        onLevel={requestLevel}
      />
      <LoopCardActions
        row={row}
        pendingReview={isPendingReview}
        reviewBusy={reviewBusy}
        actionDisabled={dirty}
        reviewError={reviewError}
        confirmLevel={activeConfirmLevel}
        onReview={(status) => void reviewAction(status)}
        onClosePromotion={closePromotion}
        onConfirmPromotion={(target) => {
          if (confirmDecisionKey !== promotionFacts || confirmLevel !== target) {
            closePromotion()
            return
          }
          closePromotion()
          void applyLevel(target)
        }}
      />
    </section>
  )
}
