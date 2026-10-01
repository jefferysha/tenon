import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWorkflow } from '@tenon/kernel/workflow/parse'
import { I18nProvider, useT } from './index'
import { builtinDirectionLabel, builtinStepLabel, builtinTrackLabel, useBuiltinLabels } from './builtinLabels'
import { translations, type Dict, type Lang } from './translations'

const ROOT = process.cwd()
const NON_ASCII = /[^\u0000-\u007f]/u

function tFor(lang: Lang): (key: string) => string {
  return (key) => {
    let node: string | Dict | undefined = translations[lang]
    for (const part of key.split('.')) {
      if (node === undefined || typeof node === 'string') return key
      node = node[part]
    }
    return typeof node === 'string' ? node : key
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('内置工作流数据的显示名（i18n builtin.*）', () => {
  it('没被改过的出厂阶段名：英文界面显示英文，中文界面显示中文', () => {
    expect(builtinStepLabel(tFor('en'), 'default', 'open', '立项')).toBe('Open')
    expect(builtinStepLabel(tFor('zh'), 'default', 'open', '立项')).toBe('立项')
    expect(builtinStepLabel(tFor('en'), 'standard', 'escalated', '已升级')).toBe('Escalated')
    expect(builtinStepLabel(tFor('en'), 'design-system', 'review', '预览')).toBe('Preview')
  })

  it('改过的阶段名（含只差一个字）在两种语言里都原样显示', () => {
    for (const lang of ['zh', 'en'] as const) {
      expect(builtinStepLabel(tFor(lang), 'default', 'open', '立项 v2')).toBe('立项 v2')
      expect(builtinStepLabel(tFor(lang), 'default', 'build', '开发')).toBe('开发')
      expect(builtinStepLabel(tFor(lang), 'default', 'open', 'Kickoff')).toBe('Kickoff')
      expect(builtinStepLabel(tFor(lang), 'default', 'open', '')).toBe('')
    }
  })

  it('只认 工作流 id + 阶段 id：同名的自建工作流、别的阶段 id、没有工作流名都不翻译', () => {
    const en = tFor('en')
    expect(builtinStepLabel(en, 'mine', 'open', '立项')).toBe('立项')
    expect(builtinStepLabel(en, 'default', 'draft', '立项')).toBe('立项')
    expect(builtinStepLabel(en, 'default', 'build', '立项')).toBe('立项')
    expect(builtinStepLabel(en, null, 'open', '立项')).toBe('立项')
    expect(builtinStepLabel(en, undefined, 'open', '立项')).toBe('立项')
    expect(builtinStepLabel(en, 'constructor', 'prototype', 'x')).toBe('x')
  })

  it('轨道名：default 的五条出厂轨道；改过的、别的工作流的原样', () => {
    const labels: Array<[string, string, string]> = [['chat', '对话', 'Chat'], ['pm', '产品', 'Product'], ['frontend', '前端', 'Frontend'], ['backend', '后端', 'Backend'], ['free', '自由', 'Free']]
    for (const [id, zh, en] of labels) {
      expect(builtinTrackLabel(tFor('en'), 'default', id, zh)).toBe(en)
      expect(builtinTrackLabel(tFor('zh'), 'default', id, zh)).toBe(zh)
    }
    expect(builtinTrackLabel(tFor('en'), 'default', 'backend', '服务端')).toBe('服务端')
    expect(builtinTrackLabel(tFor('en'), 'mine', 'backend', '后端')).toBe('后端')
  })

  it('测试方向名：出厂名换英文，改过的原样；中文界面不变', () => {
    expect(builtinDirectionLabel(tFor('en'), 'code-size', '代码规模')).toBe('Code size')
    expect(builtinDirectionLabel(tFor('zh'), 'code-size', '代码规模')).toBe('代码规模')
    expect(builtinDirectionLabel(tFor('en'), 'code-size', '代码行数')).toBe('代码行数')
    expect(builtinDirectionLabel(tFor('en'), 'my-check', '代码规模')).toBe('代码规模')
    expect(builtinDirectionLabel(tFor('en'), 'e2e', 'e2e')).toBe('e2e')
  })

  it('hook 绑定当前界面语言，换语言即换词', async () => {
    function Probe(): JSX.Element {
      const builtin = useBuiltinLabels()
      const { setLang } = useT()
      return (
        <>
          <span data-testid="step">{builtin.step('default', 'verify', '验证')}</span>
          <span data-testid="edited">{builtin.step('default', 'verify', '验收')}</span>
          <button type="button" onClick={() => setLang('en')}>en</button>
        </>
      )
    }
    render(<I18nProvider><Probe /></I18nProvider>)
    expect(screen.getByTestId('step').textContent).toBe('验证')
    await userEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('step').textContent).toBe('Verify')
    expect(screen.getByTestId('edited').textContent).toBe('验收')
  })
})

describe('词典与随插件发布的模板逐项对齐', () => {
  const zhBuiltin = translations.zh.builtin as Dict
  const enBuiltin = translations.en.builtin as Dict

  /** 词典里 `step.<工作流>.<阶段>` 之类的全部叶子路径。 */
  function leaves(node: Dict, prefix: string[] = []): string[] {
    return Object.entries(node).flatMap(([key, value]) => (typeof value === 'string' ? [[...prefix, key].join('.')] : leaves(value, [...prefix, key])))
  }

  it('zh 与 en 键结构一致，每个英文名非空', () => {
    expect(leaves(enBuiltin)).toEqual(leaves(zhBuiltin))
    for (const path of leaves(enBuiltin)) {
      let node: string | Dict | undefined = enBuiltin
      for (const part of path.split('.')) node = typeof node === 'object' ? node[part] : undefined
      expect(typeof node === 'string' && node.trim() !== '', path).toBe(true)
    }
  })

  const workflowDir = join(ROOT, 'templates', 'workflows')
  const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yaml'))

  it('templates/workflows 里每个含中文的出厂阶段名、轨道名都有对应条目，且 zh 值与出厂名逐字相同', () => {
    expect(files.sort()).toEqual(['default.yaml', 'design-system.yaml', 'simple.yaml', 'standard.yaml'])
    const wanted = new Set<string>()
    for (const file of files) {
      const def = parseWorkflow(readFileSync(join(workflowDir, file), 'utf8'))
      const branches = [def.steps, ...Object.values(def.tracks ?? {}).map((track) => track.steps)]
      for (const steps of branches) {
        for (const step of steps) {
          if (!NON_ASCII.test(step.label)) continue
          const path = `step.${def.name}.${step.id}`
          wanted.add(path)
          expect(tFor('zh')(`builtin.${path}`), path).toBe(step.label)
        }
      }
      for (const [id, track] of Object.entries(def.tracks ?? {})) {
        if (track.label === undefined || !NON_ASCII.test(track.label)) continue
        const path = `track.${def.name}.${id}`
        wanted.add(path)
        expect(tFor('zh')(`builtin.${path}`), path).toBe(track.label)
      }
    }
    // 反过来：词典里的阶段 / 轨道条目都能在模板里找到（模板改名后不留悬空条目）。
    const stepAndTrack = leaves(zhBuiltin).filter((path) => !path.startsWith('direction.'))
    expect(stepAndTrack.sort()).toEqual([...wanted].sort())
  })

  it('templates/test-directions 里每个含中文的出厂方向名都有对应条目，且 zh 值与出厂名逐字相同', () => {
    const dir = join(ROOT, 'templates', 'test-directions')
    const wanted = new Set<string>()
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
      const text = readFileSync(join(dir, file), 'utf8')
      const id = /^id:\s*(\S+)\s*$/mu.exec(text)?.[1]
      const label = /^label:\s*(.+?)\s*$/mu.exec(text)?.[1]
      expect(id, file).toBeDefined()
      if (id === undefined || label === undefined || !NON_ASCII.test(label)) continue
      wanted.add(`direction.${id}`)
      expect(tFor('zh')(`builtin.direction.${id}`), id).toBe(label)
    }
    expect(leaves(zhBuiltin).filter((path) => path.startsWith('direction.')).sort()).toEqual([...wanted].sort())
  })

  it('出厂 default 工作流里带中文名的测试项，其 id 就是方向 id（画布按测试项 id 匹配方向）', () => {
    const def = parseWorkflow(readFileSync(join(workflowDir, 'default.yaml'), 'utf8'))
    for (const track of Object.values(def.tracks ?? {})) {
      for (const step of track.steps) {
        for (const test of step.tests ?? []) {
          if (test.label === undefined || !NON_ASCII.test(test.label)) continue
          expect(test.id, `${step.id}/${test.id}`).toBe(test.direction)
        }
      }
    }
  })
})
