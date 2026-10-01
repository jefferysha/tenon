import { describe, expect, it } from 'vitest'
import type { StepTestPolicyIR, TestIntegrityReport, TestPolicyReport } from '@tenon/kernel'
import { policyDto, policyReportDto } from './testPolicyDto.js'

function report(integrity?: TestIntegrityReport): TestPolicyReport {
  return {
    stepId: 'verify', pass: true, blockers: [], notices: [], suites: [], trace: [],
    files: { checked: false, unregistered: [], orphans: [] }, chain: 'empty', notApplicable: [],
    ...(integrity === undefined ? {} : { integrity }),
  }
}

describe('policyDto / policyReportDto —— 测试完整性', () => {
  it('策略：缺省（notice 不进 IR）显示为 notice，block 显示为 block', () => {
    const plain: StepTestPolicyIR = {
      plan: 'required', kinds: [], run: ['unit'], run_if_registered: [], scope: 'full', files: 'any', scenarios: 'off',
      benchmark: { require_baseline: false }, browsers: [],
    }
    expect(policyDto(plain).integrity).toBe('notice')
    expect(policyDto({ ...plain, integrity: 'block' }).integrity).toBe('block')
  })

  it('报告：没有 integrity 就没有这个键；有则带出模式、状态、信号、原因与截断', () => {
    expect(policyReportDto(report(), undefined)).not.toHaveProperty('integrity')
    const dto = policyReportDto(report({
      mode: 'block',
      state: 'unavailable',
      reason: '不是 git 仓库',
      signals: [
        { code: 'test-skipped', subject: 'src/a.test.ts', detail: '+1', suite: 'unit' },
        { code: 'case-count-drop', subject: 'unit', detail: '5 → 3' },
      ],
      truncated: { found: 500, limit: 400 },
    }), undefined)
    expect(dto.integrity).toEqual({
      mode: 'block',
      state: 'unavailable',
      reason: '不是 git 仓库',
      signals: [
        { code: 'test-skipped', subject: 'src/a.test.ts', detail: '+1', suite: 'unit' },
        { code: 'case-count-drop', subject: 'unit', detail: '5 → 3' },
      ],
      truncated: { found: 500, limit: 400 },
    })
  })

  it('读得出且没有信号：仍带出空明细（前端据此决定整段不出现）', () => {
    expect(policyReportDto(report({ mode: 'notice', state: 'ok', signals: [] }), undefined).integrity)
      .toEqual({ mode: 'notice', state: 'ok', signals: [] })
  })

  it('notice 模式的完整性提示只在 notices 里，blockers 里没有它；非阻塞的阻塞带着 blocking:false 原样给出', () => {
    const dto = policyReportDto({
      ...report({ mode: 'notice', state: 'ok', signals: [{ code: 'coverage-threshold-lowered', subject: '.nycrc.json', detail: 'lines 80 → 60' }] }),
      blockers: [{ code: 'baseline-missing', blocking: false, message: 'm', subject: 'api-bench' }],
      notices: [{ code: 'test-integrity', message: '测试完整性提示：覆盖率门槛降低 1', fix: 'tenon test integrity add-login' }],
    }, undefined)
    expect(dto.notices.map((item) => item.code)).toEqual(['test-integrity'])
    expect(dto.blockers.map((item) => [item.code, item.blocking])).toEqual([['baseline-missing', false]])
    expect(dto.notices[0]).not.toHaveProperty('blocking')
  })

  it('block 模式的完整性是真阻塞：在 blockers 里（blocking:true），notices 里没有', () => {
    const dto = policyReportDto({
      ...report({ mode: 'block', state: 'ok', signals: [{ code: 'coverage-threshold-lowered', subject: '.nycrc.json', detail: 'lines 80 → 60' }] }),
      pass: false,
      blockers: [{ code: 'test-integrity', blocking: true, message: '测试完整性未通过：覆盖率门槛降低 1', fix: 'tenon test integrity add-login' }],
    }, undefined)
    expect(dto.blockers.map((item) => [item.code, item.blocking])).toEqual([['test-integrity', true]])
    expect(dto.notices).toEqual([])
  })
})
