import { describe, expect, it } from 'vitest'
import { contentDisposition } from './contentDisposition.js'

/** 按 RFC 5987 还原 `filename*`，证明补的扩展值确实是原名。 */
function decodeExtended(header: string): string | null {
  const match = /filename\*=UTF-8''([^;]*)/u.exec(header)
  return match === null ? null : decodeURIComponent(match[1] ?? '')
}

describe('contentDisposition', () => {
  it('纯 ASCII 文件名：只给带引号的 filename，不补扩展值', () => {
    expect(contentDisposition('attachment', 'trace.zip')).toBe('attachment; filename="trace.zip"')
    expect(contentDisposition('inline', 'demo unit.xml')).toBe('inline; filename="demo unit.xml"')
  })

  it('非 ASCII 文件名：ASCII 兜底 + filename*=UTF-8 百分号编码，还原得到原名', () => {
    const name = '截图 1.png'
    const header = contentDisposition('attachment', name)
    expect(header).toBe('attachment; filename="__ 1.png"; filename*=UTF-8\'\'%E6%88%AA%E5%9B%BE%201.png')
    expect(decodeExtended(header)).toBe(name)
  })

  it('增补平面字符按一个码点兜底为一个下划线，扩展值仍是完整 UTF-8', () => {
    const header = contentDisposition('attachment', 'a\u{1F600}b.zip')
    expect(header.startsWith('attachment; filename="a_b.zip"; ')).toBe(true)
    expect(decodeExtended(header)).toBe('a\u{1F600}b.zip')
  })

  it('引号、反斜杠、百分号不会破坏头值：兜底里换成下划线，原名走 filename*', () => {
    const name = 'a"b\\c%d.txt'
    const header = contentDisposition('attachment', name)
    expect(header.startsWith('attachment; filename="a_b_c_d.txt"; ')).toBe(true)
    expect(decodeExtended(header)).toBe(name)
  })

  it('RFC 5987 之外的保留字符（\'()*）也被百分号编码', () => {
    const header = contentDisposition('attachment', "é it's (1)*.png")
    expect(header.split("filename*=UTF-8''")[1]).toBe('%C3%A9%20it%27s%20%281%29%2A.png')
  })

  it('控制字符（含换行）不会进入头值', () => {
    const header = contentDisposition('attachment', 'a\r\nSet-Cookie: x=1.txt')
    expect(header).not.toMatch(/[\r\n]/u)
    expect(header.startsWith('attachment; filename="a__Set-Cookie: x=1.txt"; ')).toBe(true)
    expect(decodeExtended(header)).toBe('a\r\nSet-Cookie: x=1.txt')
  })

  it('孤立代理项不抛错，扩展值里是 U+FFFD', () => {
    const header = contentDisposition('attachment', 'a\uD800b.zip')
    expect(decodeExtended(header)).toBe('a�b.zip')
  })
})
