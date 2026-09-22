/**
 * BACKLOG #18 · manifest 全派生面测试 —— mandatory/recommended skills、breadcrumb prose
 * 的真派生用例，以及旧路由字段的显式迁移拒绝。
 *
 * C9 真测试纪律：manifest 派生是纯函数 → 真测试 = 真读 templates/manifest.yaml → 真 loadManifest →
 * 断言真实派生输出。改 yaml 数据 → 派生随之变（单一真相源钉死，非硬编码回归锚——正是老仓
 * review_phases 半接线欠账的反面证据：数据即行为，零硬编码）。真文件、真解析，不需 mock。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHASES } from '../types.js'
import { loadManifest, ManifestError, skillsFor, skillTokenAlternatives } from './manifest.js'

/** 仓库根 templates/manifest.yaml（相对本文件定位，不依赖 cwd） */
const TEMPLATE_MANIFEST = fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url))

/** 写一个含全部合法结构（phases/transitions/review_phases）+ 追加自定义节的临时 manifest */
function writeManifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-derive-'))
  const p = join(dir, 'manifest.yaml')
  const base = [
    'phases:',
    ...PHASES.map((ph) => `  - ${ph}`),
    'transitions:',
    '  open: [explore]',
    '  explore: [spec]',
    '  spec: [build]',
    '  build: [verify]',
    '  verify: [ship, build]',
    '  ship: [archive]',
    '  archive: [archive]',
    'review_phases: [explore, spec, verify]',
  ].join('\n')
  writeFileSync(p, base + '\n' + body + '\n')
  return p
}

describe('派生面 · mandatory / recommended skills（evidence 派生，对齐 manifest.py:evidence 346-355）', () => {
  it('真读 templates：per phase×track 强制 skill 表逐字派生', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    expect(m.mandatorySkills.explore.pm).toEqual(['brainstorming', 'grilling', 'domain-modeling'])
    expect(m.mandatorySkills.explore.backend).toEqual([
      'openspec-explore',
      'brainstorming',
      'grilling',
      'domain-modeling',
      'codebase-design',
    ])
    expect(m.mandatorySkills.build.backend).toEqual(['test-driven-development'])
    expect(m.mandatorySkills.explore.free).toEqual(['brainstorming'])
    expect(m.mandatorySkills.spec.free).toEqual(['openspec-propose', 'writing-plans'])
    expect(m.mandatorySkills.build.free).toEqual(['test-driven-development'])
    expect(m.mandatorySkills.verify.free).toEqual(['verification-before-completion'])
    expect(m.mandatorySkills.ship.free).toEqual(['finishing-a-development-branch'])
    // 默认 workflow 只引用插件内置 skill，archive 无强制 skill。
    expect(m.mandatorySkills.verify.frontend).toContain('verification-before-completion')
    expect(m.mandatorySkills.archive).toEqual({})
  })

  it('真读 templates：推荐 skill 表已空——一步该加载什么由 default.yaml 说清楚', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    for (const ph of PHASES) expect(m.recommendedSkills[ph], `recommended for ${ph}`).toEqual({})
  })

  it('skillsFor：per-track → _all 兜底 → 空，三级回退与老 evidence 同语义', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    // open 只声明 _all，任一 track 都命中 _all 兜底
    expect(skillsFor(m.mandatorySkills, 'open', 'backend')).toEqual(['openspec-propose'])
    expect(skillsFor(m.mandatorySkills, 'open', 'pm')).toEqual(['openspec-propose'])
    expect(skillsFor(m.mandatorySkills, 'open', 'free')).toEqual(['openspec-propose'])
    // per-track 优先于 _all
    expect(skillsFor(m.mandatorySkills, 'explore', 'pm')).toEqual(['brainstorming', 'grilling', 'domain-modeling'])
    // 无声明 → 空
    expect(skillsFor(m.recommendedSkills, 'archive', 'backend')).toEqual([])
    expect(skillsFor(m.mandatorySkills, 'verify', 'chat')).toEqual([])
  })

  it('单一真相源钉死：改 yaml 的 skill 数据 → 派生随之变（非硬编码）', () => {
    const p = writeManifest(
      [
        'mandatory_skills:',
        '  build.backend: [only-this-one]',
        '  spec._all: [shared-a, shared-b]',
        'recommended_skills:',
        '  build.pm: [rec-x]',
      ].join('\n'),
    )
    const m = loadManifest(p)
    expect(m.mandatorySkills.build.backend).toEqual(['only-this-one'])
    // _all 兜底：spec 的任意 track 命中 shared
    expect(skillsFor(m.mandatorySkills, 'spec', 'frontend')).toEqual(['shared-a', 'shared-b'])
    expect(m.recommendedSkills.build.pm).toEqual(['rec-x'])
    // 未声明的 phase → 空（不继承 templates 的硬编码值）
    expect(m.mandatorySkills.explore).toEqual({})
  })

  it('fail-loud：mandatory_skills 未知 track → ManifestError（老 evidence fail-open 的改进）', () => {
    const p = writeManifest(['mandatory_skills:', '  build.wat: [x]'].join('\n'))
    expect(() => loadManifest(p)).toThrow(ManifestError)
  })

  it('fail-loud：mandatory_skills 未声明相位 → ManifestError', () => {
    const p = writeManifest(['mandatory_skills:', '  bogus.pm: [x]'].join('\n'))
    expect(() => loadManifest(p)).toThrow(ManifestError)
  })

  it('缺 skill 节（最小 manifest）→ 空表且不抛（向后兼容）', () => {
    const p = writeManifest('')
    const m = loadManifest(p)
    for (const ph of PHASES) {
      expect(m.mandatorySkills[ph]).toEqual({})
      expect(m.recommendedSkills[ph]).toEqual({})
    }
  })
})

