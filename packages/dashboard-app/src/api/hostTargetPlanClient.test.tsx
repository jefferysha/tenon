import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchHostTargetDetection,
  fetchHostTargetPlan,
  fetchHostTargets,
  HostTargetPlanClientError,
} from './hostTargetPlanClient'
import { HOST_PLAN_RELEASE_TAG } from './hostTargetPlanDecoders'

const HOST_IDS = [
  'codex', 'claude', 'cursor', 'gemini', 'copilot', 'pi',
  'devin', 'zed', 'aider', 'continue', 'cline', 'amp',
] as const

function target(id: (typeof HOST_IDS)[number]) {
  const native = id === 'codex' || id === 'claude'
  return {
    id,
    kind: native ? 'native' as const : 'adapter' as const,
    cli_flag: `--${id}`,
    target_scope: native ? 'user' as const : 'project' as const,
    supported_operations: ['setup', 'update'],
    capabilities: native
      ? ['native-marketplace', 'managed-runtime', 'bundled-skills', 'automatic-update']
      : ['project-adapter', 'managed-runtime', 'bundled-skills'],
  }
}

const catalog = {
  schema_version: 'host-target-plan/v1',
  targets: HOST_IDS.map(target),
}

function command(executable: string, args: string[]) {
  return { executable, args, display: [executable, ...args].join(' ') }
}

function nativePlan(host: 'codex' | 'claude', operation: 'setup' | 'update') {
  const hostCommand = command('tenon', [operation, `--${host}`])
  const nativeCommands = host === 'codex'
    ? operation === 'setup'
      ? [
          command('codex', ['plugin', 'remove', 'tenon@tenon', '--json']),
          command('codex', ['plugin', 'marketplace', 'remove', 'tenon', '--json']),
          command('codex', [
            'plugin', 'marketplace', 'add', 'jefferysha/tenon', '--ref', HOST_PLAN_RELEASE_TAG, '--json',
          ]),
          command('codex', ['plugin', 'add', 'tenon@tenon', '--json']),
          command('codex', ['plugin', 'list', '--json']),
        ]
      : [
          command('codex', ['plugin', 'remove', 'tenon@tenon', '--json']),
          command('codex', ['plugin', 'marketplace', 'remove', 'tenon', '--json']),
          command('codex', [
            'plugin', 'marketplace', 'add', 'jefferysha/tenon', '--ref', '<latest-stable>', '--json',
          ]),
          command('codex', ['plugin', 'add', 'tenon@tenon', '--json']),
          command('codex', ['plugin', 'list', '--json']),
        ]
    : operation === 'setup'
      ? [
          command('claude', ['plugin', 'uninstall', 'tenon@tenon', '--scope', 'user']),
          command('claude', ['plugin', 'marketplace', 'remove', 'tenon']),
          command('claude', ['plugin', 'marketplace', 'add', `jefferysha/tenon@${HOST_PLAN_RELEASE_TAG}`]),
          command('claude', ['plugin', 'install', 'tenon@tenon']),
          command('claude', ['plugin', 'list', '--json']),
        ]
      : [
          command('claude', ['plugin', 'uninstall', 'tenon@tenon', '--scope', 'user']),
          command('claude', ['plugin', 'marketplace', 'remove', 'tenon']),
          command('claude', ['plugin', 'marketplace', 'add', 'jefferysha/tenon@<latest-stable>']),
          command('claude', ['plugin', 'install', 'tenon@tenon']),
          command('claude', ['plugin', 'list', '--json']),
        ]
  const nativeIds = ['plugin-remove', 'marketplace-remove', 'marketplace-register', 'plugin-install', 'plugin-inventory']
  // 只读计划无法观察宿主登记，因此 CLI 把两条删除公开为条件性步骤。
  const conditionalIds: readonly string[] = ['plugin-remove', 'marketplace-remove']
  return {
    schema_version: 'host-target-plan/v1',
    side_effects: 'none',
    host: target(host),
    operation,
    command: hostCommand,
    steps: [
      {
        id: operation === 'setup' ? 'stable-release-target' : 'stable-release-resolve',
        label: `host-plan.step.${operation === 'setup' ? 'stable-release-target' : 'stable-release-resolve'}`,
        command: null,
      },
      ...nativeIds.map((id, index) => (conditionalIds.includes(id)
        ? {
            id,
            label: `host-plan.step.${id}`,
            command: nativeCommands[index],
            condition: `host-plan.condition.${id}`,
          }
        : {
            id,
            label: `host-plan.step.${id}`,
            command: nativeCommands[index],
          })),
      { id: 'candidate-validation', label: 'host-plan.step.candidate-validation', command: null },
      { id: 'managed-runtime', label: 'host-plan.step.managed-runtime', command: null },
      { id: 'dashboard-readiness', label: 'host-plan.step.dashboard-readiness', command: null },
      ...(host === 'codex'
        ? [{
            id: 'codex-auth-status',
            label: 'host-plan.step.codex-auth-status',
            command: command('codex', ['login', 'status']),
          }]
        : []),
      ...(operation === 'setup'
        ? [
            { id: 'bundled-skills', label: 'host-plan.step.bundled-skills', command: null },
            { id: 'runtime-readiness', label: 'host-plan.step.runtime-readiness', command: null },
          ]
        : []),
    ],
    notices: [
      'host-plan.notice.read-only-generation',
      'host-plan.notice.manual-command-has-effects',
      'host-plan.notice.dashboard-readiness',
      ...(operation === 'setup' ? ['host-plan.notice.first-setup-browser'] : []),
      ...(operation === 'setup' ? ['host-plan.notice.setup-rebind-conditional'] : []),
      ...(operation === 'update' ? ['host-plan.notice.update-target-frozen-at-execution'] : []),
      ...(host === 'codex' ? ['host-plan.notice.codex-auth-guidance'] : []),
    ],
  }
}

