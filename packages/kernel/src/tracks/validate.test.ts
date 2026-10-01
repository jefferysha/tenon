/**
 * validateTrackRegistry / validateTrackConfigStructure —— 每条校验规则的正反例。
 * 重点反例（任务钉死）：内建 policy_profile 覆写被拒（v1 锁死）、'_all' 当 id 被拒、
 * 与内建重名被拒、非法正则被拒、skills.profile 不在 skillProfiles 被拒、
 * 额外 track 省略 allowed 被拒（codex R1 裁定：全放行必须显式写 '*'；内建覆写省略才继承）。
 * validateTrackConfigStructure 是上下文无关子集；写盘前的强制完整校验在 writeTrackRegistry
 * （合同用例见 registry.test.ts）。
 */
import { describe, expect, test } from 'vitest'
import type { ProjectTrackConfig, ProjectTrackEntryConfig, TrackValidationContext } from './types.js'
import { MAX_CUSTOM_TRACKS, MAX_TRACKS, validateTrackConfigStructure, validateTrackRegistry } from './validate.js'

const CTX: TrackValidationContext = {
  workflowExists: (id) => ['default', 'data-pipeline', 'wf-a', 'wf-b'].includes(id),
  skillProfiles: new Set(['pm', 'frontend', 'backend', 'data']),
}

const VALID_ENTRY: ProjectTrackEntryConfig = {
  id: 'data',
  label: 'Data',
  workflow: { default: 'data-pipeline', allowed: ['data-pipeline', 'default'] },
  policyProfile: {
    reviewSeed: 'pending',
    automationEligible: true,
    coverageProfile: 'backend',
    routing: { enabled: true, pattern: '(数据|ETL|warehouse)', priority: 150 },
    skills: { matrix: true, profile: 'backend' },
  },
}

function cfg(partial: Omit<Partial<ProjectTrackConfig>, 'version'> = {}): ProjectTrackConfig {
  return { version: 1, ...partial }
}

function entry(patch: Partial<ProjectTrackEntryConfig>): ProjectTrackEntryConfig {
  return { ...VALID_ENTRY, ...patch }
}

function expectError(config: ProjectTrackConfig, fragment: string | RegExp): void {
  const errors = validateTrackRegistry(config, CTX)
  const hit = errors.some((e) => (typeof fragment === 'string' ? e.includes(fragment) : fragment.test(e)))
  expect(hit, `期望错误含 ${String(fragment)}，实得：\n${errors.join('\n')}`).toBe(true)
}

describe('validateTrackRegistry —— 合法配置', () => {
  test('完整合法配置 → []', () => {
    expect(validateTrackRegistry(cfg({ tracks: [VALID_ENTRY] }), CTX)).toEqual([])
  })

  test('最小配置（只有 version）→ []', () => {
    expect(validateTrackRegistry(cfg(), CTX)).toEqual([])
  })

  test("allowed 显式 '*'（全放行必须明确写出）→ 合法", () => {
    expect(
      validateTrackRegistry(cfg({ tracks: [entry({ workflow: { default: 'wf-a', allowed: '*' } })] }), CTX),
    ).toEqual([])
  })
})

