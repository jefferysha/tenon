/**
 * field-equals value 可表示域（G2 P2 阻断 2）——两层钉死：
 *   1. 委托 text/representable 通用面 + workflow 独有叠加 U+2028/U+2029；
 *   2. 真实 UTF-8 落盘 round-trip：可表示 value serialize→真写文件→读回→parse 逐字往返；不可表示
 *      value compile 期 fail-loud 被挡（永不落盘）。含 lone surrogate 落盘被 U+FFFD 替换的探针，证明
 *      拦截防的是真实腐蚀。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fieldEqualsValueUnrepresentableReason } from './representable.js'
import { compileWorkflow } from './compile.js'
import { parseWorkflow } from './parse.js'
import { serializeWorkflow } from './serialize.js'
import type { WorkflowDef } from './types.js'

describe('fieldEqualsValueUnrepresentableReason —— 委托通用面 + 叠加行解析限制', () => {
  it('委托 text/representable 通用面（空串/控制字符/首尾空白/lone surrogate）→ 拒，且前缀 field-equals', () => {
    for (const v of ['', 'a\nb', 'a\rb', 'a\tb', 'a\r\nb', ' pad', 'pad ', '  ', 'a\uD800b', 'a\uDC00b', '\uD800', '\uDFFF']) {
      const r = fieldEqualsValueUnrepresentableReason(v)
      expect(r, JSON.stringify(v)).not.toBeNull()
      expect(r, JSON.stringify(v)).toMatch(/^field-equals 的 value/)
    }
  })

  it('workflow 独有叠加：U+2028/U+2029（逐行 (.+?) 读不回；text 中性面放行）→ 拒', () => {
    for (const v of ['a b', 'a b']) {
      expect(fieldEqualsValueUnrepresentableReason(v), JSON.stringify(v)).toMatch(/U\+2028\/U\+2029/)
    }
  })

  it('可表示 → null（内部空格/冒号/井号/逗号/歧义标量/同含单双引号——bare 值无引号语义）', () => {
    for (const v of [
      'handled', 'needs review', 'a: b', 'a #b', 'x,y', 'true', '123', '-7', '~', '*ref', 'yes', 'no', 'null',
      `a'b"c`, '会话', 'emoji 😀 ok',
    ]) {
      expect(fieldEqualsValueUnrepresentableReason(v), JSON.stringify(v)).toBeNull()
    }
  })
})

describe('真实 UTF-8 落盘 round-trip（阻断 2）', () => {
  function wfWithValue(value: string): WorkflowDef {
    return {
      name: 'reprfile',
      steps: [
        {
          id: 's1', label: '', gate: null, skills: [], inputs: [], outputs: [],
          guards: [{ type: 'field-equals', field: 'branch_status', value }], transitions: [],
        },
      ],
    }
  }

  it('可表示 value：compile 放行 → serialize → 真写临时文件(utf8) → readFile → parse → 逐字往返', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-repr-'))
    const values = ['handled', 'needs review', 'a: b', 'has #hash', 'a,b,c', 'true', '123', '~', '*ref', "it's", 'say "hi"', '会话值']
    for (const [i, value] of values.entries()) {
      const wf = wfWithValue(value)
      expect(() => compileWorkflow(wf), JSON.stringify(value)).not.toThrow()
      const file = join(dir, `wf${i}.yaml`)
      await writeFile(file, serializeWorkflow(wf), 'utf8')
      const readBack = parseWorkflow(await readFile(file, 'utf8'))
      expect(readBack, JSON.stringify(value)).toEqual(wf)
      expect((readBack.steps[0]!.guards[0] as { value: string }).value).toBe(value)
    }
  })

  it('不可表示 value：compile 期 fail-loud 被挡（永不进 serialize/落盘）', () => {
    for (const value of ['', 'a\nb', 'a\rb', 'a\tb', ' pad', 'pad ', 'a b', 'a b', 'a\uD800b', 'a\uDC00b']) {
      expect(() => compileWorkflow(wfWithValue(value)), JSON.stringify(value)).toThrow(/value/)
    }
  })

  it('探针：lone surrogate 经 writeFile(utf8) 落盘确被 U+FFFD 替换（证明 compile 拦截防的是真实腐蚀，非假想）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-surrogate-'))
    const file = join(dir, 'probe.txt')
    const lone = 'x\uD800y'
    await writeFile(file, lone, 'utf8')
    const readBack = await readFile(file, 'utf8')
    expect(readBack).not.toBe(lone) // 落盘后值变了
    expect(readBack).toContain('�') // 孤立代理被替换成替换字符
  })
})
