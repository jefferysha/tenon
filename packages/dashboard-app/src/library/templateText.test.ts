import { describe, expect, it } from 'vitest'
import { alignHeading, frontField, rewriteTemplate, splitTemplate, uniqueCopyId, uniqueCopyTitle } from './templateText'

const REACT = '---\nid: typescript-react\ncategory: frontend\ntitle: "TypeScript + React"\nframeworks: [react]\nvariables:\n  - key: app\n    default: web\n---\n## 前端（TypeScript + React）\n\n- 规则\n'

describe('模板副本命名', () => {
  it('标识：<id>-copy，已占用依次加序号；不超过 64 字符', () => {
    expect(uniqueCopyId('go', new Set())).toBe('go-copy')
    expect(uniqueCopyId('go', new Set(['go-copy']))).toBe('go-copy-2')
    expect(uniqueCopyId('go', new Set(['go-copy', 'go-copy-2']))).toBe('go-copy-3')
    const long = 'a'.repeat(64)
    expect(uniqueCopyId(long, new Set())).toHaveLength(64)
    expect(uniqueCopyId(long, new Set())).toMatch(/-copy$/u)
  })

  it('名称：「<名称> 副本」，已占用依次加序号', () => {
    expect(uniqueCopyTitle('Go', '副本', new Set())).toBe('Go 副本')
    expect(uniqueCopyTitle('Go', '副本', new Set(['Go 副本']))).toBe('Go 副本 2')
    expect(uniqueCopyTitle('Go', 'copy', new Set(['Go copy', 'Go copy 2']))).toBe('Go copy 3')
  })
})

describe('模板改写', () => {
  it('拆出 frontmatter 与正文；读带引号的标量', () => {
    const parts = splitTemplate(REACT)
    expect(parts?.body).toBe('## 前端（TypeScript + React）\n\n- 规则\n')
    expect(frontField(parts?.front ?? [], 'title')).toBe('TypeScript + React')
    expect(splitTemplate('no frontmatter')).toBeNull()
  })

  it('复制：只改 id 与 title 两行，其余 frontmatter 原样；正文标题里的旧名称换成新名称', () => {
    expect(rewriteTemplate(REACT, { id: 'typescript-react-copy', title: 'TypeScript + React 副本' })).toBe(
      '---\nid: typescript-react-copy\ncategory: frontend\ntitle: TypeScript + React 副本\nframeworks: [react]\nvariables:\n  - key: app\n    default: web\n---\n## 前端（TypeScript + React 副本）\n\n- 规则\n',
    )
  })

  it('改分类：标题级别随分类（state / styling 为三级）', () => {
    const out = rewriteTemplate(REACT, { category: 'state' })
    expect(out).toContain('\ncategory: state\n')
    expect(splitTemplate(out)?.body.startsWith('### 前端（TypeScript + React）')).toBe(true)
  })

  it('以引号开头或首尾有空格的名称写成带引号的标量', () => {
    expect(rewriteTemplate(REACT, { title: '"quoted" name' })).toContain('title: "\\"quoted\\" name"\n')
  })

  it('正文第一行不是块标题时不动正文', () => {
    expect(alignHeading('正文\n', 2, 'a', 'b')).toBe('正文\n')
  })
})
