import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { fetchHostTargetDetection } from '../api/hostTargetPlanClient'
import { instructionErrorKey } from '../api/instructionErrorKey'
import {
  InstructionApiError, composeInstructions, fetchTemplate, fetchTemplates, planProjectCreate,
  type ProjectCreateInput, type ProjectInstructionsInput,
} from '../api/instructionsClient'
import type { ComposedDirectory, ProjectCreatePlan, TemplateSummary, TemplateVariable } from '../api/instructionsDecoders'
import { Dialog } from '../shared/Dialog'
import { BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'
import { ClientStep } from './ClientStep'
import { ConfirmStep } from './ConfirmStep'
import { CreateProgress } from './CreateProgress'
import { LocationStep } from './LocationStep'
import { TemplatePicker, selectionKey, type TemplateSelection } from './TemplatePicker'
import { WizardSteps } from './WizardSteps'
import {
  FALLBACK_CLIENTS, FOLDER_NAME, WIZARD_STEPS, basename, filesForClients, joinPath, splitClients,
  type LocationMode, type WizardStep,
} from './newProjectModel'
import { useProjectCreateRun } from './useProjectCreateRun'

/* 步骤切换：180ms 淡入 + 4px 上移；reduced-motion 只留淡入。 */
const STEP_MOTION = 'animate-in fade-in-0 slide-in-from-bottom-1 duration-(--dur-base) ease-(--ease-out) motion-reduce:slide-in-from-bottom-0'

export interface NewProjectDialogProps {
  onClose: () => void
  /** 「打开项目」：切到新项目。 */
  onCreated: (root: string) => void
}

/** 新建项目向导：位置 → 模板 → 客户端 → 确认；「创建」后同一对话框切到逐步进度。 */
export function NewProjectDialog({ onClose, onCreated }: NewProjectDialogProps): JSX.Element {
  const { t } = useT()
  const [view, setView] = useState<'wizard' | 'progress'>('wizard')
  const [step, setStep] = useState<WizardStep>('location')
  const [mode, setMode] = useState<LocationMode>('existing')
  const [path, setPath] = useState('')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [registered, setRegistered] = useState(false)
  const [templates, setTemplates] = useState<readonly TemplateSummary[]>([])
  const [selected, setSelected] = useState<readonly TemplateSelection[]>([])
  const [variablesByKey, setVariablesByKey] = useState<Record<string, readonly TemplateVariable[]>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [clientGroups, setClientGroups] = useState(() => splitClients([]))
  const [clients, setClients] = useState<ReadonlySet<string>>(() => new Set(FALLBACK_CLIENTS))
  const clientsTouched = useRef(false)
  const [markdown, setMarkdown] = useState('')
  const [directories, setDirectories] = useState<readonly ComposedDirectory[]>([])
  const [plan, setPlan] = useState<ProjectCreatePlan | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [errors, setErrors] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const run = useProjectCreateRun()

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

  const root = mode === 'empty' ? joinPath(parent, name) : path
  const files = filesForClients(clients)
  const locationReady = mode === 'empty' ? parent !== '' && FOLDER_NAME.test(name) : path !== ''

  const inputFor = (instructions: ProjectInstructionsInput | null, override: { path?: string } = {}): ProjectCreateInput => (mode === 'empty'
    ? { mode: 'empty', parent, name, directories: directories.map((entry) => entry.path), instructions }
    : { mode: 'existing', path: override.path ?? path, instructions })
  const enabledClients = [...clients].sort()

  const capture = (error: unknown): void => {
    setErrorKey(instructionErrorKey(error))
    setErrors(error instanceof InstructionApiError ? error.errors : [])
  }
  const clearError = (): void => {
    setErrorKey(null)
    setErrors([])
  }

  /** 位置校验：只 dry run 目录本身（不带指令文件与骨架目录）。 */
  const checkLocation = async (input: ProjectCreateInput): Promise<boolean> => {
    setBusy(true)
    clearError()
    try {
      const checked = await planProjectCreate(input.mode === 'empty' ? { ...input, directories: [] } : input)
      setRegistered(input.mode === 'existing' && checked.registration === 'already')
      return true
    } catch (error) {
      capture(error)
      return false
    } finally {
      setBusy(false)
    }
  }

  const resetLocation = (): void => {
    setPlan(null)
    setRegistered(false)
    clearError()
  }

  const toggleTemplate = (selection: TemplateSelection): void => {
    const key = selectionKey(selection)
    if (selected.some((item) => selectionKey(item) === key)) {
      setSelected((current) => current.filter((item) => selectionKey(item) !== key))
      return
    }
    setSelected((current) => [...current, selection])
    fetchTemplate(selection)
      .then((document) => setVariablesByKey((current) => ({ ...current, [key]: document.block?.variables ?? [] })))
      .catch(capture)
  }

  /** 进入确认：按所选模板拼出正文，再带上指令文件与骨架目录要一次完整 dry run。 */
  const enterConfirm = async (): Promise<void> => {
    setBusy(true)
    clearError()
    try {
      const composed = await composeInstructions(mode === 'empty' ? name : basename(path), selected.map((item) => ({
        ...item,
        values: Object.fromEntries(Object.entries(values)
          .filter(([key]) => key.startsWith(`${selectionKey(item)}::`))
          .map(([key, value]) => [key.slice(`${selectionKey(item)}::`.length), value])),
      })))
      setMarkdown(composed.markdown)
      setDirectories(composed.directories)
      const instructions = files.length === 0 ? null : { text: composed.markdown, targets: [...files], base_digests: {} }
      setPlan(await planProjectCreate(mode === 'empty'
        ? { mode: 'empty', parent, name, directories: composed.directories.map((entry) => entry.path), instructions }
        : { mode: 'existing', path, instructions }))
      setStep('confirm')
    } catch (error) {
      capture(error)
    } finally {
      setBusy(false)
    }
  }

  /** 执行前重新 dry run，拿到最新的文件摘要（重试时已写入的文件变成「不变」）。 */
  const create = (): void => {
    setView('progress')
    void run.start(async () => {
      const draft = { ...inputFor(files.length === 0 || markdown === '' ? null : { text: markdown, targets: [...files], base_digests: {} }), clients: enabledClients }
      const fresh = await planProjectCreate(draft)
      if (draft.instructions === null) return draft
      return { ...draft, instructions: { ...draft.instructions, base_digests: Object.fromEntries(fresh.files.map((file) => [file.id, file.base_digest])) } }
    })
  }

  const next = async (): Promise<void> => {
    if (step === 'location') {
      if (await checkLocation(inputFor(null))) setStep('templates')
    } else if (step === 'templates') {
      setStep('clients')
    } else if (step === 'clients') {
      await enterConfirm()
    } else {
      create()
    }
  }

  const at = WIZARD_STEPS.indexOf(step)
  const nextDisabled = busy || (step === 'location' && !locationReady) || (step === 'confirm' && plan === null)
  const running = view === 'progress' && run.status === 'running'

  const actions = view === 'progress' ? (
    run.status === 'done' && run.created !== null ? (
      <>
        <button type="button" className={BUTTON_GHOST} data-testid="np-finish" onClick={onClose}>{t('projects.finish')}</button>
        <button type="button" className={BUTTON_SOLID} data-testid="np-open" onClick={() => { if (run.created) onCreated(run.created.root) }}>{t('projects.open_project')}</button>
      </>
    ) : (
      <button type="button" className={BUTTON_GHOST} disabled={running} data-testid="np-back" onClick={() => setView('wizard')}>{t('projects.back')}</button>
    )
  ) : (
    <>
      {at === 0
        ? <button type="button" className={BUTTON_GHOST} data-testid="np-cancel" onClick={onClose}>{t('projects.cancel')}</button>
        : <button type="button" className={BUTTON_GHOST} disabled={busy} data-testid="np-back" onClick={() => { clearError(); setStep(WIZARD_STEPS[at - 1] ?? 'location') }}>{t('projects.back')}</button>}
      <button type="button" className={BUTTON_SOLID} disabled={nextDisabled} aria-busy={busy || undefined} data-testid="np-next" onClick={() => { void next() }}>
        {t(step === 'confirm' ? 'projects.create' : 'projects.next')}
      </button>
    </>
  )

  return (
    <Dialog
      title={t('projects.new_project')}
      onClose={() => { if (!running) onClose() }}
      testid="np-dialog"
      panelClassName="w-[min(640px,92vw)]"
      actions={actions}
    >
      <div className="grid gap-5">
        {view === 'wizard' && <WizardSteps current={step} onBack={(target) => { clearError(); setStep(target) }} />}
        <div key={view === 'wizard' ? step : 'progress'} className={`min-h-64 ${STEP_MOTION}`}>
          {view === 'progress' && <CreateProgress run={run} root={root} onRetry={create} />}
          {view === 'wizard' && step === 'location' && (
            <LocationStep
              mode={mode}
              onMode={(value) => { setMode(value); resetLocation() }}
              path={path}
              onPath={(value) => { setPath(value); resetLocation(); void checkLocation(inputFor(null, { path: value })) }}
              parent={parent}
              onParent={(value) => { setParent(value); resetLocation() }}
              name={name}
              onName={(value) => { setName(value); resetLocation() }}
              registered={registered}
            />
          )}
          {view === 'wizard' && step === 'templates' && (
            <TemplatePicker
              templates={templates}
              selected={selected}
              variablesByKey={variablesByKey}
              values={values}
              onToggle={toggleTemplate}
              onValue={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
            />
          )}
          {view === 'wizard' && step === 'clients' && (
            <ClientStep
              primary={clientGroups.primary}
              more={clientGroups.more}
              selected={clients}
              onToggle={(id) => {
                clientsTouched.current = true
                setClients((current) => {
                  const nextSet = new Set(current)
                  if (nextSet.has(id)) nextSet.delete(id)
                  else nextSet.add(id)
                  return nextSet
                })
              }}
            />
          )}
          {view === 'wizard' && step === 'confirm' && plan !== null && <ConfirmStep plan={plan} mode={mode} clients={enabledClients} />}
        </div>
        {view === 'wizard' && errorKey !== null && (
          <div className="grid gap-1 rounded-md border border-red-b bg-red-t px-4 py-3" role="alert" data-testid="np-error">
            <span className="text-body font-semibold text-red-d">{t(`projects.errors.${errorKey}`)}</span>
            {errors.map((message) => <span key={message} className="font-mono text-caption text-red-d">{message}</span>)}
          </div>
        )}
      </div>
    </Dialog>
  )
}
