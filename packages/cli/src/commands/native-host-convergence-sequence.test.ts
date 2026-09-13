/**
 * 宿主收敛步骤序列 —— 「先删后加」裸露窗口的单元回归。
 *
 * 覆盖：①无登记时不生成 plugin remove（首次安装零删除）；②有登记时保持完整 remove/add 顺序；
 * ③恢复命令恰好是重新绑定正式 release 的两条宿主命令；④中断报告说明当前宿主状态与恢复方式；
 * ⑤未观察宿主（只读预览）时删除步骤按条件性公开，不被当成必然执行的动作。
 */
import { describe, expect, test } from 'vitest'
import {
  hostConvergenceInterruptionReport,
  nativeHostConvergenceSequence,
  nativeHostRestoreCommands,
} from './native-host-convergence-sequence.js'
import { nativeInstallPlan, nativeUpdatePlan, TENON_RELEASE_VERSION } from './plugin-host.js'
import type { StableReleaseTarget } from './stable-release.js'

const target: StableReleaseTarget = {
  version: TENON_RELEASE_VERSION,
  tag: `v${TENON_RELEASE_VERSION}`,
  commit: 'a'.repeat(40),
}

function commandTexts(items: readonly { cmd: string; args: readonly string[] }[]): string[] {
  return items.map((item) => [item.cmd, ...item.args].join(' '))
}

describe('native host convergence sequence', () => {
  test.each(['codex', 'claude'] as const)(
    '%s 首次安装不生成 plugin remove，并与官方 install plan 的 add 序列一致',
    (host) => {
      const steps = nativeHostConvergenceSequence(
        nativeUpdatePlan(host, target),
        { plugin: false },
      )

      expect(steps.map((step) => step.id)).toEqual([
        'marketplace-remove',
        'marketplace-register',
        'plugin-install',
        'inventory-after',
      ])
      // 未登记时唯一保留的删除步骤是 marketplace：它可以在没有插件的情况下独立存在，
      // 而受管步骤会在 absent 前置条件已成立时证明并跳过执行。
      expect(steps.filter((step) => step.destructive).map((step) => step.id))
        .toEqual(['marketplace-remove'])
      expect(commandTexts(steps.slice(1).map((step) => step.item)))
        .toEqual(commandTexts(nativeInstallPlan(host, target.version)))
    },
  )

  test.each(['codex', 'claude'] as const)('%s 已有登记时保持完整 remove/add 收敛顺序', (host) => {
    const plan = nativeUpdatePlan(host, target)
    const steps = nativeHostConvergenceSequence(plan, { plugin: true })

    expect(steps.map((step) => step.id)).toEqual([
      'plugin-remove',
      'marketplace-remove',
      'marketplace-register',
      'plugin-install',
      'inventory-after',
    ])
    expect(commandTexts(steps.map((step) => step.item))).toEqual(commandTexts(plan))
  })

  test.each(['codex', 'claude'] as const)(
    '%s 未观察宿主登记时保留全部删除步骤，但逐条标记为条件性',
    (host) => {
      const plan = nativeUpdatePlan(host, target)
      const unknown = nativeHostConvergenceSequence(plan, { plugin: 'unknown' })

      expect(unknown.map((step) => step.id)).toEqual([
        'plugin-remove',
        'marketplace-remove',
        'marketplace-register',
        'plugin-install',
        'inventory-after',
      ])
      expect(commandTexts(unknown.map((step) => step.item))).toEqual(commandTexts(plan))
      // 未证明登记状态时，两条删除都可能不发生：plugin remove 在无登记时根本不会生成，
      // marketplace remove 在 absent 前置条件已成立时被证明并跳过。
      expect(unknown.filter((step) => step.conditional).map((step) => step.id))
        .toEqual(['plugin-remove', 'marketplace-remove'])
      // 已证明存在插件登记时，plugin remove 一定执行，不得被弱化成条件性。
      expect(
        nativeHostConvergenceSequence(plan, { plugin: true })
          .filter((step) => step.conditional)
          .map((step) => step.id),
      ).toEqual(['marketplace-remove'])
      expect(
        nativeHostConvergenceSequence(plan, { plugin: false })
          .filter((step) => step.conditional)
          .map((step) => step.id),
      ).toEqual(['marketplace-remove'])
    },
  )

  test('恢复命令是重新绑定正式 release 的 marketplace add + plugin install', () => {
    expect(commandTexts(nativeHostRestoreCommands(nativeUpdatePlan('codex', target)))).toEqual([
      `codex plugin marketplace add jefferysha/tenon --ref ${target.tag} --json`,
      'codex plugin add tenon@tenon --json',
    ])
  })

  test('计划长度与受管步骤不一致时 fail loud，而不是错位执行 mutation', () => {
    expect(() => nativeHostConvergenceSequence(
      nativeUpdatePlan('codex', target).slice(0, 3),
      { plugin: true },
    )).toThrow(/宿主安装计划与受管步骤不一致/u)
    expect(() => nativeHostRestoreCommands([])).toThrow(/宿主安装计划与受管步骤不一致/u)
  })

  test('删除已被证明后中断，报告说明宿主已空以及两条恢复路径', () => {
    const plan = nativeUpdatePlan('codex', target)
    const report = hostConvergenceInterruptionReport({
      host: 'codex',
      stepId: 'marketplace-register',
      reason: "host step 'marketplace-register' 执行后未证明 desired postcondition",
      target,
      provenDestructiveStepIds: ['plugin-remove', 'marketplace-remove'],
      hadInstalledPlugin: true,
      restoreCommands: nativeHostRestoreCommands(plan),
      resumeCommand: 'tenon setup --codex',
    }).join('\n')

    expect(report).toContain('宿主收敛在 marketplace-register 中断')
    expect(report).toContain('tenon 插件与tenon marketplace 已被移除且未重新登记')
    expect(report).toContain('这次收敛移除的是宿主原有的 tenon 登记')
    expect(report).toContain('重新运行 `tenon setup --codex`')
    expect(report).toContain(`$ codex plugin marketplace add jefferysha/tenon --ref ${target.tag} --json`)
    expect(report).toContain('$ codex plugin add tenon@tenon --json')
  })

  test('未证明任何删除时，报告明确宿主登记保持原状而不是吓唬用户', () => {
    const report = hostConvergenceInterruptionReport({
      host: 'claude',
      stepId: 'marketplace-register',
      reason: 'network unreachable',
      target,
      provenDestructiveStepIds: [],
      hadInstalledPlugin: false,
      restoreCommands: nativeHostRestoreCommands(nativeUpdatePlan('claude', target)),
      resumeCommand: 'tenon setup --claude',
    }).join('\n')

    expect(report).toContain('本次未证明任何删除步骤')
    expect(report).not.toContain('已被移除且未重新登记')
  })
})