describe('validateTrackRegistry —— 额外 track 的 id/label/workflow', () => {
  test('id 不合 TRACK_ID_RE（大写/数字开头/含点/超长）→ 逐个报错', () => {
    for (const bad of ['Data', '1x', 'a.b', `a${'b'.repeat(32)}`]) {
      expectError(cfg({ tracks: [entry({ id: bad })] }), `'${bad}' 不合法`)
    }
  })

  test("'_all' 当 id → 保留字被拒", () => {
    expectError(cfg({ tracks: [entry({ id: '_all' })] }), '保留字')
  })

  test('与内建重名 → 被拒', () => {
    expectError(cfg({ tracks: [entry({ id: 'pm' })] }), '与内建 track 重名')
  })

  test('两个额外 track 同 id → 被拒', () => {
    expectError(cfg({ tracks: [VALID_ENTRY, entry({ label: 'Data2' })] }), '重复声明')
  })

  test('id 缺失 / label 缺失或空白 → 被拒', () => {
    expectError(cfg({ tracks: [entry({ id: undefined })] }), 'id: 缺失')
    expectError(cfg({ tracks: [entry({ label: undefined })] }), 'label: 须为非空字符串')
    expectError(cfg({ tracks: [entry({ label: '   ' })] }), 'label: 须为非空字符串')
  })

  test('workflow 缺失 / default 缺失 / default 指向不存在的 workflow → 被拒', () => {
    expectError(cfg({ tracks: [entry({ workflow: undefined })] }), 'workflow.default: 缺失')
    expectError(cfg({ tracks: [entry({ workflow: {} })] }), 'workflow.default: 缺失')
    expectError(cfg({ tracks: [entry({ workflow: { default: 'ghost', allowed: '*' } })] }), "workflow 'ghost' 不存在")
  })

  test('allowed 省略 → 被拒（额外 track 必须显式声明；workflow 整体缺失同样报 allowed 缺失）', () => {
    expectError(cfg({ tracks: [entry({ workflow: { default: 'wf-a' } })] }), 'workflow.allowed: 缺失')
    expectError(cfg({ tracks: [entry({ workflow: undefined })] }), 'workflow.allowed: 缺失')
  })

  test('allowed 稀疏数组（空槽）→ 被拒（forEach/map/every 跳过空槽，会 write→load 自毁；codex R4）', () => {
    const sparse: string[] = ['wf-a']
    sparse.length = 2 // 第二项是空槽（无自有属性）
    expectError(
      cfg({ tracks: [entry({ workflow: { default: 'wf-a', allowed: sparse } })] }),
      'allowed[1]: 数组空槽',
    )
  })

  test('顶层 tracks 稀疏数组（空槽）→ 被拒（同 allowed 同构破口；codex R5）', () => {
    const sparse: ProjectTrackEntryConfig[] = [VALID_ENTRY]
    sparse.length = 2 // tracks[1] 是空槽
    expectError(cfg({ tracks: sparse }), 'tracks[1]: 数组空槽')
  })

  test("'default' 恒视为存在（workflowExists 全拒也放行）", () => {
    const denyAll: TrackValidationContext = { workflowExists: () => false, skillProfiles: CTX.skillProfiles }
    expect(
      validateTrackRegistry(cfg({ tracks: [entry({ workflow: { default: 'default', allowed: '*' } })] }), denyAll),
    ).toEqual([])
  })

  test('allowed 数组不含 default / 含不存在的 workflow → 被拒', () => {
    expectError(
      cfg({ tracks: [entry({ workflow: { default: 'wf-a', allowed: ['wf-b'] } })] }),
      "必须包含 default 'wf-a'",
    )
    expectError(
      cfg({ tracks: [entry({ workflow: { default: 'wf-a', allowed: ['wf-a', 'ghost'] } })] }),
      "workflow 'ghost' 不存在",
    )
  })

  test('allowed 空数组 → 直接拒（R3 D3：显式空数组错误，不靠"未含 default"间接报）', () => {
    const errors = validateTrackRegistry(cfg({ tracks: [entry({ workflow: { default: 'wf-a', allowed: [] } })] }), CTX)
    expect(errors.some((e) => e.includes('数组不能为空'))).toBe(true)
    // 空数组短路：不再另报「必须包含 default」间接错误
    expect(errors.some((e) => e.includes('必须包含 default'))).toBe(false)
  })

  test('allowed 重复项 → 被拒（R3 D3）', () => {
    expectError(
      cfg({ tracks: [entry({ workflow: { default: 'wf-a', allowed: ['wf-a', 'default', 'wf-a'] } })] }),
      "重复项 'wf-a'",
    )
  })
})

