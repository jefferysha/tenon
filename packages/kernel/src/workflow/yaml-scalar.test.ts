import { describe, expect, test } from 'vitest'
import { formatScalar, parseScalar } from './yaml-scalar.js'

describe('workflow 单行标量编解码', () => {
  test('安全值写平文，往返保真', () => {
    for (const value of ['npm test', 'npx playwright test --reporter=junit', 'frontend/test-results/junit.xml', '单测']) {
      expect(formatScalar(value)).toBe(value)
      expect(parseScalar(formatScalar(value))).toBe(value)
    }
  })

  test('会改变语义的值写单引号，双单引号转义', () => {
    const cases = [
      'npm run test -- --grep: foo',
      'echo a # b',
      '-x',
      "-it's",
      ' leading',
      'trailing ',
      '',
      'postgres://localhost:5432',
      'npm test:',
    ]
    for (const value of cases) {
      const written = formatScalar(value)
      if (value === 'postgres://localhost:5432') expect(written).toBe(value)
      else expect(written.startsWith("'")).toBe(true)
      expect(parseScalar(written)).toBe(value)
    }
    expect(formatScalar("it's")).toBe("it's")
    expect(formatScalar("-it's")).toBe("'-it''s'")
    expect(parseScalar("''''")).toBe("'")
  })

  test('未闭合单引号 fail-loud', () => {
    expect(() => parseScalar("'abc")).toThrow('单引号标量未闭合')
    expect(() => parseScalar("'")).toThrow('单引号标量未闭合')
  })
})
