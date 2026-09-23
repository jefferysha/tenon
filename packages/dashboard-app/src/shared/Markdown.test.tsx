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