describe('validateTrackRegistry —— builtins 覆写节', () => {
  test('键不是内建 id → 被拒', () => {
    expectError(cfg({ builtins: { data: { label: 'X' } } }), '不是内建 track id')
  })

  test('policy_profile 覆写 → 被拒（v1 锁死内建 policy）', () => {
    expectError(
      cfg({ builtins: { chat: { policyProfile: { reviewSeed: 'skipped' } } } }),
      'v1 锁死内建 policy',
    )
  })

  test('label/workflow 合法覆写 → []', () => {
    const config = cfg({
      builtins: {
        chat: { label: '会话' },
        pm: { workflow: { default: 'wf-a', allowed: ['wf-a', 'default'] } },
      },
    })
    expect(validateTrackRegistry(config, CTX)).toEqual([])
  })

  test('覆写 allowed 不含 effective default（含内建缺省 default 的场景）→ 被拒', () => {
    // 未覆写 default 时 effective default 是内建的 'default'
    expectError(
      cfg({ builtins: { pm: { workflow: { allowed: ['wf-a'] } } } }),
      "必须包含 default 'default'",
    )
    // 覆写了 default 则按覆写值判 membership
    expect(
      validateTrackRegistry(cfg({ builtins: { pm: { workflow: { default: 'wf-a', allowed: ['wf-a'] } } } }), CTX),
    ).toEqual([])
  })

  test('覆写 workflow.default 指向不存在的 workflow → 被拒', () => {
    expectError(cfg({ builtins: { chat: { workflow: { default: 'ghost' } } } }), "workflow 'ghost' 不存在")
  })

  test('覆写省略 allowed → 合法（继承内建原值，不落额外 track 的显式声明义务）', () => {
    expect(validateTrackRegistry(cfg({ builtins: { pm: { workflow: { default: 'wf-a' } } } }), CTX)).toEqual([])
  })
})