describe('旧 manifest 路由字段迁移边界', () => {
  it('旧顶层 router_patterns 必须 fail-loud，并明确迁移到 tracks.yaml policy_profile.routing', () => {
    const p = writeManifest(
      [
        'router_patterns:',
        "  frontend: '(tsx|vue)'",
        "  backend: '(api|db)'",
        "  pm: '(prd|市场)'",
      ].join('\n'),
    )

    expect(() => loadManifest(p)).toThrow(
      /router_patterns.*已迁移.*\.pipeline\/tracks\.yaml.*policy_profile\.routing/i,
    )
  })

  it('旧顶层 router_patterns 即使写成 inline 值，也必须给出同一迁移诊断', () => {
    const p = writeManifest("router_patterns: { frontend: '(tsx)' }")

    expect(() => loadManifest(p)).toThrow(
      /router_patterns.*已迁移.*\.pipeline\/tracks\.yaml.*policy_profile\.routing/i,
    )
  })

  it.each([
    ['双引号顶层键', '"router_patterns": { frontend: "(tsx)" }'],
    ['单引号顶层键', "'router_patterns': { frontend: '(tsx)' }"],
    ['根级缩进块', "  router_patterns:\n    frontend: '(tsx)'"],
  ])('%s 仍必须给出同一迁移诊断', (_label, legacySection) => {
    const p = writeManifest(legacySection)

    expect(() => loadManifest(p)).toThrow(
      /router_patterns.*已迁移.*\.pipeline\/tracks\.yaml.*policy_profile\.routing/i,
    )
  })

  it.each([
    ['双引号 unicode 转义键', '"router_\\u0070atterns": { frontend: "(tsx)" }'],
    ['双引号 hex 转义键', '"router_\\x70atterns": { frontend: "(tsx)" }'],
    ['双引号长 unicode 转义键', '"router_\\U00000070atterns": { frontend: "(tsx)" }'],
    ['显式 mapping key', "? router_patterns\n: { frontend: '(tsx)' }"],
    ['显式 mapping key + 转义', '? "router_\\u0070atterns"\n: { frontend: "(tsx)" }'],
  ])('%s 按 YAML 解码后等价于旧字段，必须给出迁移诊断', (_label, legacySection) => {
    const p = writeManifest(legacySection)

    expect(() => loadManifest(p)).toThrow(
      /router_patterns.*已迁移.*\.pipeline\/tracks\.yaml.*policy_profile\.routing/i,
    )
  })

  it('显式 block-scalar key 等价于旧字段时，窄解析拒绝也必须附带迁移诊断', () => {
    const p = writeManifest("? |-\n  router_patterns\n: { frontend: '(tsx)' }")

    expect(() => loadManifest(p)).toThrow(
      /router_patterns.*已迁移.*\.pipeline\/tracks\.yaml.*policy_profile\.routing/i,
    )
  })

})

