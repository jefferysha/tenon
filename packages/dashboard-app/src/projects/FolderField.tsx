import { useState } from 'react'
import { Folder, LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import { chooseFolder } from '../api/fsClient'
import { instructionErrorKey } from '../api/instructionErrorKey'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { FolderBrowser } from './FolderBrowser'

export interface FolderFieldProps {
  value: string
  onChange: (path: string) => void
  /** 系统对话框的提示语。 */
  prompt: string
  testId: string
}

/**
 * 选择文件夹：点「选择文件夹…」由本机 server 调起系统原生对话框；对话框不可用（无图形界面、远程）时
 * 改为页面内目录浏览器，之后也一直用浏览器。选中后显示一行路径（截断 + title）与「更换」。
 */
export function FolderField({ value, onChange, prompt, testId }: FolderFieldProps): JSX.Element {
  const { t } = useT()
  const [picking, setPicking] = useState(false)
  const [nativeUnavailable, setNativeUnavailable] = useState(false)
  const [browsing, setBrowsing] = useState(false)
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

  return (
    <div className="grid gap-1.5">
      {value === '' ? (
        <button
          type="button"
          className={`${BUTTON_GHOST} justify-start`}
          disabled={picking}
          aria-busy={picking || undefined}
          data-testid={`${testId}-choose`}
          onClick={() => { void pick() }}
        >
          {picking
            ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <Folder className="size-4" aria-hidden="true" />}
          {t('projects.choose_folder')}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-sm border border-border bg-card px-3">
            <Folder className="size-4 flex-none text-text-3" aria-hidden="true" />
            <span className="truncate font-mono text-caption text-text" title={value} data-testid={`${testId}-path`}>{value}</span>
          </div>
          <button type="button" className={BUTTON_GHOST} disabled={picking} aria-busy={picking || undefined} data-testid={`${testId}-change`} onClick={() => { void pick() }}>
            {picking && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {t('projects.change')}
          </button>
        </div>
      )}
      {errorKey !== null && <p className="text-caption text-red-d" role="alert" data-testid={`${testId}-error`}>{t(`projects.errors.${errorKey}`)}</p>}
    </div>
  )
}
