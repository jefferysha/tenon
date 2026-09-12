import { describe, expect, it } from 'vitest'
import { normalizeObservation, normalizePolicy } from './runtime-v2-boundary.js'

describe('runtime v2 consumed boundary', () => {
  it('accepts bounded string/object declarations and preserves exact versions', () => {
    const normalized = normalizeObservation({ output: { ok: true }, consumed: ['input.txt', { ref: 'other.json', version: 'v2', representation: 'summary', max_bytes: 128 }], artifacts: [], diagnostics: [] }, normalizePolicy())
    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.observation.consumed).toEqual([{ ref: 'input.txt' }, { ref: 'other.json', version: 'v2', representation: 'summary', max_bytes: 128 }])
  })

  it('keeps unrelated output while recording malformed consumed declarations as diagnostics', () => {
    const normalized = normalizeObservation({ output: 'usable', consumed: [{ ref: '../escape' }, 42], artifacts: [], diagnostics: [] }, normalizePolicy())
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.observation.output).toBe('usable')
      expect(normalized.observation.consumed).toEqual([])
      expect(normalized.observation.diagnostics).toContain('consumed-invalid')
    }
  })
})
