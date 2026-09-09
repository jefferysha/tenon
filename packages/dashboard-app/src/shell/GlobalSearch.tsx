import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

interface GlobalSearchValue {
  readonly query: string
  readonly setQuery: (next: string) => void
  readonly inputRef: RefObject<HTMLInputElement>
}

const GlobalSearchContext = createContext<GlobalSearchValue | null>(null)

/**
 * 顶部条搜索框的共享状态：输入框住在 TopBar，过滤逻辑住在当前视图（任务 / 阶段 / 运行 / 适配器
 * 各自按 query 过滤自己的列表）。`/` 在非输入态聚焦搜索框，Esc 清空并离焦。
 */
export function GlobalSearchProvider({ children }: { children: ReactNode }): JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      const editing = target instanceof HTMLElement
        && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
      if (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (event.key === 'Escape' && target === inputRef.current) {
        setQuery('')
        inputRef.current?.blur()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const value = useMemo(() => ({ query, setQuery, inputRef }), [query])
  return <GlobalSearchContext.Provider value={value}>{children}</GlobalSearchContext.Provider>
}

export function useGlobalSearch(): GlobalSearchValue {
  const value = useContext(GlobalSearchContext)
  if (value === null) {
    throw new Error('useGlobalSearch must be used within GlobalSearchProvider')
  }
  return value
}

/** 大小写不敏感的包含匹配；空 query 恒真。 */
export function matchesQuery(query: string, ...haystack: readonly (string | undefined | null)[]): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
}
