import { useState, type KeyboardEvent } from 'react'
import { Folder, LoaderCircle, TextCursorInput } from 'lucide-react'
import { useT } from '../i18n'
import { chooseFolder, listFolders } from '../api/fsClient'
import { instructionErrorKey } from '../api/instructionErrorKey'
import { BUTTON_GHOST, BUTTON_ICON, INPUT } from '../shared/uiRecipes'
import { FolderBrowser } from './FolderBrowser'

export interface FolderFieldProps {
  value: string
  onChange: (path: string) => void
  /** 系统对话框的提示语。 */
  prompt: string
  testId: string
}

/** `~` / `~/x` 展开为主目录；其他原样返回。 */
async function expandHome(raw: string): Promise<string> {
  if (raw !== '~' && !raw.startsWith('~/')) return raw
  const home = (await listFolders('', false)).home
  return raw === '~' ? home : `${home.replace(/\/+$/u, '')}/${raw.slice(2)}`
}

/**
 * 选择文件夹：主入口是「选择文件夹…」（本机 server 调起系统原生对话框），不可用时改为页面内目录浏览器；
 * 次要入口是输入路径（支持粘贴与 `~`），提交时由 server 核对它是已存在的目录。选中后显示一行路径与「更换」。
 */
export function FolderField({ value, onChange, prompt, testId }: FolderFieldProps): JSX.Element {
  const { t } = useT()
  const [picking, setPicking] = useState(false)
  const [nativeUnavailable, setNativeUnavailable] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [errorKey, setErrorKey] = useState<string | null>(null)

  const pick = async (): Promise<void> => {
    setErrorKey(null)
    if (nativeUnavailable) {
      setBrowsing(true)
      return
    }
    setPicking(true)
    try {
      const result = await chooseFolder(prompt, value === '' ? null : value)
      if (result.kind === 'picked') onChange(result.path)
      if (result.kind === 'unavailable') {
        setNativeUnavailable(true)
        setBrowsing(true)
      }
    } catch (error) {
      setErrorKey(instructionErrorKey(error))
    } finally {
      setPicking(false)
    }
  }

  const commitDraft = async (): Promise<void> => {
    const raw = draft.trim()
    if (raw === '') return
    setPicking(true)
    setErrorKey(null)
    try {
      const listing = await listFolders(await expandHome(raw), false)
      setTyping(false)
      setDraft('')
      onChange(listing.dir)
    } catch (error) {
      setErrorKey(instructionErrorKey(error))
    } finally {
      setPicking(false)
    }
  }

  const onDraftKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      void commitDraft()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setTyping(false)
      setErrorKey(null)
    }
  }

  if (browsing) {
    return (
      <FolderBrowser
        initialDir={value}
        onCancel={() => setBrowsing(false)}
        onPick={(path) => {
          setBrowsing(false)
          onChange(path)
        }}
      />
    )
  }

  const spinner = <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
  return (
    <div className="grid gap-1.5">
      {typing ? (
        <input
          className={`${INPUT} font-mono`}
          value={draft}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="~/"
          aria-label={t('projects.type_path')}
          aria-invalid={errorKey !== null || undefined}
          disabled={picking}
          data-testid={`${testId}-input`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onDraftKey}
          onBlur={() => { if (draft.trim() === '') setTyping(false) }}
        />
      ) : (
        <div className="flex items-center gap-2">
          {value === '' ? (
            <button
              type="button"
              className={`${BUTTON_GHOST} min-w-0 flex-1 justify-start`}
              disabled={picking}
              aria-busy={picking || undefined}
              data-testid={`${testId}-choose`}
              onClick={() => { void pick() }}
            >
              {picking ? spinner : <Folder className="size-4" aria-hidden="true" />}
              {t('projects.choose_folder')}
            </button>
          ) : (
            <>
              <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-sm border border-border bg-card px-3">
                <Folder className="size-4 flex-none text-text-3" aria-hidden="true" />
                <span className="truncate font-mono text-caption text-text" title={value} data-testid={`${testId}-path`}>{value}</span>
              </div>
              <button type="button" className={BUTTON_GHOST} disabled={picking} aria-busy={picking || undefined} data-testid={`${testId}-change`} onClick={() => { void pick() }}>
                {picking && spinner}
                {t('projects.change')}
              </button>
            </>
          )}
          <button
            type="button"
            className={BUTTON_ICON}
            aria-label={t('projects.type_path')}
            title={t('projects.type_path')}
            disabled={picking}
            data-testid={`${testId}-type`}
            onClick={() => { setErrorKey(null); setTyping(true) }}
          >
            <TextCursorInput className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
      {errorKey !== null && <p className="text-caption text-red-d" role="alert" data-testid={`${testId}-error`}>{t(`projects.errors.${errorKey}`)}</p>}
    </div>
  )
}
