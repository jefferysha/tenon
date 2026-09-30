/**
 * 用例引用与已执行用例的对账：有文件时按「文件 + 标题尾部」对；报告没给文件（UNKNOWN_CASE_FILE）时降级为按名字唯一对。
 */
import { describe, expect, it } from 'vitest'
import {
  UNKNOWN_CASE_FILE, caseMatchesRef, casesMatchingRef, fileRefMatches, isUnknownCaseFile, parseCaseRef,
  type CaseIdentity, type CaseRef,
} from './covers.js'

function ref(text: string): CaseRef {
  const parsed = parseCaseRef(text)
  if (parsed === undefined) throw new Error(text)
  return parsed
}

function item(file: string, path: readonly string[], name: string): CaseIdentity {
  return { file, suite_path: path, name }
}

const UNKNOWN = UNKNOWN_CASE_FILE

describe('无文件占位', () => {
  it('占位值不会被当成任何文件；单条用例的比对对它恒不成立', () => {
    expect(isUnknownCaseFile('(unknown)')).toBe(true)
    expect(isUnknownCaseFile('tests/a.test.mjs')).toBe(false)
    expect(fileRefMatches('tests/a.test.mjs', UNKNOWN)).toBe(false)
    expect(fileRefMatches(UNKNOWN, 'tests/a.test.mjs')).toBe(false)
    expect(caseMatchesRef(ref('tests/a.test.mjs › adds'), item(UNKNOWN, [], 'adds'))).toBe(false)
  })
})

describe('casesMatchingRef', () => {
  it('文件对得上：与 caseMatchesRef 一致（标题可只写尾部，只写文件表示任一用例）', () => {
    const cases = [item('tests/a.test.mjs', ['division'], 'divides'), item('tests/b.test.mjs', [], 'other')]
    expect(casesMatchingRef(ref('a.test.mjs › division › divides'), cases)).toEqual([cases[0]])
    expect(casesMatchingRef(ref('tests/a.test.mjs › divides'), cases)).toEqual([cases[0]])
    expect(casesMatchingRef(ref('tests/a.test.mjs'), cases)).toEqual([cases[0]])
    expect(casesMatchingRef(ref('tests/a.test.mjs › missing'), cases)).toEqual([])
  })

  it('文件已知却不是引用的文件：不因名字相同而命中', () => {
    const cases = [item('tests/b.test.mjs', [], 'adds')]
    expect(casesMatchingRef(ref('tests/a.test.mjs › adds'), cases)).toEqual([])
  })

  it('无文件的用例：标题路径尾部唯一相同才按名字命中，引用里的文件不参与', () => {
    const cases = [
      item(UNKNOWN, [], 'adds two numbers'),
      item(UNKNOWN, ['division'], 'divides evenly'),
      item(UNKNOWN, ['division', 'rounding'], 'keeps fractions'),
    ]
    expect(casesMatchingRef(ref('tests/math.test.mjs › adds two numbers'), cases)).toEqual([cases[0]])
    expect(casesMatchingRef(ref('tests/math.test.mjs › division › divides evenly'), cases)).toEqual([cases[1]])
    expect(casesMatchingRef(ref('tests/math.test.mjs › divides evenly'), cases)).toEqual([cases[1]])
    expect(casesMatchingRef(ref('tests/math.test.mjs › rounding › keeps fractions'), cases)).toEqual([cases[2]])
    expect(casesMatchingRef(ref('tests/math.test.mjs › division › keeps fractions'), cases)).toEqual([])
  })

  it('同名不止一条：无法归属，不命中（跨文件重名是 Node 22 报告里的常态）', () => {
    const cases = [item(UNKNOWN, [], 'adds two numbers'), item(UNKNOWN, [], 'adds two numbers')]
    expect(casesMatchingRef(ref('tests/math.test.mjs › adds two numbers'), cases)).toEqual([])
    const scoped = [item(UNKNOWN, ['a'], 'trims'), item(UNKNOWN, ['b'], 'trims')]
    expect(casesMatchingRef(ref('x.test.mjs › trims'), scoped)).toEqual([])
    expect(casesMatchingRef(ref('x.test.mjs › a › trims'), scoped)).toEqual([scoped[0]])
  })

  it('别的文件里有同名的已知文件用例：无文件的那条也无法归属', () => {
    const cases = [item(UNKNOWN, [], 'adds'), item('tests/other.test.mjs', [], 'adds')]
    expect(casesMatchingRef(ref('tests/a.test.mjs › adds'), cases)).toEqual([])
    expect(casesMatchingRef(ref('tests/other.test.mjs › adds'), cases)).toEqual([cases[1]])
  })

  it('只写文件的引用在无文件用例上没有依据，不降级', () => {
    expect(casesMatchingRef(ref('tests/a.test.mjs'), [item(UNKNOWN, [], 'adds')])).toEqual([])
  })
})
