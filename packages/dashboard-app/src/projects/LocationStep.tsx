import { useT } from '../i18n'
import { FIELD_LABEL, INPUT } from '../shared/uiRecipes'
import { FolderField } from './FolderField'
import { FOLDER_NAME, joinPath, type LocationMode } from './newProjectModel'

export interface LocationStepProps {
  mode: LocationMode
  onMode: (mode: LocationMode) => void
  path: string
  onPath: (path: string) => void
  parent: string
  onParent: (path: string) => void
  name: string
  onName: (name: string) => void
  /** 已有目录已登记为项目时为 true。 */
  registered: boolean
}

const MODES: readonly { id: LocationMode; label: string }[] = [
  { id: 'existing', label: 'projects.add_existing' },
  { id: 'empty', label: 'projects.mode_empty' },
]

/** 位置：添加已有目录 / 新建目录（父目录 + 文件夹名，下方预览最终路径）。路径只能「选择」，不能手输。 */
export function LocationStep({ mode, onMode, path, onPath, parent, onParent, name, onName, registered }: LocationStepProps): JSX.Element {
  const { t } = useT()
  const nameInvalid = name !== '' && !FOLDER_NAME.test(name)
  const finalPath = parent !== '' && name !== '' ? joinPath(parent, name) : ''
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
          {registered && (
            <p className="flex items-center gap-2 text-caption text-text-2" data-testid="np-registered">
              <span className="size-2 flex-none rounded-full bg-(--accent)" aria-hidden="true" />
              {t('projects.registered')}
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          <div className={FIELD_LABEL}>
            <span>{t('projects.parent')}</span>
            <FolderField value={parent} onChange={onParent} prompt={t('projects.pick_parent_title')} testId="np-parent" />
          </div>
          <label className={FIELD_LABEL}>
            {t('projects.folder_name')}
            <input
              className={`${INPUT} max-w-72`}
              value={name}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameInvalid || undefined}
              data-testid="np-name"
              onChange={(event) => onName(event.target.value.trim())}
            />
          </label>
          {nameInvalid && <p className="text-caption text-red-d" role="alert" data-testid="np-name-error">{t('projects.errors.invalid_path')}</p>}
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
