import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  containsManagedMarker, contentAfterDelete, mergeManagedBlocks, parseManagedBlocks,
} from './managed-blocks.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CODEX_BLOCK = readFileSync(join(HERE, '..', '..', '..', '..', 'templates', 'generated', 'codex-agents-block.md'), 'utf8')

describe('parseManagedBlocks', () => {
  test('真实 Codex 生成块解析为一个 CODEX 块，用户文本为空', () => {
    const parsed = parseManagedBlocks(CODEX_BLOCK)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.blocks.map((block) => block.tag)).toEqual(['CODEX'])
    expect(parsed.blocks[0]?.text).toBe(CODEX_BLOCK.trimEnd())
    expect(parsed.userText).toBe('')
  })

  test('用户文本包住块：userText 去掉块与多余空行，块按文件顺序', () => {
    const content = `# 项目\n\n规则一\n\n${CODEX_BLOCK}\n<!-- PIPELINE:ZED:START -->\nzed\n<!-- PIPELINE:ZED:END -->\n`
    const parsed = parseManagedBlocks(content)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.userText).toBe('# 项目\n\n规则一\n')
    expect(parsed.blocks.map((block) => block.tag)).toEqual(['CODEX', 'ZED'])
  })

  test('中间块移走后两侧空行合并为一个', () => {
    const parsed = parseManagedBlocks('a\n\n<!-- PIPELINE:X:START -->\nx\n<!-- PIPELINE:X:END -->\n\nb\n')
    expect(parsed.ok && parsed.userText).toBe('a\n\nb\n')
  })

  test('CRLF 按 LF 解析', () => {
    const parsed = parseManagedBlocks('a\r\n<!-- PIPELINE:X:START -->\r\nx\r\n<!-- PIPELINE:X:END -->\r\n')
    expect(parsed.ok && parsed.blocks[0]?.text).toBe('<!-- PIPELINE:X:START -->\nx\n<!-- PIPELINE:X:END -->')
  })

  test.each([
    ['unpaired', 'a\n<!-- PIPELINE:CODEX:START -->\nb\n', 'CODEX', 2],
    ['unpaired', 'a\n<!-- PIPELINE:CODEX:END -->\n', 'CODEX', 2],
    ['reversed', '<!-- PIPELINE:CODEX:END -->\nx\n<!-- PIPELINE:CODEX:START -->\n', 'CODEX', 1],
    ['duplicate', '<!-- PIPELINE:A:START -->\n<!-- PIPELINE:A:END -->\n<!-- PIPELINE:A:START -->\n<!-- PIPELINE:A:END -->\n', 'A', 3],
    ['nested', '<!-- PIPELINE:A:START -->\n<!-- PIPELINE:B:START -->\n<!-- PIPELINE:B:END -->\n<!-- PIPELINE:A:END -->\n', 'B', 2],
  ] as const)('%s → 错误码、TAG 与行号', (error, content, tag, line) => {
    expect(parseManagedBlocks(content)).toEqual({ ok: false, error, tag, line })
  })

  test('不带 TAG 的旧标记不是受管块', () => {
    const parsed = parseManagedBlocks('<!-- PIPELINE:START -->\nx\n<!-- PIPELINE:END -->\n')
    expect(parsed.ok && parsed.blocks).toEqual([])
  })
})

describe('mergeManagedBlocks / contentAfterDelete / containsManagedMarker', () => {
  const blocks = [{ tag: 'CODEX', text: '<!-- PIPELINE:CODEX:START -->\nc\n<!-- PIPELINE:CODEX:END -->' }]

  test('用户文本后空一行接受管块，单个结尾换行', () => {
    expect(mergeManagedBlocks('# 规则\n\n\n', blocks)).toBe(`# 规则\n\n${blocks[0]?.text}\n`)
    expect(mergeManagedBlocks('# 规则', [])).toBe('# 规则\n')
    expect(mergeManagedBlocks('', blocks)).toBe(`${blocks[0]?.text}\n`)
    expect(mergeManagedBlocks('', [])).toBe('')
  })

  test('合并结果再解析得到同样的用户文本与块', () => {
    const parsed = parseManagedBlocks(mergeManagedBlocks('# 规则\r\n\r\n- 一\r\n', blocks))
    expect(parsed).toEqual({ ok: true, userText: '# 规则\n\n- 一\n', blocks })
  })

  test('删除：有块只留块，无块返回 null', () => {
    expect(contentAfterDelete(blocks)).toBe(`${blocks[0]?.text}\n`)
    expect(contentAfterDelete([])).toBeNull()
  })

  test('标记行判定只看整行', () => {
    expect(containsManagedMarker('a\n<!-- PIPELINE:CODEX:START -->\n')).toBe(true)
    expect(containsManagedMarker('正文提到 <!-- PIPELINE:CODEX:START --> 不算')).toBe(false)
  })
})
