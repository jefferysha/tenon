import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown, stripFrontmatter } from './Markdown'

describe('stripFrontmatter', () => {
  it('去掉开头的 YAML frontmatter，正文原样保留', () => {
    expect(stripFrontmatter('---\nid: go\ncategory: backend\n---\n## 后端\n')).toBe('## 后端\n')
    expect(stripFrontmatter('---\r\nname: a\r\n---\r\n\r\nbody')).toBe('body')
    expect(stripFrontmatter('﻿---\nname: a\n...\nbody')).toBe('body')
    expect(stripFrontmatter('---\n---\nbody')).toBe('body')
  })

  it('不在开头或没有闭合行的 --- 不是 frontmatter', () => {
    expect(stripFrontmatter('# 标题\n\n---\nid: x\n---\n')).toBe('# 标题\n\n---\nid: x\n---\n')
    expect(stripFrontmatter('---\nid: x\nno close')).toBe('---\nid: x\nno close')
  })
})

describe('Markdown', () => {
  // 回归：库里的模板 / 智能体预览把 frontmatter 渲染成段落或 setext 标题（一大段粗体）。
  it('预览不渲染 frontmatter 键值，也不把它读成标题', () => {
    render(<Markdown text={'---\nid: go\ncategory: backend\ntitle: Go\n---\n## 后端（Go）\n'} testId="md" />)
    const preview = screen.getByTestId('md')
    expect(preview.textContent).not.toContain('id: go')
    expect(preview.textContent).not.toContain('category')
    expect(preview.querySelectorAll('h2')).toHaveLength(1)
    expect(preview.querySelector('h2')).toHaveTextContent('后端（Go）')
    expect(preview.querySelector('hr')).toBeNull()
  })
})

describe('Markdown · 注释、表格代码与任务列表', () => {
  it('HTML 注释不渲染成文字；代码块里的注释原样保留', () => {
    render(<Markdown text={'# 规则\n\n<!-- create-rule:start -->\n\n正文 <!-- 行内 --> 结束\n\n```html\n<!-- 保留 -->\n```\n'} testId="md" />)
    const preview = screen.getByTestId('md')
    expect(preview.textContent).not.toContain('create-rule:start')
    expect(preview.textContent).not.toContain('行内')
    expect(preview.textContent).toContain('正文')
    expect(preview.querySelector('pre')).toHaveTextContent('<!-- 保留 -->')
  })

  it('表格里的行内代码不断行，表格可横向滚动', () => {
    render(<Markdown text={'| 键 | 值 |\n| --- | --- |\n| `a-very-long-identifier` | x |\n'} testId="md" density="compact" />)
    const root = screen.getByTestId('md')
    expect(root.querySelector('td code')).toHaveTextContent('a-very-long-identifier')
    expect(root.className).toContain('[&_td_code]:whitespace-nowrap')
    expect(root.className).toContain('[&_table]:overflow-x-auto')
  })

  it('任务列表项只留复选框：列表去圆点，复选框用强调色', () => {
    render(<Markdown text={'- [x] 完成\n- [ ] 未完成\n'} testId="md" />)
    const root = screen.getByTestId('md')
    expect(root.querySelector('ul.contains-task-list')).not.toBeNull()
    expect(root.querySelectorAll('li.task-list-item')).toHaveLength(2)
    expect(root.className).toContain('[&_li.task-list-item]:list-none')
    expect(root.className).toContain('[&_input[type=checkbox]]:accent-(--accent)')
  })
})

describe('Markdown · 行长与行内代码', () => {
  it.each(['default', 'compact'] as const)('%s：正文限 72ch；行内代码 0.9em（不低于 13px）左右 5px，代码块沿用 pre 字号', (density) => {
    render(<Markdown testId="md" density={density} text={'Run `tenon init` now.\n\n```sh\ntenon init\n```'} />)
    const root = screen.getByTestId('md')
    const names = root.className.split(/\s+/u)
    expect(names).toContain('max-w-[72ch]')
    for (const name of ['[&_code]:bg-code-bg', '[&_code]:px-[5px]', '[&_code]:text-[length:max(.9em,13px)]', '[&_pre_code]:[font-size:inherit]']) {
      expect(names).toContain(name)
    }
    expect(root.querySelector('p code')?.textContent).toBe('tenon init')
  })
})
