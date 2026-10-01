import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { translations, type Dict, type Lang } from './translations'

/** index.html 的首帧启动脚本读同一个键，两处改动必须一起改（htmlLang.test.tsx 守着）。 */
export const LANG_STORAGE_KEY = 'tenon-dashboard-lang'
const STORAGE_KEY = LANG_STORAGE_KEY

function getInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    /* ignore */
  }
  return 'zh'
}

function resolvePath(dict: Dict, path: string): string {
  const parts = path.split('.')
  let cur: string | Dict | undefined = dict
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return path
    cur = (cur as Dict)[p]
  }
  return typeof cur === 'string' ? cur : path
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [lang, setLangState] = useState<Lang>(getInitialLang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      let str = resolvePath(translations[lang], key)
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.split(`{${k}}`).join(String(v))
        }
      }
      return str
    },
    [lang],
  )

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>
}

export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT must be used within I18nProvider')
  return ctx
}

/**
 * 不要求 Provider 的翻译函数：共享的展示组件（Markdown 的代码块名称）在没有 Provider 的场景里也要能渲染，
 * 此时按 zh 取词。应用里一律在 Provider 内，走当前语言。
 */
export function useOptionalT(): I18nContextValue['t'] {
  const ctx = useContext(I18nContext)
  return ctx?.t ?? ((key, vars) => {
    let str = resolvePath(translations.zh, key)
    if (vars) for (const [k, v] of Object.entries(vars)) str = str.split(`{${k}}`).join(String(v))
    return str
  })
}
