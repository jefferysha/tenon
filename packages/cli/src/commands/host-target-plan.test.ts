import { describe, expect, test } from 'vitest'
import { makeDeps } from '../test-support.js'
import {
  createHostTargetCatalog,
  createHostTargetPlan,
  cmdHostTargetPlan,
} from './host-target-plan.js'
import { nativeHostConvergenceSequence } from './native-host-convergence-sequence.js'
import {
  TENON_HOSTS,
  TENON_RELEASE_VERSION,
  nativeUpdatePlan,
} from './plugin-host.js'

describe('host-target-plan —— 稳定、白名单且零副作用的宿主计划', () => {
  test('catalog 严格按 TENON_HOSTS 顺序公开 native/adapter 能力', () => {
    const catalog = createHostTargetCatalog()

    expect(catalog.schema_version).toBe('host-target-plan/v1')
    expect(catalog.targets.map(({ id }) => id)).toEqual(TENON_HOSTS)
    expect(catalog.targets[0]).toEqual({
      id: 'codex',
      kind: 'native',
      cli_flag: '--codex',
      target_scope: 'user',
      supported_operations: ['setup', 'update'],
      capabilities: [
        'native-marketplace',
        'managed-runtime',
        'bundled-skills',
        'automatic-update',
      ],
    })
    expect(catalog.targets[2]).toEqual({
      id: 'cursor',
      kind: 'adapter',
      cli_flag: '--cursor',
      target_scope: 'project',
      supported_operations: ['setup', 'update'],
      capabilities: ['project-adapter', 'managed-runtime', 'bundled-skills'],
    })
  })

  test('native setup/update 逐项复用现有 host command plan，并按真实外层流程追加产品与 Codex 认证步骤', () => {
    const previewTarget = { version: '<latest-stable>', tag: '<latest-stable>', commit: '0'.repeat(40) }
    const setupTarget = {
      version: TENON_RELEASE_VERSION,
      tag: `v${TENON_RELEASE_VERSION}`,
      commit: '0'.repeat(40),
    }
    const setup = createHostTargetPlan('codex', 'setup')
    const codexUpdate = createHostTargetPlan('codex', 'update')
    const update = createHostTargetPlan('claude', 'update')

    expect(setup.side_effects).toBe('none')
    expect(setup.command).toEqual({
      executable: 'tenon',
      args: ['setup', '--codex'],
      display: 'tenon setup --codex',
    })
    expect(setup.steps.slice(1, 1 + nativeUpdatePlan('codex', setupTarget).length).map(({ command }) => command)).toEqual(
      nativeUpdatePlan('codex', setupTarget).map(({ cmd, args }) => ({
        executable: cmd,
        args: [...args],
        display: [cmd, ...args].join(' '),
      })),
    )
    expect(update.steps.slice(1, 1 + nativeUpdatePlan('claude', previewTarget).length).map(({ command }) => command)).toEqual(
      nativeUpdatePlan('claude', previewTarget).map(({ cmd, args }) => ({
        executable: cmd,
        args: [...args],
        display: [cmd, ...args].join(' '),
      })),
    )
    expect(setup.steps.slice(-5)).toEqual([
      { id: 'managed-runtime', label: 'host-plan.step.managed-runtime', command: null },
      { id: 'dashboard-readiness', label: 'host-plan.step.dashboard-readiness', command: null },
      {
        id: 'codex-auth-status',
        label: 'host-plan.step.codex-auth-status',
        command: {
          executable: 'codex',
          args: ['login', 'status'],
          display: 'codex login status',
        },
      },
      { id: 'bundled-skills', label: 'host-plan.step.bundled-skills', command: null },
      { id: 'runtime-readiness', label: 'host-plan.step.runtime-readiness', command: null },
    ])
    expect(codexUpdate.steps.slice(-3)).toEqual([
      { id: 'managed-runtime', label: 'host-plan.step.managed-runtime', command: null },
      { id: 'dashboard-readiness', label: 'host-plan.step.dashboard-readiness', command: null },
      {
        id: 'codex-auth-status',
        label: 'host-plan.step.codex-auth-status',
        command: {
          executable: 'codex',
          args: ['login', 'status'],
          display: 'codex login status',
        },
      },
    ])
    expect(codexUpdate.steps[0]).toEqual({
      id: 'stable-release-resolve',
      label: 'host-plan.step.stable-release-resolve',
      command: null,
    })
    expect(codexUpdate.steps.at(-4)).toEqual({
      id: 'candidate-validation',
      label: 'host-plan.step.candidate-validation',
      command: null,
    })
    expect(codexUpdate.notices).toContain('host-plan.notice.codex-auth-guidance')
    expect(codexUpdate.notices).toContain('host-plan.notice.update-target-frozen-at-execution')
    expect(setup.notices).toContain('host-plan.notice.first-setup-browser')
    expect(setup.notices).toContain('host-plan.notice.setup-rebind-conditional')
    expect(update.steps.slice(1 + nativeUpdatePlan('claude', previewTarget).length)).toEqual([
      { id: 'candidate-validation', label: 'host-plan.step.candidate-validation', command: null },
      { id: 'managed-runtime', label: 'host-plan.step.managed-runtime', command: null },
      { id: 'dashboard-readiness', label: 'host-plan.step.dashboard-readiness', command: null },
    ])
    expect(update.notices).not.toContain('host-plan.notice.codex-auth-guidance')
  })

  test.each([
    ['codex', 'setup'],
    ['codex', 'update'],
    ['claude', 'setup'],
    ['claude', 'update'],
  ] as const)(
    '%s %s 预览的宿主命令来自执行路径同一序列，且删除步骤按条件性公开而不是承诺执行',
    (host, operation) => {
      const plan = nativeUpdatePlan(host, operation === 'setup'
        ? { version: TENON_RELEASE_VERSION, tag: `v${TENON_RELEASE_VERSION}`, commit: '0'.repeat(40) }
        : { version: '<latest-stable>', tag: '<latest-stable>', commit: '0'.repeat(40) })
      const preview = createHostTargetPlan(host, operation)
      const hostCommandSteps = preview.steps.slice(1, 1 + plan.length)

      // 同一真源：预览逐条等于执行路径在「未观察宿主登记」时派生的序列。
      expect(hostCommandSteps.map((step) => step.command?.display)).toEqual(
        nativeHostConvergenceSequence(plan, { plugin: 'unknown' })
          .map(({ item }) => [item.cmd, ...item.args].join(' ')),
      )
      // 宿主没有 tenon 插件登记时执行路径根本不生成 plugin remove，
      // 因此预览不得把它渲染成必然发生的删除。
      expect(
        nativeHostConvergenceSequence(plan, { plugin: false }).map(({ id }) => id),
      ).not.toContain('plugin-remove')
      expect(
        hostCommandSteps
          .filter((step) => step.condition !== undefined)
          .map((step) => [step.id, step.condition]),
      ).toEqual([
        ['plugin-remove', 'host-plan.condition.plugin-remove'],
        ['marketplace-remove', 'host-plan.condition.marketplace-remove'],
      ])
      // 其余步骤在命令执行时一定发生，不得被标成条件性。
      expect(preview.steps.filter((step) => step.condition !== undefined).map((step) => step.id))
        .toEqual(['plugin-remove', 'marketplace-remove'])
      expect(hostCommandSteps.map((step) => step.id)).toEqual([
        'plugin-remove',
        'marketplace-remove',
        'marketplace-register',
        'plugin-install',
        'plugin-inventory',
      ])
    },
  )

  test('adapter 计划没有条件性步骤：复制的命令一定会执行列出的每一步', () => {
    for (const operation of ['setup', 'update'] as const) {
      expect(createHostTargetPlan('cursor', operation).steps.every(
        (step) => step.condition === undefined,
      )).toBe(true)
    }
  })

  test('adapter setup/update 分别对齐真实外层流程并生成当前目录可安全复制的命令', () => {
    const setup = createHostTargetPlan('cursor', 'setup')
    const update = createHostTargetPlan('cursor', 'update')

    expect(update).toMatchObject({
      schema_version: 'host-target-plan/v1',
      side_effects: 'none',
      operation: 'update',
      command: {
        executable: 'tenon',
        args: ['update', '--cursor', '--target', '.'],
        display: 'tenon update --cursor --target .',
      },
      notices: [
        'host-plan.notice.read-only-generation',
        'host-plan.notice.manual-command-has-effects',
        'host-plan.notice.dashboard-readiness',
        'host-plan.notice.current-project-target',
      ],
    })
    expect(setup.steps.map(({ id }) => id)).toEqual([
      'package-assets',
      'managed-runtime',
      'dashboard-readiness',
      'adapter-deploy',
      'bundled-skills',
      'runtime-readiness',
    ])
    expect(update.steps).toEqual([
      { id: 'package-assets', label: 'host-plan.step.package-assets', command: null },
      { id: 'managed-runtime', label: 'host-plan.step.managed-runtime', command: null },
      { id: 'dashboard-readiness', label: 'host-plan.step.dashboard-readiness', command: null },
      {
        id: 'adapter-deploy',
        label: 'host-plan.step.adapter-deploy',
        command: {
          executable: 'tenon',
          args: ['update', '--cursor', '--target', '.'],
          display: 'tenon update --cursor --target .',
        },
      },
    ])
  })

  test('命令只接受 TENON_HOSTS 与 setup|update，非法输入不产生任何状态写入', () => {
    const deps = makeDeps()

    expect(cmdHostTargetPlan(deps, {})).toBe(1)
    expect(cmdHostTargetPlan(deps, { host: 'custom', operation: 'setup', json: true })).toBe(1)
    expect(cmdHostTargetPlan(deps, { host: 'codex', operation: 'upgrade', json: true })).toBe(1)
    expect(cmdHostTargetPlan(deps, { host: 'codex', json: true })).toBe(1)
    expect(cmdHostTargetPlan(deps, { operation: 'setup', json: true })).toBe(1)
    expect(deps.outLines).toEqual([])
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.store.set.calls).toHaveLength(0)
    expect(deps.store.setMany.calls).toHaveLength(0)
    expect(deps.store.cas.calls).toHaveLength(0)
  })

  test('非法 host/operation 的稳定错误不回显控制符或原始敏感输入', () => {
    const hostDeps = makeDeps()
    const operationDeps = makeDeps()
    const hostileHost = 'evil\nTOKEN=topsecret\u001b[31m'
    const hostileOperation = 'remove\rSECRET=classified\u001b[2J'

    expect(cmdHostTargetPlan(hostDeps, {
      host: hostileHost,
      operation: 'setup',
      json: true,
    })).toBe(1)
    expect(cmdHostTargetPlan(operationDeps, {
      host: 'codex',
      operation: hostileOperation,
      json: true,
    })).toBe(1)

    expect(hostDeps.errLines).toEqual([
      `ERROR: 未知宿主；仅支持 ${TENON_HOSTS.join(', ')}。`,
    ])
    expect(operationDeps.errLines).toEqual([
      'ERROR: 未知操作；仅支持 setup, update。',
    ])
    for (const output of [...hostDeps.errLines, ...operationDeps.errLines]) {
      expect(output).not.toMatch(/TOKEN|SECRET|topsecret|classified|\r|\n|\u001b/)
    }
    expect(hostDeps.outLines).toEqual([])
    expect(operationDeps.outLines).toEqual([])
  })

  test('每个白名单宿主的 setup/update 都生成确定性、非空且 zero-side-effect 的计划', () => {
    for (const host of TENON_HOSTS) {
      for (const operation of ['setup', 'update'] as const) {
        const first = createHostTargetPlan(host, operation)
        const second = createHostTargetPlan(host, operation)

        expect(second).toEqual(first)
        expect(first.host.id).toBe(host)
        expect(first.operation).toBe(operation)
        expect(first.side_effects).toBe('none')
        expect(first.steps.length).toBeGreaterThan(0)
        expect(first.command.args[0]).toBe(operation)
        expect(first.command.args[1]).toBe(`--${host}`)
      }
    }
  })

  test('catalog 与单计划命令只向 stdout 写一个 JSON DTO', () => {
    const catalogDeps = makeDeps()
    const planDeps = makeDeps()

    expect(cmdHostTargetPlan(catalogDeps, { json: true })).toBe(0)
    expect(JSON.parse(catalogDeps.outLines[0]!)).toEqual(createHostTargetCatalog())
    expect(catalogDeps.outLines).toHaveLength(1)
    expect(catalogDeps.errLines).toEqual([])

    expect(cmdHostTargetPlan(planDeps, {
      host: 'amp',
      operation: 'setup',
      json: true,
    })).toBe(0)
    expect(JSON.parse(planDeps.outLines[0]!)).toEqual(createHostTargetPlan('amp', 'setup'))
    expect(planDeps.outLines).toHaveLength(1)
    expect(planDeps.errLines).toEqual([])
  })
})
