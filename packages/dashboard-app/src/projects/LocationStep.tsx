import { useEffect, useRef } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import { FIELD_LABEL, INPUT } from '../shared/uiRecipes'
import { FolderField } from './FolderField'
import { FOLDER_NAME, joinPath, type LocationMode } from './newProjectModel'
import type { LocationCheck } from './useLocationCheck'

export interface LocationStepProps {
  mode: LocationMode
  onMode: (mode: LocationMode) => void
  path: string
  onPath: (path: string) => void
  parent: string
  onParent: (path: string) => void
  name: string
  onName: (name: string) => void
  gitInit: boolean
  onGitInit: (value: boolean) => void
  check: LocationCheck
  /** 已登记的目录：「打开」直接切到该项目。 */
  onOpen: (root: string) => void
  /** 执行失败退回时聚焦的字段。 */
  focus: 'name' | 'folder' | null
}

const MODES: readonly { id: LocationMode; label: string }[] = [
  { id: 'existing', label: 'projects.add_existing' },
  { id: 'empty', label: 'projects.mode_empty' },
]

/** 名称相关的错误显示在文件夹名下，其余显示在文件夹下。 */
const NAME_ERRORS = new Set(['project_path_exists', 'invalid_path'])

function CheckStatus({ check, testId }: { check: LocationCheck; testId: string }): JSX.Element | null {
  const { t } = useT()
  if (check.status === 'checking') {
    return <LoaderCircle className="size-4 animate-spin text-text-3 motion-reduce:animate-none" aria-label={t('projects.state_running')} data-testid={`${testId}-checking`} />
  }
  if (check.status === 'error' && check.errorKey !== null) {
    return <p className="text-caption text-red-d" role="alert" data-testid={`${testId}-check-error`}>{t(`projects.errors.${check.errorKey}`)}</p>
  }
  return null
}

/** 位置：添加已有目录 / 新建目录（父目录 + 文件夹名，下方预览最终路径）。字段下方即时显示校验结果。 */
export function LocationStep(props: LocationStepProps): JSX.Element {
  const { mode, onMode, path, onPath, parent, onParent, name, onName, gitInit, onGitInit, check, onOpen, focus } = props
  const { t } = useT()
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focus === 'name') nameRef.current?.focus() }, [focus])
  const nameInvalid = name !== '' && !FOLDER_NAME.test(name)
  const finalPath = parent !== '' && name !== '' ? joinPath(parent, name) : ''
  const plan = check.status === 'ok' ? check.plan : null
  const existingFiles = plan?.files.filter((file) => file.current !== null) ?? []
  const nameError = check.status === 'error' && check.errorKey !== null && NAME_ERRORS.has(check.errorKey)
  return (
    <div className="grid gap-4" data-testid="np-location">
      <div role="radiogroup" aria-label={t('projects.step_location')} className="grid grid-cols-2 gap-1 rounded-sm bg-fill p-0.5">
        {MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={mode === option.id}
            className="min-h-10 rounded-sm px-3 text-caption font-semibold whitespace-nowrap text-text-2 outline-none transition-[background-color,color,box-shadow] duration-(--dur-fast) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:bg-card aria-checked:text-text aria-checked:shadow-sm"
            data-testid={`np-mode-${option.id}`}
            onClick={() => onMode(option.id)}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
      {mode === 'existing' ? (
        <div className="grid gap-2">
          <FolderField value={path} onChange={onPath} prompt={t('projects.pick_existing_title')} testId="np-existing" />
          <CheckStatus check={check} testId="np-existing" />
          {plan?.registration === 'already' && (
            <p className="flex items-center gap-2 text-caption whitespace-nowrap text-text-2" data-testid="np-registered">
              <span className="size-2 flex-none rounded-full bg-(--accent)" aria-hidden="true" />
              {t('projects.in_list')}
              <button type="button" className="rounded-xs font-semibold text-(--accent) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid="np-registered-open" onClick={() => onOpen(plan.root)}>
                {t('projects.open')}
              </button>
            </p>
          )}
          {plan !== null && plan.registration !== 'already' && plan.git !== 'existing' && (
            <label className="flex min-h-9 cursor-pointer items-center gap-2 text-caption whitespace-nowrap text-text">
              <input type="checkbox" className="size-4 accent-(--accent)" checked={gitInit} data-testid="np-git-init" onChange={(event) => onGitInit(event.target.checked)} />
              {t('projects.action_git')}
            </label>
          )}
          {plan !== null && plan.registration !== 'already' && existingFiles.length > 0 && (
            <ul className="grid gap-1" data-testid="np-existing-files">
              {existingFiles.map((file) => (
                <li key={file.id} className="flex items-center gap-2 text-caption whitespace-nowrap" title={t('projects.keep_hint')}>
                  <span className="font-mono text-text">{file.id}</span>
                  <span className="text-text-3">{t('projects.keep')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          <div className={FIELD_LABEL}>
            <span>{t('projects.parent')}</span>
            <FolderField value={parent} onChange={onParent} prompt={t('projects.pick_parent_title')} testId="np-parent" />
            {!nameError && <CheckStatus check={check} testId="np-parent" />}
          </div>
          <label className={FIELD_LABEL}>
            {t('projects.folder_name')}
            <input
              ref={nameRef}
              className={`${INPUT} max-w-72`}
              value={name}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameInvalid || nameError || undefined}
              data-testid="np-name"
              onChange={(event) => onName(event.target.value.trim())}
            />
          </label>
          {nameInvalid && <p className="text-caption text-red-d" role="alert" data-testid="np-name-error">{t('projects.errors.invalid_path')}</p>}
          {!nameInvalid && nameError && <CheckStatus check={check} testId="np-name" />}
          {finalPath !== '' && !nameInvalid && (
            <p className="flex min-w-0 items-center gap-2 text-caption" data-testid="np-final-path">
              <span className="flex-none text-text-3">{t('projects.path')}</span>
              <span className="truncate font-mono text-text" title={finalPath}>{finalPath}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
