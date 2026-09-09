import { useCallback, useEffect, useState } from 'react'
import type { ThemePreference } from './views'

const THEME_KEY = 'tenon-dashboard-theme'

function initialTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'system' || stored === 'light' || stored === 'dark') return stored
  } catch {
    /* ignore */
  }
  return 'system'
}

export function useDashboardTheme(): {
  readonly theme: ThemePreference
  readonly setTheme: (next: ThemePreference) => void
} {
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme)

  useEffect(() => {
    const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : undefined
    const applyTheme = (): void => {
      try {
        document.documentElement.dataset.themePreference = theme
        document.documentElement.dataset.theme = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme
      } catch {
        /* ignore */
      }
    }
    applyTheme()
    if (theme !== 'system' || !media) return
    media.addEventListener?.('change', applyTheme)
    return () => media.removeEventListener?.('change', applyTheme)
  }, [theme])

  const setTheme = useCallback((next: ThemePreference): void => {
    setThemeState(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  return { theme, setTheme }
}
