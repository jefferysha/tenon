import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { freshHarness } from '../integration-harness.js'
import { makeDeps, spy } from '../test-support.js'
import { cmdStateProjection } from './state-projection.js'

describe('pipeline state · G1 YAML projection 运维面', () => {
  test('status --json 原样报告 drift 并 exit 2', async () => {
    const deps = makeDeps()
    deps.store.inspectProjection = spy(async () => ({
      status: 'drift' as const, revision: 3, revisionId: 'rev-3', reason: 'old writer changed phase',
    }))
    expect(await cmdStateProjection(deps, 'status', 'demo', { json: true })).toBe(2)
    expect(JSON.parse(deps.outLines[0]!)).toMatchObject({ status: 'drift', revision: 3 })
  })

  test('repair-projection 只有显式 --force-canonical 才把覆盖选择传入 store', async () => {
    const deps = makeDeps()
    expect(await cmdStateProjection(deps, 'repair-projection', 'demo', {
      forceCanonical: true,
    })).toBe(0)
    expect(deps.store.repairProjection.calls[0]?.[1]).toEqual({ forceCanonical: true })
  })

  test('import-legacy projection pending → canonical import 已发生但 exit 2 提醒仍需 repair', async () => {
    const deps = makeDeps()
    deps.store.importLegacyProjection = spy(async () => ({
      projection: { status: 'pending' as const, error: new Error('disk full') },
      ignoredProtectedFields: [],
    }))
    expect(await cmdStateProjection(deps, 'import-legacy', 'demo')).toBe(2)
    expect(deps.outLines).toEqual(['demo: imported (pending)'])
  })

  test('import-legacy 保留 canonical phase，并列出被忽略的受保护字段', async () => {
    const h = await freshHarness()
    try {
      expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
      const yamlPath = join(h.cwd, 'openspec', 'changes', 'demo', '.pipeline.yaml')
      const yaml = await readFile(yamlPath, 'utf8')
      await writeFile(yamlPath, yaml.replace('phase: open\n', 'phase: verify\n'), 'utf8')
      expect(await h.run(['state', 'import-legacy', 'demo', '--json'])).toBe(0)
      expect(await h.read('demo')).toMatch(/^phase: open$/m)
      expect(JSON.parse(h.out[0]!)).toMatchObject({ status: 'imported', ignored_protected_fields: ['phase'] })
      expect(h.err.join('\n')).toContain('import-legacy 已忽略受保护字段（保留 canonical 值）：phase')
    } finally {
      await rm(h.cwd, { recursive: true, force: true })
    }
  })

  test('pin-workflow-snapshot 未提供 workflow file 时失败关闭', async () => {
    const deps = makeDeps()
    expect(await cmdStateProjection(deps, 'pin-workflow-snapshot', 'demo')).toBe(1)
    expect(deps.errLines).toContain('ERROR: pin-workflow-snapshot 必须提供 --workflow-file')
  })
})
