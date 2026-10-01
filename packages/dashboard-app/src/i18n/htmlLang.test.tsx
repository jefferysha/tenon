import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider, LANG_STORAGE_KEY, useT } from './index'

// vitest 从仓库根运行（同 taskCommands.test 读 hooks/ 的口径）。
const INDEX_HTML = readFileSync(join(process.cwd(), 'packages/dashboard-app/index.html'), 'utf8')
const BOOT = /<script>([\s\S]*?)<\/script>/u.exec(INDEX_HTML)?.[1] ?? ''

beforeEach(() => { document.documentElement.lang = '' })
afterEach(() => { localStorage.clear() })

describe('index.html lang 跟随所选界面语言', () => {
  it('静态兜底是 zh；首帧启动脚本存在，读的就是 I18nProvider 用的 localStorage 键', () => {
    expect(INDEX_HTML).toMatch(/<html lang="zh">/u)
    expect(BOOT).toContain(`localStorage.getItem('${LANG_STORAGE_KEY}')`)
    expect(INDEX_HTML.indexOf('<script>')).toBeLessThan(INDEX_HTML.indexOf('type="module"'))
  })

  it('启动脚本：选了英文 → en；选了中文或没选 → zh；存储不可用时不抛', () => {
    const run = (): string => {
      document.documentElement.lang = ''
      new Function(BOOT)()
      return document.documentElement.lang
    }
    localStorage.setItem(LANG_STORAGE_KEY, 'en')
    expect(run()).toBe('en')
    localStorage.setItem(LANG_STORAGE_KEY, 'zh')
    expect(run()).toBe('zh')
    localStorage.removeItem(LANG_STORAGE_KEY)
    expect(run()).toBe('zh')
    localStorage.setItem(LANG_STORAGE_KEY, 'fr')
    expect(run()).toBe('zh')
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked') } })
    try {
      expect(run()).toBe('')
    } finally {
      if (original !== undefined) Object.defineProperty(window, 'localStorage', original)
    }
  })

  it('切换语言时 <html lang> 随之更新（Provider 在启动脚本之后接管）', () => {
    function Probe(): JSX.Element {
      const { setLang } = useT()
      return <button type="button" onClick={() => setLang('en')}>en</button>
    }
    const view = render(<I18nProvider><Probe /></I18nProvider>)
    expect(document.documentElement.lang).toBe('zh')
    act(() => { view.getByText('en').click() })
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en')
  })
})