describe('派生面 · breadcrumb prose（对齐 manifest.py breadcrumb 子命令 1031-1037）', () => {
  it('真读 templates：7 相位 breadcrumb 均非空、各一行指向 step.next', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    for (const ph of PHASES) {
      expect(m.breadcrumbs[ph], `breadcrumb for ${ph}`).toBeTruthy()
      expect(m.breadcrumbs[ph]!.split('\n')).toHaveLength(1)
      expect(m.breadcrumbs[ph]).toContain('tenon status <change> --json')
    }
    expect(m.breadcrumbs.open).toContain('立项')
    expect(m.breadcrumbs.explore).toContain('调研')
    // 末尾换行被 rstrip（对齐老 CLI `bc.rstrip("\n")`）
    expect(m.breadcrumbs.verify!.endsWith('\n')).toBe(false)
  })

  it('单一真相源钉死：改 yaml 的 breadcrumb block scalar → 派生逐字变（含内部换行/空行）', () => {
    const p = writeManifest(
      [
        'breadcrumb:',
        '  open: |',
        '    第一行内容',
        '    第二行内容',
        '',
        '    段落二',
        '  build: |',
        '    仅一行',
      ].join('\n'),
    )
    const m = loadManifest(p)
    expect(m.breadcrumbs.open).toBe('第一行内容\n第二行内容\n\n段落二')
    expect(m.breadcrumbs.build).toBe('仅一行')
    // 未声明的相位 breadcrumb 缺省 undefined
    expect(m.breadcrumbs.verify).toBeUndefined()
  })

  it('缺 breadcrumb 节 → 空对象且不抛', () => {
    const m = loadManifest(writeManifest(''))
    expect(m.breadcrumbs).toEqual({})
  })

  it('fail-loud：breadcrumb 未声明相位 → ManifestError', () => {
    const p = writeManifest(['breadcrumb:', '  bogus: |', '    x'].join('\n'))
    expect(() => loadManifest(p)).toThrow(ManifestError)
  })
})

describe('派生面 · versioned Skill action authority', () => {
  it('真读 templates：显式 closed actions 独立于 mandatory/recommended slots', () => {
    const manifest = loadManifest(TEMPLATE_MANIFEST)
    expect(manifest.skillActionAuthority).toEqual({
      version: 'v1',
      grants: {
        _all: ['enter-afk'],
        pm: ['enter-afk'],
        frontend: ['enter-afk'],
        backend: ['enter-afk'],
        free: [],
      },
    })
  })

  it('缺 authority 节诚实返回 null，不从 skill slots 推断', () => {
    const manifest = loadManifest(writeManifest('mandatory_skills:\n  build.backend: [test-driven-development]'))
    expect(manifest.skillActionAuthority).toBeNull()
  })

  it.each([
    ['unknown version', 'skill_action_authority:\n  version: v2\n  _all: [enter-afk]'],
    ['unknown profile', 'skill_action_authority:\n  version: v1\n  arbitrary: [enter-afk]'],
    ['unknown action', 'skill_action_authority:\n  version: v1\n  _all: [invent-action]'],
    ['empty action', 'skill_action_authority:\n  version: v1\n  _all: [enter-afk, ]'],
    ['duplicate section', 'skill_action_authority:\n  version: v1\n  _all: [enter-afk]\nskill_action_authority:\n  version: v1\n  _all: [enter-afk]'],
  ])('fail-loud: %s', (_label, body) => {
    expect(() => loadManifest(writeManifest(body))).toThrow(ManifestError)
  })
})

