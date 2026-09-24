import { useEffect, useState } from 'react'
import { ArrowUp, Eye, EyeOff, Folder, House } from 'lucide-react'
import { useT } from '../i18n'
import { listFolders, type FolderListing } from '../api/fsClient'
import { instructionErrorKey } from '../api/instructionErrorKey'
import { isAbortError } from '../api/transport'
import { BUTTON_GHOST, BUTTON_ICON, BUTTON_SOLID } from '../shared/uiRecipes'

export interface FolderBrowserProps {
  /** 起点；空串 = 主目录。 */
  initialDir: string
  onPick: (path: string) => void
  onCancel: () => void
}

/** 页面内目录浏览器（原生对话框不可用时）：逐级进入子目录，「选择」取当前目录。只列目录，不能手输路径。 */
export function FolderBrowser({ initialDir, onPick, onCancel }: FolderBrowserProps): JSX.Element {
  const { t } = useT()
  const [dir, setDir] = useState(initialDir)
  const [hidden, setHidden] = useState(false)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setErrorKey(null)
    listFolders(dir, hidden, controller.signal)
      .then(setListing)
      .catch((error: unknown) => { if (!isAbortError(error)) setErrorKey(instructionErrorKey(error)) })
    return () => controller.abort()
  }, [dir, hidden])

  const current = listing?.dir ?? dir
  return (
    <div className="grid gap-2 rounded-md border border-border bg-card p-2" data-testid="np-browser">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={BUTTON_ICON}
          aria-label={t('projects.folder_up')}
          title={t('projects.folder_up')}
          disabled={listing?.parent === null || listing === null}
          data-testid="np-browser-up"
          onClick={() => { if (listing?.parent) setDir(listing.parent) }}
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={BUTTON_ICON}
          aria-label={t('projects.folder_home')}
          title={t('projects.folder_home')}
          data-testid="np-browser-home"
          onClick={() => setDir(listing?.home ?? '')}
        >
          <House className="size-4" aria-hidden="true" />
        </button>
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-caption text-text" title={current} data-testid="np-browser-dir">{current}</span>
        <button
          type="button"
          className={BUTTON_ICON}
          aria-label={t('projects.folder_hidden')}
          title={t('projects.folder_hidden')}
          aria-pressed={hidden}
          data-testid="np-browser-hidden"
          onClick={() => setHidden((value) => !value)}
        >
          {hidden ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
        </button>
      </div>
      {errorKey !== null && (
        <p className="px-2 text-caption text-red-d" role="alert" data-testid="np-browser-error">{t(`projects.errors.${errorKey}`)}</p>
      )}
      <ul className="grid max-h-60 min-h-24 content-start gap-0.5 overflow-y-auto" aria-label={t('projects.folder_list')} data-testid="np-browser-list">
        {(listing?.entries ?? []).map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className="flex min-h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-caption text-text outline-none transition-colors duration-(--dur-fast) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)"
              title={entry.path}
              data-testid={`np-browser-entry-${entry.name}`}
              onClick={() => setDir(entry.path)}
            >
              <Folder className="size-4 flex-none text-text-3" aria-hidden="true" />
              <span className="truncate">{entry.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON_GHOST} data-testid="np-browser-cancel" onClick={onCancel}>{t('projects.cancel')}</button>
        <button type="button" className={BUTTON_SOLID} disabled={listing === null} data-testid="np-browser-pick" onClick={() => { if (listing) onPick(listing.dir) }}>
          {t('projects.select')}
        </button>
      </div>
    </div>
  )
}