describe('validateTrackRegistry —— policy_profile 闭集与类型', () => {
  test('policy_profile 缺失 → 被拒', () => {
    expectError(cfg({ tracks: [entry({ policyProfile: undefined })] }), 'policy_profile: 缺失')
  })

  test('review_seed / coverage_profile 闭集外值 → 被拒', () => {
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...VALID_ENTRY.policyProfile, reviewSeed: 'sometimes' } })] }),
      'review_seed: 须为 pending|skipped',
    )
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...VALID_ENTRY.policyProfile, coverageProfile: 'ops' } })] }),
      'coverage_profile: 须为 none|pm|frontend|backend',
    )
  })

  test('automation_eligible 缺失或非布尔 → 被拒', () => {
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...VALID_ENTRY.policyProfile, automationEligible: undefined } })] }),
      'automation_eligible: 缺失或非布尔',
    )
  })

  test('routing.enabled=true：pattern 缺失 / 非法正则（真 new RegExp 编译）/ priority 负数或非整数 → 被拒', () => {
    const p = VALID_ENTRY.policyProfile!
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, priority: 1 } } })] }),
      'routing.pattern: 缺失或为空',
    )
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: '(', priority: 1 } } })] }),
      '非法正则',
    )
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: -1 } } })] }),
      'priority: 须为非负安全整数',
    )
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: 1.5 } } })] }),
      'priority: 须为非负安全整数',
    )
    // priority 0 合法（非负整数）
    expect(
      validateTrackRegistry(
        cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: 0 } } })] }),
        CTX,
      ),
    ).toEqual([])
  })

  test('routing.exclude_pattern：可选；空串、非法正则和不可表示值被拒', () => {
    const p = VALID_ENTRY.policyProfile!
    expect(
      validateTrackRegistry(
        cfg({
          tracks: [entry({
            policyProfile: {
              ...p,
              routing: { enabled: true, pattern: 'x', excludePattern: '(API|schema)', priority: 1 },
            },
          })],
        }),
        CTX,
      ),
    ).toEqual([])
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', excludePattern: '', priority: 1 } } })] }),
      'exclude_pattern: 提供时须为非空字符串',
    )
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', excludePattern: '(', priority: 1 } } })] }),
      'exclude_pattern: 非法正则',
    )
    expectError(
      cfg({
        tracks: [entry({
          policyProfile: {
            ...p,
            routing: { enabled: true, pattern: 'x', excludePattern: `x'y"z`, priority: 1 },
          },
        })],
      }),
      '单双引号',
    )
  })

  test('priority 数域=非负安全整数：1e21（isInteger 放行但 String() 成科学计数法）与 2^53 被拒；MAX_SAFE_INTEGER 合法', () => {
    const p = VALID_ENTRY.policyProfile!
    // codex 探针实证的自毁值：旧 Number.isInteger 闸放行 → serialize 写出 'priority: 1e+21'
    // → parse 只认纯十进制整数，报「应为整数」——write→load 合同破口，域必须在校验层收口
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: 1e21 } } })] }),
      'priority: 须为非负安全整数',
    )
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: 2 ** 53 } } })] }),
      'priority: 须为非负安全整数',
    )
    expect(
      validateTrackRegistry(
        cfg({
          tracks: [
            entry({
              policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: Number.MAX_SAFE_INTEGER } },
            }),
          ],
        }),
        CTX,
      ),
    ).toEqual([])
  })

  test('priority -0 → 被拒（serialize 写 0、parse 读 +0，破坏 serialize 宣称的严格结构相等；codex R4 note）', () => {
    const p = VALID_ENTRY.policyProfile!
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: -0 } } })] }),
      '不含 -0',
    )
    // +0 合法（对照，证明只拒负零这一个 Object.is 判别的值）
    expect(
      validateTrackRegistry(
        cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: 'x', priority: 0 } } })] }),
        CTX,
      ),
    ).toEqual([])
  })

  test('routing.enabled=false 却带 pattern/exclude_pattern/priority → 被拒', () => {
    const p = VALID_ENTRY.policyProfile!
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: false, pattern: 'x' } } })] }),
      'enabled=false 时不接受 pattern/exclude_pattern/priority',
    )
  })

  test("skills.profile 不在 skillProfiles ∪ {'_all'} → 被拒；'_all' 与集合内值放行", () => {
    const p = VALID_ENTRY.policyProfile!
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, skills: { matrix: true, profile: 'ghost' } } })] }),
      "'ghost' 不在 manifest skill profile 集合",
    )
    expect(
      validateTrackRegistry(
        cfg({ tracks: [entry({ policyProfile: { ...p, skills: { matrix: false, profile: '_all' } } })] }),
        CTX,
      ),
    ).toEqual([])
  })

  test('skills.matrix 缺失 → 被拒', () => {
    const p = VALID_ENTRY.policyProfile!
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, skills: { profile: 'backend' } } })] }),
      'skills.matrix: 缺失或非布尔',
    )
  })
})