describe('派生面 · 回归锚（既有 phases/transitions/reviewPhases 派生不受新增节影响）', () => {
  it('templates 加派生节后，核心三派生仍稳定', () => {
    const m = loadManifest(TEMPLATE_MANIFEST)
    expect(m.phases).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    expect(m.transitions.verify).toEqual(['ship', 'build'])
    expect(m.reviewPhases).toEqual(['explore', 'spec', 'verify'])
  })
})

describe('skillTokenAlternatives（G2 P5：manifest a|b 备选归一）', () => {
  it('无 | 的具体 token → 单元素 [token]', () => {
    expect(skillTokenAlternatives('superpowers:brainstorming')).toEqual(['superpowers:brainstorming'])
    expect(skillTokenAlternatives('grill-with-docs')).toEqual(['grill-with-docs'])
  })

  it('a|b 备选 → 逐 branch 拆分保序（对齐 templates/manifest.yaml 的 opsx:explore|openspec-explore）', () => {
    expect(skillTokenAlternatives('opsx:explore|openspec-explore')).toEqual(['opsx:explore', 'openspec-explore'])
    expect(skillTokenAlternatives('design-taste-frontend|taste-skill')).toEqual(['design-taste-frontend', 'taste-skill'])
  })

  it('三段备选 a|b|c → 三 branch', () => {
    expect(skillTokenAlternatives('a|b|c')).toEqual(['a', 'b', 'c'])
  })

  it('空 branch（a|、|b、a||b）/ 纯空白 branch（a| |b）→ fail-loud（不静默过滤畸形 token）', () => {
    expect(() => skillTokenAlternatives('a|')).toThrow(ManifestError)
    expect(() => skillTokenAlternatives('|b')).toThrow(/alternative branch/)
    expect(() => skillTokenAlternatives('a||b')).toThrow(/alternative branch/)
    expect(() => skillTokenAlternatives('a| |b')).toThrow(/alternative branch/)
  })

  it('重复 branch（a|a）→ fail-loud', () => {
    expect(() => skillTokenAlternatives('a|a')).toThrow(/重复 alternative branch/)
  })

  it('单独 "." branch → fail-loud（H10 r1 复审阻断4：join(root, ".") 会解析回根目录本身，把整个 skill 根目录当成一个 skill）', () => {
    expect(() => skillTokenAlternatives('.')).toThrow(ManifestError)
    expect(() => skillTokenAlternatives('.')).toThrow(/非法路径段/)
    expect(() => skillTokenAlternatives('a|.')).toThrow(ManifestError)
    expect(() => skillTokenAlternatives('.|a')).toThrow(ManifestError)
  })

  it('namespaced token（plugin:skill）任一 ":" 段为空或恰为 "." → fail-loud（同一类根目录逃逸，只是套了命名空间外壳）', () => {
    expect(() => skillTokenAlternatives('superpowers:.')).toThrow(ManifestError)
    expect(() => skillTokenAlternatives('superpowers:')).toThrow(ManifestError)
    expect(() => skillTokenAlternatives(':brainstorming')).toThrow(ManifestError)
    expect(() => skillTokenAlternatives('opsx:explore|superpowers:.')).toThrow(ManifestError)
  })

  it('合法 namespaced token（如真实 manifest.yaml 里的 superpowers:brainstorming）不受新校验影响，照常通过', () => {
    expect(skillTokenAlternatives('superpowers:brainstorming')).toEqual(['superpowers:brainstorming'])
    expect(skillTokenAlternatives('opsx:apply|openspec-apply-change')).toEqual(['opsx:apply', 'openspec-apply-change'])
  })
})
