import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import { fetchHostTargetDetection } from '../api/hostTargetPlanClient'
import { instructionErrorKey } from '../api/instructionErrorKey'
import { InstructionApiError, fetchTemplate, fetchTemplates, planProjectCreate } from '../api/instructionsClient'
import type { ProjectCreatePlan, TemplateDocument, TemplateSummary } from '../api/instructionsDecoders'
import { Dialog } from '../shared/Dialog'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'
import { ClientStep } from './ClientStep'
import { ConfirmStep } from './ConfirmStep'
import { CreateProgress } from './CreateProgress'
import { LocationStep } from './LocationStep'
import { TemplateStep, selectionKey, type TemplateSelection } from './TemplateStep'
import { WizardSteps } from './WizardSteps'
import {
  FALLBACK_CLIENTS, FOLDER_NAME, WIZARD_STEPS, basename, filesForClients, instructionsInput, joinPath, projectInput, splitClients,
  type FileMode, type LocationMode, type WizardStep,
} from './newProjectModel'
import { composeFor } from './composeFor'
import { useLocationCheck } from './useLocationCheck'
import { useProjectCreateRun } from './useProjectCreateRun'

/* 步骤切换：180ms 淡入 + 4px 上移；reduced-motion 只留淡入。 */
const STEP_MOTION = 'animate-in fade-in-0 slide-in-from-bottom-1 duration-(--dur-base) ease-(--ease-out) motion-reduce:slide-in-from-bottom-0'
/** 执行前失败时应回到「位置」修改的错误码。 */
const LOCATION_ERRORS = new Set(['project_path_exists', 'parent_missing', 'parent_not_directory', 'path_missing', 'not_directory', 'invalid_path', 'path_unsafe', 'git_unavailable'])

export interface NewProjectDialogProps {
  onClose: () => void
  /** 创建成功：切到新项目。 */
  onCreated: (root: string) => void
  /** 已登记的目录点「打开」：切到该项目；缺省同 onCreated。 */
  onOpen?: (root: string) => void
}

