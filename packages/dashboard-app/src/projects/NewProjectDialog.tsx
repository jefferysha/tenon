import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { instructionErrorKey } from '../api/instructionErrorKey'
import {
  composeInstructions, createProject, fetchTemplate, fetchTemplates, planProjectCreate,
  type ProjectCreateInput,
} from '../api/instructionsClient'
import { InstructionApiError } from '../api/instructionsClient'
import {
  PROJECT_INSTRUCTION_FILES, type ComposedDirectory, type ProjectCreatePlan, type TemplateSummary, type TemplateVariable,
} from '../api/instructionsDecoders'
import { Dialog } from '../shared/Dialog'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_GHOST, BUTTON_SOLID, FIELD_LABEL, INPUT } from '../shared/uiRecipes'
import { TemplatePicker, selectionKey, type TemplateSelection } from './TemplatePicker'

type Tab = 'directory' | 'templates' | 'files' | 'preview'
type Mode = 'existing' | 'empty'

const basename = (value: string): string => value.split('/').filter(Boolean).pop() ?? ''

/** 新建项目：选目录 → 选模板 → 选文件 → 预览差异 → 创建（dry run 先算计划，确认后才落盘）。 */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (root: string) => void }): JSX.Element {
  const { t } = useT()
  const [tab, setTab] = useState<Tab>('directory')
  const [mode, setMode] = useState<Mode>('existing')
  const [path, setPath] = useState('')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [templates, setTemplates] = useState<readonly TemplateSummary[]>([])
  const [selected, setSelected] = useState<readonly TemplateSelection[]>([])
  const [variablesByKey, setVariablesByKey] = useState<Record<string, readonly TemplateVariable[]>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<readonly string[]>(['CLAUDE.md', 'AGENTS.md'])
  const [markdown, setMarkdown] = useState('')
  const [directories, setDirectories] = useState<readonly ComposedDirectory[]>([])
  const [plan, setPlan] = useState<ProjectCreatePlan | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [errors, setErrors] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        setTemplates((await fetchTemplates()).templates)
      } catch (error) {
        setErrorKey(instructionErrorKey(error))
      }
    })()
  }, [])

  const projectName = mode === 'empty' ? name : basename(path)
  const ready = mode === 'empty' ? parent !== '' && name !== '' : path !== ''
  const tabs: SheetDef<Tab>[] = [
    { id: 'directory', label: t('projects.directories') },
    { id: 'templates', label: t('projects.templates'), count: selected.length },
    { id: 'files', label: t('projects.file'), count: files.length },
    { id: 'preview', label: t('projects.preview') },
  ]

  const input = useMemo((): ProjectCreateInput => {
    const instructions = files.length === 0 || markdown === ''
      ? null
      : {
          text: markdown,
          targets: [...files],
          base_digests: Object.fromEntries((plan?.files ?? []).map((file) => [file.id, file.base_digest])),
        }
    return mode === 'empty'
      ? { mode: 'empty', parent, name, directories: directories.map((entry) => entry.path), instructions }
      : { mode: 'existing', path, instructions }
  }, [directories, files, markdown, mode, name, parent, path, plan])

  const capture = (error: unknown): void => {
    setErrorKey(instructionErrorKey(error))
    setErrors(error instanceof InstructionApiError ? error.errors : [])
  }

  const toggle = (selection: TemplateSelection): void => {
    const key = selectionKey(selection)
    if (selected.some((item) => selectionKey(item) === key)) {
      setSelected((current) => current.filter((item) => selectionKey(item) !== key))
      return
    }
    setSelected((current) => [...current, selection])
    void (async () => {
      try {
        const document = await fetchTemplate(selection)
        setVariablesByKey((current) => ({ ...current, [key]: document.block?.variables ?? [] }))
      } catch (error) {
        capture(error)
      }
    })()
  }

  /** 进入预览：先按所选块拼出正文，再要一次 dry run 计划。 */
  const refreshPreview = async (): Promise<void> => {
    setBusy(true)
    setErrorKey(null)
    setErrors([])
    try {
      const composed = await composeInstructions(projectName, selected.map((item) => ({
        ...item,
        values: Object.fromEntries(Object.entries(values)
          .filter(([key]) => key.startsWith(`${selectionKey(item)}::`))
          .map(([key, value]) => [key.slice(`${selectionKey(item)}::`.length), value])),
      })))
      setMarkdown(composed.markdown)
      setDirectories(composed.directories)
      const instructions = files.length === 0
        ? null
        : { text: composed.markdown, targets: [...files], base_digests: {} }
      const planned = await planProjectCreate(mode === 'empty'
        ? { mode: 'empty', parent, name, directories: composed.directories.map((entry) => entry.path), instructions }
        : { mode: 'existing', path, instructions })
      setPlan(planned)
    } catch (error) {
      capture(error)
      setPlan(null)
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setErrorKey(null)
    try {
      const created = await createProject(input)
      onCreated(created.root)
    } catch (error) {
      capture(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('projects.new_project')}
      onClose={onClose}
      testid="np-dialog"
      variant="workspace"
      actions={(
        <>
          <button type="button" className={BUTTON_GHOST} data-testid="np-cancel" onClick={onClose}>
            {t('projects.cancel')}
          </button>
          <button
            type="button"
            className={BUTTON_SOLID}
            data-testid="np-create"
            disabled={!ready || busy || plan === null}
            onClick={() => { void create() }}
          >
            {t('projects.create')}
          </button>
        </>
      )}
    >
      <div className="grid gap-4">
        <SheetTabs
          sheets={tabs}
          active={tab}
          ariaLabel={t('projects.new_project')}
          idPrefix="np"
          onChange={(next) => {
            setTab(next)
            if (next === 'preview' && ready) void refreshPreview()
          }}
        />
        {errorKey !== null && (
          <div className="grid gap-1 rounded-md border border-red-b bg-red-t px-4 py-3" role="alert" data-testid="np-error">
            <span className="text-body font-semibold text-red-d">{t(`projects.errors.${errorKey}`)}</span>
            {errors.map((message) => (
              <span key={message} className="font-mono text-caption text-red-d">{message}</span>
            ))}
          </div>
        )}
        {tab === 'directory' && (
          <div className="grid gap-3" data-testid="np-directory">
            <div role="radiogroup" aria-label={t('projects.directories')} className="flex gap-2">
              {(['existing', 'empty'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  className="rounded-md border border-border px-3 py-2 text-caption whitespace-nowrap text-text-2 aria-checked:border-accent-b aria-checked:bg-accent-t aria-checked:text-(--accent)"
                  data-testid={`np-mode-${value}`}
                  onClick={() => setMode(value)}
                >
                  {t(value === 'existing' ? 'projects.mode_existing' : 'projects.mode_empty')}
                </button>
              ))}
            </div>
            {mode === 'existing' ? (
              <label className={FIELD_LABEL}>
                {t('projects.path')}
                <input className={INPUT} value={path} autoComplete="off" spellCheck={false} data-testid="np-path" onChange={(event) => setPath(event.target.value)} />
              </label>
            ) : (
              <>
                <label className={FIELD_LABEL}>
                  {t('projects.parent')}
                  <input className={INPUT} value={parent} autoComplete="off" spellCheck={false} data-testid="np-parent" onChange={(event) => setParent(event.target.value)} />
                </label>
                <label className={FIELD_LABEL}>
                  {t('projects.name')}
                  <input className={INPUT} value={name} autoComplete="off" spellCheck={false} data-testid="np-name" onChange={(event) => setName(event.target.value)} />
                </label>
              </>
            )}
          </div>
        )}
        {tab === 'templates' && (
          <TemplatePicker
            templates={templates}
            selected={selected}
            variablesByKey={variablesByKey}
            values={values}
            onToggle={toggle}
            onValue={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
          />
        )}
        {tab === 'files' && (
          <ul className="grid gap-1" data-testid="np-files">
            {PROJECT_INSTRUCTION_FILES.map((file) => (
              <li key={file}>
                <label className="flex items-center gap-3 rounded-md px-3 py-2 whitespace-nowrap hover:bg-fill">
                  <input
                    type="checkbox"
                    className="size-4 accent-(--accent)"
                    checked={files.includes(file)}
                    data-testid={`np-file-${file}`}
                    onChange={() => setFiles((current) => (current.includes(file) ? current.filter((item) => item !== file) : [...current, file]))}
                  />
                  <span className="font-mono text-caption text-text">{file}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {tab === 'preview' && (
          <div className="grid gap-3" data-testid="np-preview">
            {directories.length > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="np-preview-directories">
                {directories.map((entry) => (
                  <span key={entry.path} className="rounded-full bg-fill px-2.5 py-1 font-mono text-micro whitespace-nowrap text-text-2">{entry.path}</span>
                ))}
              </div>
            )}
            {plan !== null && (
              <table className="w-full table-fixed border-collapse text-base" data-testid="np-preview-files">
                <thead>
                  <tr className="border-b border-border text-caption text-text-3">
                    <th scope="col" className="py-2 text-left font-semibold">{t('projects.file')}</th>
                    <th scope="col" className="py-2 text-left font-semibold">{t('projects.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.files.map((file) => (
                    <tr key={file.id} className="border-b border-border" data-testid={`np-plan-${file.id}`}>
                      <td className="py-2 font-mono text-caption whitespace-nowrap text-text">{file.id}</td>
                      <td className="py-2 text-caption whitespace-nowrap text-text-2">
                        {t(file.current === null ? 'projects.change_new' : file.current === file.next ? 'projects.change_same' : 'projects.change_modify')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Markdown text={markdown} testId="np-preview-markdown" density="compact" />
          </div>
        )}
      </div>
    </Dialog>
  )
}