const plan = nativePlan('codex', 'setup')

function adapterPlan(host: 'cursor', operation: 'setup' | 'update') {
  const hostCommand = command('tenon', [operation, `--${host}`, '--target', '.'])
  return {
    schema_version: 'host-target-plan/v1',
    side_effects: 'none',
    host: target(host),
    operation,
    command: hostCommand,
    steps: [
      { id: 'package-assets', label: 'host-plan.step.package-assets', command: null },
      { id: 'managed-runtime', label: 'host-plan.step.managed-runtime', command: null },
      { id: 'dashboard-readiness', label: 'host-plan.step.dashboard-readiness', command: null },
      { id: 'adapter-deploy', label: 'host-plan.step.adapter-deploy', command: hostCommand },
      ...(operation === 'setup'
        ? [
            { id: 'bundled-skills', label: 'host-plan.step.bundled-skills', command: null },
            { id: 'runtime-readiness', label: 'host-plan.step.runtime-readiness', command: null },
          ]
        : []),
    ],
    notices: [
      'host-plan.notice.read-only-generation',
      'host-plan.notice.manual-command-has-effects',
      'host-plan.notice.dashboard-readiness',
      ...(operation === 'setup' ? ['host-plan.notice.first-setup-browser'] : []),
      'host-plan.notice.current-project-target',
    ],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('host target plan read-only client', () => {
  it('accepts only the strict native host detection response and uses the read-only GET boundary', async () => {
    const detection = {
      schema_version: 'host-target-detection/v1',
      detected_hosts: ['codex', 'claude'],
      recommended_host: 'codex',
      recommended_operation: 'update',
      reason: 'tenon-plugin-detected',
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(detection), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHostTargetDetection()).resolves.toEqual(detection)
    expect(fetchMock).toHaveBeenCalledWith('/api/host-target-detection', {
      headers: { Accept: 'application/json' },
    })
  })

  it('accepts an ordered subset containing only Claude and the explicit none state', async () => {
    const claude = {
      schema_version: 'host-target-detection/v1',
      detected_hosts: ['claude'],
      recommended_host: 'claude',
      recommended_operation: 'setup',
      reason: 'host-detected',
    }
    const none = {
      schema_version: 'host-target-detection/v1',
      detected_hosts: [],
      recommended_host: null,
      recommended_operation: null,
      reason: 'none',
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(claude), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(none), { status: 200 })))

    await expect(fetchHostTargetDetection()).resolves.toEqual(claude)
    await expect(fetchHostTargetDetection()).resolves.toEqual(none)
  })

  it('rejects detection shape, ordering, recommendation, and unknown-key drift', async () => {
    const valid = {
      schema_version: 'host-target-detection/v1',
      detected_hosts: ['codex', 'claude'],
      recommended_host: 'codex',
      recommended_operation: 'update',
      reason: 'tenon-plugin-detected',
    }
    const values = [
      { ...valid, schema_version: 'host-target-detection/v2' },
      { ...valid, detected_hosts: ['claude', 'codex'] },
      { ...valid, recommended_host: 'cursor' },
      { ...valid, recommended_operation: 'setup' },
      { ...valid, home: '/private/home' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(values.shift()), { status: 200 })))

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(fetchHostTargetDetection()).rejects.toMatchObject({
        kind: 'decoder',
        code: 'HOST_TARGET_DETECTION_RESPONSE_INVALID',
        status: 200,
      })
    }
  })

  it('preserves a missing detection endpoint as an HTTP fallback signal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 }),
    ))

    await expect(fetchHostTargetDetection()).rejects.toMatchObject({
      kind: 'http',
      code: 'HOST_TARGET_HTTP_ERROR',
      status: 404,
    })
  })

  it('accepts only an empty catalog or the complete ordered unique registered catalog', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...catalog, targets: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHostTargets()).resolves.toEqual({ ...catalog, targets: [] })
    await expect(fetchHostTargets()).resolves.toEqual(catalog)
    expect(fetchMock).toHaveBeenCalledWith('/api/host-targets', {
      headers: { Accept: 'application/json' },
    })
  })

  it.each([
    ['partial', catalog.targets.slice(0, 1)],
    ['reordered', [catalog.targets[1], catalog.targets[0], ...catalog.targets.slice(2)]],
    ['duplicate', [catalog.targets[0], catalog.targets[0], ...catalog.targets.slice(2)]],
    ['wrong metadata', [{ ...catalog.targets[0], target_scope: 'project' }, ...catalog.targets.slice(1)]],
    ['wrong capabilities', [
      { ...catalog.targets[0], capabilities: ['native-marketplace', 'bundled-skills'] },
      ...catalog.targets.slice(1),
    ]],
  ])('rejects a %s catalog with a stable decoder error', async (_label, targets) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...catalog, targets }), { status: 200 }),
    ))

    await expect(fetchHostTargets()).rejects.toMatchObject({
      name: 'HostTargetPlanClientError',
      kind: 'decoder',
      code: 'HOST_TARGET_CATALOG_RESPONSE_INVALID',
      status: 200,
    })
  })

  it.each([
    ['codex', 'setup'],
    ['codex', 'update'],
    ['claude', 'setup'],
    ['claude', 'update'],
  ] as const)('accepts the exact native command truth for %s %s', async (host, operation) => {
    const value = nativePlan(host, operation)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(value), { status: 200 }),
    ))

    await expect(fetchHostTargetPlan(host, operation)).resolves.toEqual(value)
    expect(value.steps.map(({ id }) => id)).toEqual(operation === 'setup'
      ? [
          'stable-release-target',
          'plugin-remove',
          'marketplace-remove',
          'marketplace-register',
          'plugin-install',
          'plugin-inventory',
          'candidate-validation',
          'managed-runtime',
          'dashboard-readiness',
          ...(host === 'codex' ? ['codex-auth-status'] : []),
          'bundled-skills',
          'runtime-readiness',
        ]
      : [
          'stable-release-resolve',
          'plugin-remove',
          'marketplace-remove',
          'marketplace-register',
          'plugin-install',
          'plugin-inventory',
          'candidate-validation',
          'managed-runtime',
          'dashboard-readiness',
          ...(host === 'codex' ? ['codex-auth-status'] : []),
        ])
  })

  it.each(['setup', 'update'] as const)(
    'accepts the exact adapter %s step boundary',
    async (operation) => {
      const value = adapterPlan('cursor', operation)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response(JSON.stringify(value), { status: 200 }),
      ))

      await expect(fetchHostTargetPlan('cursor', operation)).resolves.toEqual(value)
      expect(value.steps.map(({ id }) => id)).toEqual(operation === 'setup'
        ? ['package-assets', 'managed-runtime', 'dashboard-readiness', 'adapter-deploy', 'bundled-skills', 'runtime-readiness']
        : ['package-assets', 'managed-runtime', 'dashboard-readiness', 'adapter-deploy'])
    },
  )

  it('strictly validates plan command, step commands/order, and notices', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(plan), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...plan,
        command: { ...plan.command, display: 'tenon update --codex' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...plan,
        steps: [plan.steps[1], plan.steps[0], ...plan.steps.slice(2)],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...plan,
        steps: plan.steps.map((step, index) => index === 0
          ? { ...step, command: command('codex', ['plugin', 'list', '--json']) }
          : step),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...plan,
        notices: [...plan.notices].reverse(),
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHostTargetPlan('codex', 'setup')).resolves.toEqual(plan)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(fetchHostTargetPlan('codex', 'setup')).rejects.toMatchObject({
        kind: 'decoder',
        code: 'HOST_TARGET_PLAN_RESPONSE_INVALID',
      })
    }
  })

  it('keeps conditional removals as conditional and rejects a promise/condition mismatch', async () => {
    const promised = {
      ...plan,
      steps: plan.steps.map((step) => step.id === 'plugin-remove'
        ? { id: step.id, label: step.label, command: step.command }
        : step),
    }
    const overclaimed = {
      ...plan,
      steps: plan.steps.map((step) => step.id === 'marketplace-register'
        ? { ...step, condition: 'host-plan.condition.marketplace-register' }
        : step),
    }
    const crossed = {
      ...plan,
      steps: plan.steps.map((step) => step.id === 'plugin-remove'
        ? { ...step, condition: 'host-plan.condition.marketplace-remove' }
        : step),
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(plan), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(promised), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(overclaimed), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(crossed), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const decoded = await fetchHostTargetPlan('codex', 'setup')
    expect(decoded.steps
      .filter((step) => step.condition !== undefined)
      .map((step) => [step.id, step.condition]))
      .toEqual([
        ['plugin-remove', 'host-plan.condition.plugin-remove'],
        ['marketplace-remove', 'host-plan.condition.marketplace-remove'],
      ])
    // 老 CLI 不带 condition 时仍然可解码，只是不再声明条件性。
    await expect(fetchHostTargetPlan('codex', 'setup')).resolves.toMatchObject({
      steps: expect.arrayContaining([
        { id: 'plugin-remove', label: 'host-plan.step.plugin-remove', command: expect.anything() },
      ]),
    })
    for (const _invalid of [overclaimed, crossed]) {
      await expect(fetchHostTargetPlan('codex', 'setup')).rejects.toMatchObject({
        kind: 'decoder',
        code: 'HOST_TARGET_PLAN_RESPONSE_INVALID',
      })
    }
  })

  it('requires an adapter project placeholder, matching deploy command, and exact notice set', async () => {
    const adapter = adapterPlan('cursor', 'update')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(adapter), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...adapter,
        command: command('tenon', ['update', '--cursor']),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...adapter,
        steps: adapter.steps.map((step) => step.id === 'adapter-deploy'
          ? { ...step, command: command('tenon', ['setup', '--cursor', '--target', '.']) }
          : step),
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...adapter,
        notices: adapter.notices.slice(0, 2),
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHostTargetPlan('cursor', 'update')).resolves.toEqual(adapter)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(fetchHostTargetPlan('cursor', 'update')).rejects.toMatchObject({
        kind: 'decoder',
        code: 'HOST_TARGET_PLAN_RESPONSE_INVALID',
      })
    }
  })

  it('returns a stable network kind/code without localized transport copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(fetchHostTargets()).rejects.toMatchObject({
      name: 'HostTargetPlanClientError',
      kind: 'network',
      code: 'HOST_TARGET_NETWORK_ERROR',
    })
  })

  it('forwards an AbortSignal through the shared read-only fetch boundary', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(catalog), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHostTargets(controller.signal)).resolves.toEqual(catalog)
    expect(fetchMock).toHaveBeenCalledWith('/api/host-targets', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
  })

  it('preserves only a recognized stable HTTP code and status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: false,
        code: 'HOST_TARGET_PLAN_UNAVAILABLE',
        error: '本地化服务文案不得穿透 UI',
      }), { status: 503 }),
    ))

    await expect(fetchHostTargets()).rejects.toMatchObject({
      name: 'HostTargetPlanClientError',
      kind: 'http',
      code: 'HOST_TARGET_PLAN_UNAVAILABLE',
      status: 503,
    })
  })

  it('distinguishes decoder and request-mismatch errors with stable kind/code', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...catalog, schema_version: 'v2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nativePlan('claude', 'setup')), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHostTargets()).rejects.toMatchObject({
      kind: 'decoder',
      code: 'HOST_TARGET_CATALOG_RESPONSE_INVALID',
    })
    await expect(fetchHostTargetPlan('codex', 'setup')).rejects.toMatchObject({
      kind: 'mismatch',
      code: 'HOST_TARGET_PLAN_REQUEST_MISMATCH',
    })
  })

  it('exports a typed stable error value for component-level i18n mapping', () => {
    expect(new HostTargetPlanClientError('http', 'HOST_TARGET_HTTP_ERROR', 500)).toMatchObject({
      kind: 'http',
      code: 'HOST_TARGET_HTTP_ERROR',
      status: 500,
    })
  })
})