/** 新建项目向导：位置 → 模板 → 客户端 → 确认；「创建」后同一对话框切到逐步进度，成功即切到该项目。 */
export function NewProjectDialog({ onClose, onCreated, onOpen = onCreated }: NewProjectDialogProps): JSX.Element {
  const { t } = useT()
  const [view, setView] = useState<'wizard' | 'progress'>('wizard')
  const [step, setStep] = useState<WizardStep>('location')
  const [mode, setMode] = useState<LocationMode>('existing')
  const [path, setPath] = useState('')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [gitInit, setGitInit] = useState(true)
  const [recheck, setRecheck] = useState(0)
  const [focus, setFocus] = useState<'name' | null>(null)
  const [templates, setTemplates] = useState<readonly TemplateSummary[]>([])
  const [selected, setSelected] = useState<readonly TemplateSelection[]>([])
  const [focused, setFocused] = useState<TemplateSelection | null>(null)
  const [documents, setDocuments] = useState<Record<string, TemplateDocument>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [clientGroups, setClientGroups] = useState(() => splitClients([]))
  const [clients, setClients] = useState<ReadonlySet<string>>(() => new Set(FALLBACK_CLIENTS))
  const clientsTouched = useRef(false)
  const [fileModes, setFileModes] = useState<Record<string, FileMode>>({})
  const [plan, setPlan] = useState<ProjectCreatePlan | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [errors, setErrors] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const run = useProjectCreateRun()

  const location = { mode, path, parent, name, gitInit }
  const locationReady = mode === 'empty' ? parent !== '' && FOLDER_NAME.test(name) : path !== ''
  const check = useLocationCheck(location, locationReady, recheck)
  const root = mode === 'empty' ? joinPath(parent, name) : path
  const files = filesForClients(clients, selected.length > 0)
  const enabledClients = [...clients].sort()
  const dirty = path !== '' || parent !== '' || name !== '' || selected.length > 0

  useEffect(() => {
    const controller = new AbortController()
    fetchTemplates(controller.signal).then((list) => setTemplates(list.templates)).catch((error: unknown) => {
      if (!controller.signal.aborted) setErrorKey(instructionErrorKey(error))
    })
    // 检测失败就保留默认的两个客户端，不打断向导。
    fetchHostTargetDetection(controller.signal).then((detection) => {
      const groups = splitClients(detection.detected_hosts)
      setClientGroups(groups)
      if (!clientsTouched.current) setClients(new Set(groups.primary.map((client) => client.id)))
    }).catch(() => undefined)
    return () => controller.abort()
  }, [])

  // 执行前的位置类失败：回到「位置」，重查并定位字段。
  useEffect(() => {
    if (run.status !== 'failed' || run.errorKey === null || !LOCATION_ERRORS.has(run.errorKey)) return
    setView('wizard')
    setStep('location')
    setRecheck((value) => value + 1)
    setFocus(run.errorKey === 'project_path_exists' || run.errorKey === 'invalid_path' ? 'name' : null)
  }, [run.status, run.errorKey])

  const capture = (error: unknown): void => {
    setErrorKey(instructionErrorKey(error))
    setErrors(error instanceof InstructionApiError ? error.errors : [])
  }
  const clearError = (): void => {
    setErrorKey(null)
    setErrors([])
  }
  /** 任何前面步骤的输入变化都作废预检。 */
  const invalidate = (): void => {
    setPlan(null)
    clearError()
  }

  const loadDocument = (selection: TemplateSelection): void => {
    const key = selectionKey(selection)
    if (documents[key] !== undefined) return
    fetchTemplate(selection).then((document) => setDocuments((current) => ({ ...current, [key]: document }))).catch(capture)
  }

  /** 按当前输入拼正文并组装请求；预检（forCreate=false）保留跳过的文件用于显示。 */
  const buildInput = async (forCreate: boolean): Promise<ReturnType<typeof projectInput>> => {
    const composed = await composeFor(mode === 'empty' ? name : basename(path), selected, values)
    const instructions = files.targets.length === 0 ? null : instructionsInput(files, composed.markdown, fileModes, forCreate)
    // 一个客户端都没选时不写 clients.json（「只登记」不产生任何文件）。
    return projectInput(location, mode === 'empty' ? composed.directories : [], instructions, enabledClients.length > 0 ? enabledClients : undefined)
  }

  /** 确认步的预检：进入确认、以及改动文件处理方式时自动执行。 */
  const precheck = async (): Promise<void> => {
    setBusy(true)
    clearError()
    try {
      setPlan(await planProjectCreate(await buildInput(false)))
    } catch (error) {
      capture(error)
      setPlan(null)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (view === 'wizard' && step === 'confirm') void precheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进入确认与处理方式变化时预检
  }, [view, step, fileModes])

  /** 执行：重新拼正文并 dry run 拿最新摘要（重试时已写入的文件变成「不变」）。 */
  const create = (): void => {
    setView('progress')
    void run.start(async () => {
      const draft = await buildInput(true)
      if (draft.instructions === null) return draft
      const fresh = await planProjectCreate(draft)
      return { ...draft, instructions: { ...draft.instructions, base_digests: Object.fromEntries(fresh.files.map((file) => [file.id, file.base_digest])) } }
    })
  }

  const blocked = check.status !== 'ok' || check.plan?.registration === 'already'
  const nextDisabled = busy || (step === 'location' && (!locationReady || blocked)) || (step === 'confirm' && plan === null)
  const at = WIZARD_STEPS.indexOf(step)
  const next = (): void => {
    if (nextDisabled) return
    clearError()
    if (step === 'confirm') create()
    else setStep(WIZARD_STEPS[at + 1] ?? 'confirm')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || view !== 'wizard') return
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement) return
    event.preventDefault()
    next()
  }
  const running = view === 'progress' && run.status === 'running'
  const requestClose = (): void => {
    if (running) return
    if (dirty && run.status !== 'done') setDiscarding(true)
    else onClose()
  }
  const failedRow = run.rows.find((row) => row.state === 'failed')
  const editStep: WizardStep = failedRow?.id === 'directory' || failedRow?.id === 'git' ? 'location' : 'confirm'

  // 成功后停在进度页，让每一步的结果可见；由用户点「打开项目」切过去。
  const created = run.status === 'done' ? run.created : null
  const actions = created !== null ? (
    <>
      <button type="button" className={BUTTON_GHOST} data-testid="np-finish" onClick={onClose}>{t('projects.finish')}</button>
      <button type="button" className={BUTTON_SOLID} data-testid="np-open" onClick={() => onCreated(created.root)}>{t('projects.open_project')}</button>
    </>
  ) : view === 'progress' ? (
    <button type="button" className={BUTTON_GHOST} disabled={running} data-testid="np-back" onClick={() => { setView('wizard'); setStep(editStep) }}>
      {t('projects.edit_step')}
    </button>
  ) : (
    <>
      {at === 0
        ? <button type="button" className={BUTTON_GHOST} data-testid="np-cancel" onClick={requestClose}>{t('projects.cancel')}</button>
        : <button type="button" className={BUTTON_GHOST} disabled={busy} data-testid="np-back" onClick={() => { clearError(); setStep(WIZARD_STEPS[at - 1] ?? 'location') }}>{t('projects.back')}</button>}
      <button type="button" className={BUTTON_SOLID} disabled={nextDisabled} aria-busy={busy || undefined} data-testid="np-next" onClick={next}>
        {t(step === 'confirm' ? 'projects.create' : 'projects.next')}
      </button>
    </>
  )

  return (
    <>
      <Dialog title={t('projects.new_project')} onClose={requestClose} testid="np-dialog" panelClassName="w-[min(640px,92vw)]" actions={actions}>
        <div className="grid gap-4" onKeyDown={onKeyDown}>
          {view === 'wizard' && <WizardSteps current={step} onBack={(target) => { clearError(); setStep(target) }} />}
          <div key={view === 'wizard' ? step : 'progress'} className={`h-96 overflow-y-auto ${STEP_MOTION}`} data-testid="np-body">
            {view === 'progress' && (
              <CreateProgress run={run} root={root} rolledBack={mode === 'empty' && failedRow !== undefined && failedRow.id !== 'directory'} onRetry={create} />
            )}
            {view === 'wizard' && step === 'location' && (
              <LocationStep
                mode={mode}
                onMode={(value) => { setMode(value); invalidate() }}
                path={path}
                onPath={(value) => { setPath(value); setFileModes({}); invalidate() }}
                parent={parent}
                onParent={(value) => { setParent(value); invalidate() }}
                name={name}
                onName={(value) => { setName(value); setFocus(null); invalidate() }}
                gitInit={gitInit}
                onGitInit={(value) => { setGitInit(value); invalidate() }}
                check={check}
                onOpen={onOpen}
                focus={focus}
              />
            )}
            {view === 'wizard' && step === 'templates' && (
              <TemplateStep
                templates={templates}
                selected={selected}
                focused={focused}
                documents={documents}
                values={values}
                onFocus={(selection) => { setFocused(selection); loadDocument(selection) }}
                onToggle={(selection) => {
                  const key = selectionKey(selection)
                  invalidate()
                  setSelected((current) => (current.some((item) => selectionKey(item) === key)
                    ? current.filter((item) => selectionKey(item) !== key)
                    : [...current, selection]))
                }}
                onValue={(key, value) => { invalidate(); setValues((current) => ({ ...current, [key]: value })) }}
              />
            )}
            {view === 'wizard' && step === 'clients' && (
              <ClientStep
                primary={clientGroups.primary}
                more={clientGroups.more}
                selected={clients}
                onToggle={(id) => {
                  clientsTouched.current = true
                  invalidate()
                  setClients((current) => {
                    const nextSet = new Set(current)
                    if (nextSet.has(id)) nextSet.delete(id)
                    else nextSet.add(id)
                    return nextSet
                  })
                }}
              />
            )}
            {view === 'wizard' && step === 'confirm' && plan === null && busy && (
              <LoaderCircle className="mx-auto mt-10 size-5 animate-spin text-text-3 motion-reduce:animate-none" aria-label={t('common.loading')} />
            )}
            {view === 'wizard' && step === 'confirm' && plan !== null && (
              <ConfirmStep plan={plan} mode={mode} clients={enabledClients} fileModes={fileModes} onFileMode={(file, value) => setFileModes((current) => ({ ...current, [file]: value }))} />
            )}
          </div>
          {view === 'wizard' && errorKey !== null && (
            <div className="grid gap-1 rounded-md border border-red-b bg-red-t px-4 py-3" role="alert" data-testid="np-error">
              <span className="text-body font-semibold text-red-d">{t(`projects.errors.${errorKey}`)}</span>
              {errors.map((message) => <span key={message} className="font-mono text-caption text-red-d">{message}</span>)}
            </div>
          )}
        </div>
      </Dialog>
      {discarding && (
        <Dialog
          title={t('projects.discard_title')}
          role="alertdialog"
          onClose={() => setDiscarding(false)}
          testid="np-discard"
          actions={(
            <>
              <button type="button" className={BUTTON_GHOST} data-testid="np-discard-keep" onClick={() => setDiscarding(false)}>{t('projects.keep_editing')}</button>
              <button type="button" className={BUTTON_DANGER} data-testid="np-discard-confirm" onClick={onClose}>{t('projects.discard')}</button>
            </>
          )}
        >
          {null}
        </Dialog>
      )}
    </>
  )
}