describe('validateTrackRegistry —— 可表示域（serialize 拒绝面前移，writer 合同 R2 阻断 2）', () => {
  const BOTH_QUOTES = `a'b"c`

  test('label 同含单双引号 → 被拒（builtins 覆写与额外 track 两处；结构档同样拒）', () => {
    expectError(cfg({ builtins: { chat: { label: BOTH_QUOTES } } }), '单双引号')
    expectError(cfg({ tracks: [entry({ label: BOTH_QUOTES })] }), '单双引号')
    expect(
      validateTrackConfigStructure(cfg({ tracks: [entry({ label: BOTH_QUOTES })] })).some((e) =>
        e.includes('单双引号'),
      ),
    ).toBe(true)
  })

  test('内嵌 tab / 换行 / 回车 → 被拒（serialize 窄子集写不出）', () => {
    expectError(cfg({ tracks: [entry({ label: 'a\tb' })] }), 'tab')
    expectError(cfg({ tracks: [entry({ label: 'a\nb' })] }), '换行')
    expectError(cfg({ tracks: [entry({ label: 'a\rb' })] }), '回车')
  })

  test('routing.pattern / skills.profile / workflow.default / allowed[] 与 label 同享一个拒绝面（共享谓词）', () => {
    const p = VALID_ENTRY.policyProfile!
    // x'y"z 是合法 JS 正则（引号皆字面量），只有可表示域规则会拒它
    expectError(
      cfg({ tracks: [entry({ policyProfile: { ...p, routing: { enabled: true, pattern: `x'y"z`, priority: 1 } } })] }),
      '单双引号',
    )
    // profile 用结构档隔离 membership 报错，单独验证可表示域规则本身
    const profileBad = cfg({
      tracks: [entry({ policyProfile: { ...p, skills: { matrix: true, profile: BOTH_QUOTES } } })],
    })
    expect(validateTrackConfigStructure(profileBad).some((e) => e.includes('单双引号'))).toBe(true)
    const wfBad = cfg({ tracks: [entry({ workflow: { default: BOTH_QUOTES, allowed: [BOTH_QUOTES] } })] })
    const wfErrors = validateTrackConfigStructure(wfBad)
    expect(wfErrors.some((e) => e.includes('workflow.default') && e.includes('单双引号'))).toBe(true)
    expect(wfErrors.some((e) => e.includes('allowed[0]') && e.includes('单双引号'))).toBe(true)
  })

  test('拒绝面一字不多：只含单引号 / 只含双引号 / 前后导空白（serialize 引号策略可表示）照旧合法', () => {
    expect(validateTrackRegistry(cfg({ tracks: [entry({ label: "it's fine" })] }), CTX)).toEqual([])
    expect(validateTrackRegistry(cfg({ tracks: [entry({ label: 'say "hi"' })] }), CTX)).toEqual([])
    expect(validateTrackRegistry(cfg({ tracks: [entry({ label: ' 边缘空白 ' })] }), CTX)).toEqual([])
  })
})

describe('validateTrackRegistry —— 总量上限', () => {
  function manyTracks(n: number): ProjectTrackEntryConfig[] {
    return Array.from({ length: n }, (_, i) => entry({ id: `extra-${i}` }))
  }

  test('内建 6 + 额外 27 = 33 → 合法；新增 builtin 不挤占历史 27 个额外名额', () => {
    expect(validateTrackRegistry(cfg({ tracks: manyTracks(27) }), CTX)).toEqual([])
    expect(MAX_TRACKS).toBe(34)
    expectError(cfg({ tracks: manyTracks(28) }), `超过上限 ${MAX_CUSTOM_TRACKS}`)
  })
})

describe('validateTrackConfigStructure —— 上下文无关子集（非完整校验）', () => {
  test('子集职责边界：ghost workflow/profile 引用不在本层报——完整校验由 writeTrackRegistry 写盘前强制（合同用例见 registry.test.ts）', () => {
    const ghostRefs = cfg({
      tracks: [entry({ workflow: { default: 'ghost', allowed: '*' }, policyProfile: { ...VALID_ENTRY.policyProfile!, skills: { matrix: true, profile: 'ghost' } } })],
    })
    // 本层拿不到 workflowExists/skillProfiles，ghost 引用零报错是职责边界而非「合法」——
    // 同一配置在完整校验下 2 条错（default 与 profile 各一）。
    expect(validateTrackConfigStructure(ghostRefs)).toEqual([])
    expect(validateTrackRegistry(ghostRefs, CTX).length).toBe(2)

    // 上下文无关规则（重名/闭集/正则/上限/allowed 显式声明）在子集里照报
    const structuralBad = cfg({ tracks: [entry({ id: 'pm' })] })
    expect(validateTrackConfigStructure(structuralBad).some((e) => e.includes('与内建 track 重名'))).toBe(true)
    const omittedAllowed = cfg({ tracks: [entry({ workflow: { default: 'wf-a' } })] })
    expect(validateTrackConfigStructure(omittedAllowed).some((e) => e.includes('workflow.allowed: 缺失'))).toBe(true)
  })
})
