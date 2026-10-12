import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { encodeRouterCache, routePattern } from './router-cache.js'
import { MAX_ROUTER_ROWS, ROUTER_SCHEMA, type RouterRow, type RouterTable } from './router-table.js'

const DIGEST = 'a'.repeat(64)

function row(over: Partial<RouterRow> = {}): RouterRow {
  return {
    workflow: 'default', track: 'lite', label: '轻量', routable: true, priority: 500,
    keywords: ['修复', 'typo'], exclude: ['迁移'], fallback: false, builtin: true, ...over,
  }
}

function table(rows: readonly RouterRow[], sourceDigest = DIGEST): RouterTable {
  return { schema: ROUTER_SCHEMA, sourceDigest, rows, warnings: [] }
}

const unhex = (value: string): string => Buffer.from(value, 'hex').toString('utf8')

/** 命中该 ERE 的行数（与 router.sh 的 `grep -ciE` 同一方言与 locale）。 */
function grepCount(pattern: string, text: string): number {
  const run = spawnSync('grep', ['-ciE', '--', pattern], { input: text, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (run.status !== 0 && run.status !== 1) throw new Error(`grep exit ${String(run.status)}：${run.stderr}`)
  return Number(run.stdout.trim())
}

describe('routePattern', () => {
  it('关键词按字面量拼成不区分大小写的备选式，空列表给空串', () => {
    expect(routePattern([])).toBe('')
    expect(routePattern(['修复', 'typo'])).toBe('(修复|typo)')
    expect(grepCount(routePattern(['修复', 'typo']), 'Fix a TYPO here')).toBe(1)
    expect(grepCount(routePattern(['修复', 'typo']), '帮我修复登录页')).toBe(1)
    expect(grepCount(routePattern(['修复', 'typo']), 'nothing relevant')).toBe(0)
  })

  it('正则元字符一律按字面量匹配，不会扩大命中范围', () => {
    const literal: ReadonlyArray<readonly [string, string, string]> = [
      ['a.b', 'xa.by', 'axb'],
      ['c+d', 'c+d', 'ccd'],
      ['(x)', 'call (x) now', 'call x now'],
      ['p|q', 'p|q', 'only p here'],
      ['^s', 'a ^s b', 's at start'],
      ['e$', 'costs e$ total', 'ends with e'],
      ['f?g', 'f?g', 'g'],
      ['h*i', 'h*i', 'hhi'],
      ['j\\k', 'j\\k', 'jk'],
      ['use free mode', 'please use free mode', 'use  free mode'],
    ]
    for (const [keyword, hit, miss] of literal) {
      const pattern = routePattern([keyword])
      expect(grepCount(pattern, hit), `${keyword} 应命中 ${hit}`).toBe(1)
      expect(grepCount(pattern, miss), `${keyword} 不应命中 ${miss}`).toBe(0)
    }
  })

  it('一行里混着多种元字符的关键词表整体可被 grep -E 接受', () => {
    const terms = ['a.b', 'c+d', '(x)', 'p|q', '^s', 'e$', 'f?g', 'h*i', 'j\\k', '路径/文件', 'C++']
    expect(grepCount(routePattern(terms), 'nothing')).toBe(0)
  })
})

describe('encodeRouterCache', () => {
  it('只输出固定字段与 hex：版本行、元数据行、每行一条记录；原文不裸露', () => {
    const text = encodeRouterCache(table([row(), row({ track: 'beta', routable: false, priority: 0, keywords: [], exclude: [], fallback: false, builtin: false, workflow: 'demo', label: 'Beta' })]), '/tmp/proj')
    const lines = text.split('\n')
    expect(lines[0]).toBe('TENON_ROUTER_V6')
    expect(lines.at(-1)).toBe('')
    const [, meta, first, second] = lines
    expect(meta?.split('|')).toEqual(['M', Buffer.from('/tmp/proj').toString('hex'), DIGEST])
    expect(first?.split('|')).toEqual([
      'R', '0', '500', Buffer.from('default').toString('hex'), Buffer.from('lite').toString('hex'), Buffer.from('轻量').toString('hex'),
      '1', '0', '1', Buffer.from('(修复|typo)').toString('hex'), Buffer.from('(迁移)').toString('hex'),
    ])
    expect(second?.split('|')).toEqual([
      'R', '1', '0', Buffer.from('demo').toString('hex'), Buffer.from('beta').toString('hex'), Buffer.from('Beta').toString('hex'),
      '0', '0', '0', '', '',
    ])
    expect(text).not.toMatch(/修复|typo|迁移|轻量/u)
    expect(unhex(first?.split('|')[9] ?? '')).toBe('(修复|typo)')
  })

  it('同一张表编码结果逐字相同；兜底与内建位按行编码', () => {
    const t = table([row({ track: 'backend', priority: 200, fallback: true, exclude: [] })])
    expect(encodeRouterCache(t, '/p')).toBe(encodeRouterCache(t, '/p'))
    expect(encodeRouterCache(t, '/p').split('\n')[2]?.split('|').slice(6, 9)).toEqual(['1', '1', '1'])
  })

  it('声明了 route 但没有关键词的分支（只当兜底）不产生会匹配一切的空备选式', () => {
    const fallbackOnly = row({ track: 'backend', keywords: [], exclude: [], fallback: true, priority: 0 })
    const fields = encodeRouterCache(table([fallbackOnly]), '/p').split('\n')[2]?.split('|') ?? []
    expect(fields[9]).toBe('')
    expect(fields[6]).toBe('1')
  })

  it('拒绝会让缓存失去意义或失控的输入', () => {
    expect(() => encodeRouterCache(table([row()]), '')).toThrow(/projectRoot/u)
    expect(() => encodeRouterCache(table([row()]), '/a\0b')).toThrow(/projectRoot/u)
    expect(() => encodeRouterCache(table([row()], 'xyz'), '/p')).toThrow(/sourceDigest/u)
    expect(() => encodeRouterCache(table([row(), row()]), '/p')).toThrow(/重复/u)
    expect(() => encodeRouterCache(table(Array.from({ length: MAX_ROUTER_ROWS + 1 }, (_, i) => row({ track: `t${i}` }))), '/p')).toThrow(/行数/u)
    expect(() => encodeRouterCache(table([row({ routable: false })]), '/p')).toThrow(/没有 route/u)
    expect(() => encodeRouterCache(table([row({ priority: -1 })]), '/p')).toThrow(/priority/u)
    expect(() => encodeRouterCache(table([row({ workflow: 'bad name' })]), '/p')).toThrow(/workflow/u)
    expect(() => encodeRouterCache(table([row({ track: 'a|b' })]), '/p')).toThrow(/track/u)
    expect(() => encodeRouterCache(table([row({ label: '' })]), '/p')).toThrow(/label/u)
  })
})
