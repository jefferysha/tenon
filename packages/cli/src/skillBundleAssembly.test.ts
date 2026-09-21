/**
 * skillBundleAssembly —— H10 §8任务7 CLI 生产装配的物理原语单测：
 *   · productionSkillContentRoots：content-locator 的扁平根枚举（设计 §2「skill 内容从已安装 skill
 *     根目录定位」）——纯函数 + 可注入 readdirDirNames，不碰真机 ~/.claude 目录。
 *   · installedPluginSkillRoots / createProductionSkillContentLocator（H10 r1 复审阻断4）：
 *     `plugin:skill` namespaced id 换算成插件真实 `skills/` 根——单测用可注入的假
 *     installed_plugins.json 文本，不碰真机；另有一条读真机 `~/.claude` 的验证用例（本任务要求
 *     「本机就装着这些插件，实测定位」），CI/无该插件的机器上诚实跳过。
 *   · createExecutionCoordinatePort：claim 后、activate 前捕获「当前 workflow 坐标」
 *     （ExecutionCoordinatePort，设计 §3 步骤2/步骤7）——真 kernel loadWorkflow/compileWorkflow +
 *     mock StateStore（test-support 既有 mockStore，withLock/read 真实语义、write 系列 no-op spy）。
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCanonicalManifest, SkillContentNotFoundError } from '@tenon/automation'
import {
  compileEffectiveWorkflowPlan, createEffectiveSkillResolver, loadManifest, parseWorkflow, resolveSkillBundle,
  workflowPlanSnapshot,
} from '@tenon/kernel'
import { mockState, mockStore } from './test-support.js'
import {
  createExecutionCoordinatePort, createProductionSkillContentLocator,
  InstalledPluginRegistryError, installedPluginSkillRoots, productionSkillContentRoots, SkillCacheSchemaError,
} from './skillBundleAssembly.js'

describe('productionSkillContentRoots', () => {
  const HOME = '/home/u'

  it('pluginRoot 给定时首位是 <pluginRoot>/skills（本仓自带 bundled skills 根）', () => {
    const roots = productionSkillContentRoots({ pluginRoot: '/plugin', home: HOME, readdirDirNames: () => [] })
    expect(roots[0]).toBe(join('/plugin', 'skills'))
  })

  it('pluginRoot 缺省（undefined）→ 该根不出现', () => {
    const roots = productionSkillContentRoots({ home: HOME, readdirDirNames: () => [] })
    expect(roots).not.toContain(join('/plugin', 'skills'))
    expect(roots).toContain(join(HOME, '.codex', 'skills'))
  })

  it('Codex-first：恒含 ~/.codex/skills 与 .system，同时保留 Claude/agents 兼容根', () => {
    const roots = productionSkillContentRoots({ home: HOME, readdirDirNames: () => [] })
    expect(roots).toContain(join(HOME, '.claude', 'skills'))
    expect(roots).toContain(join(HOME, '.codex', 'skills'))
    expect(roots).toContain(join(HOME, '.codex', 'skills', '.system'))
    expect(roots).toContain(join(HOME, '.agents', 'skills'))
  })

  it('按 readdirDirNames 枚举每个 marketplace × plugin 的 skills/ 子目录（多技能插件安装位）', () => {
    const cacheRoot = join(HOME, '.claude', 'plugins', 'cache')
    const readdirDirNames = (dir: string): string[] => {
      if (dir === cacheRoot) return ['mkt-a', 'mkt-b']
      if (dir === join(cacheRoot, 'mkt-a')) return ['plugin-1']
      if (dir === join(cacheRoot, 'mkt-b')) return ['plugin-2']
      return []
    }
    const roots = productionSkillContentRoots({ home: HOME, readdirDirNames })
    expect(roots).toContain(join(cacheRoot, 'mkt-a', 'plugin-1', 'skills'))
    expect(roots).toContain(join(cacheRoot, 'mkt-b', 'plugin-2', 'skills'))
  })

  it('Codex cache 按 <authority>/<plugin>/<version>/skills 枚举，local/skills 同样进入 Codex tier', () => {
    const cacheRoot = join(HOME, '.codex', 'plugins', 'cache')
    const readdirDirNames = (dir: string): string[] => {
      if (dir === cacheRoot) return ['openai-curated-remote', 'claude-plugins-official']
      if (dir === join(cacheRoot, 'openai-curated-remote')) return ['data-analytics']
      if (dir === join(cacheRoot, 'openai-curated-remote', 'data-analytics')) return ['0.2.8-13ceeea1f599']
      if (dir === join(cacheRoot, 'claude-plugins-official')) return ['frontend-design']
      if (dir === join(cacheRoot, 'claude-plugins-official', 'frontend-design')) return ['local']
      return []
    }

    const roots = productionSkillContentRoots({ home: HOME, readdirDirNames })

    const versionedRoot = join(cacheRoot, 'openai-curated-remote', 'data-analytics', '0.2.8-13ceeea1f599', 'skills')
    const localRoot = join(cacheRoot, 'claude-plugins-official', 'frontend-design', 'local', 'skills')
    expect(roots).toContain(versionedRoot)
    expect(roots).toContain(localRoot)
    expect(roots.indexOf(localRoot)).toBeLessThan(roots.indexOf(join(HOME, '.claude', 'skills')))
  })

  it('readdirDirNames 对 cache 根返回空 → 只剩 bundled + Codex-first/兼容固定根', () => {
    const roots = productionSkillContentRoots({ pluginRoot: '/plugin', home: HOME, readdirDirNames: () => [] })
    expect(roots).toEqual([
      join('/plugin', 'skills'),
      join(HOME, '.codex', 'skills'),
      join(HOME, '.codex', 'skills', '.system'),
      join(HOME, '.claude', 'skills'),
      join(HOME, '.agents', 'skills'),
    ])
  })

  it('缺省 readdirDirNames（真 fs）对不存在的 home 目录不抛错，只回退到固定根', () => {
    const roots = productionSkillContentRoots({ home: '/definitely-not-a-real-home-dir-xyz' })
    expect(roots).toContain(join('/definitely-not-a-real-home-dir-xyz', '.claude', 'skills'))
    expect(roots).toContain(join('/definitely-not-a-real-home-dir-xyz', '.agents', 'skills'))
  })

  it('真 Codex cache 枚举遇非 ENOENT（EACCES）→ fail-loud，不伪装成空 cache 后回退', async (ctx) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return ctx.skip()
    const home = await mkdtemp(join(tmpdir(), 'prod-skill-cache-access-'))
    const cache = join(home, '.codex', 'plugins', 'cache')
    await mkdir(cache, { recursive: true })
    await chmod(cache, 0o000)
    try {
      expect(() => productionSkillContentRoots({ home })).toThrow(/cache|EACCES|访问|读取/i)
    } finally {
      await chmod(cache, 0o755)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('cache 枚举返回路径逃逸段（..）→ cache schema 损坏，fail-loud', () => {
    const cache = join(HOME, '.codex', 'plugins', 'cache')
    expect(() => productionSkillContentRoots({
      home: HOME,
      readdirDirNames: (dir) => dir === cache ? ['..'] : [],
    })).toThrow(SkillCacheSchemaError)
  })
})

describe('installedPluginSkillRoots（H10 r1 复审阻断4：plugin:skill 真实布局，真相源 installed_plugins.json）', () => {
  it('换算真实键形状 "<plugin>@<marketplace>" → 插件名 → <installPath>/skills（本机实测过的形状：superpowers@claude-plugins-official）', () => {
    const json = JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@claude-plugins-official': [
          {
            scope: 'user',
            installPath: '/Users/u/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1',
            version: '6.1.1',
          },
        ],
      },
    })
    const roots = installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => json })
    expect(roots.get('superpowers')).toEqual([
      join('/Users/u/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1', 'skills'),
    ])
  })

  it('同一插件名出现在多条 entry（多 scope/多 marketplace 装同名插件）→ 全部根都纳入，不丢也不去重成一个', () => {
    const json = JSON.stringify({
      plugins: {
        'demo@mkt-a': [{ installPath: '/root-a' }],
        'demo@mkt-b': [{ installPath: '/root-b' }],
      },
    })
    const roots = installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => json })
    expect(roots.get('demo')).toEqual([join('/root-a', 'skills'), join('/root-b', 'skills')])
  })

  it('文件 ENOENT（null）→ 空表；文件存在但空文本 → registry 损坏 fail-loud', () => {
    const roots = installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => null })
    expect(roots.size).toBe(0)
    expect(() => installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => '' }))
      .toThrow(InstalledPluginRegistryError)
  })

  it('JSON 语法损坏 → fail-loud，不伪装成插件未安装', () => {
    expect(() => installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => '{not valid json' }))
      .toThrow('不是合法 JSON')
  })

  it('entry 缺 installPath / installPath 非字符串/空串 → registry entry schema 损坏，fail-loud', () => {
    const json = JSON.stringify({
      plugins: {
        'demo@mkt': [{ scope: 'user' }, { installPath: 123 }, { installPath: '' }],
      },
    })
    expect(() => installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => json }))
      .toThrow(InstalledPluginRegistryError)
  })

  it('plugins 字段整体缺失/形状不对 → registry schema 损坏，fail-loud', () => {
    expect(() => installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => '{}' }))
      .toThrow(InstalledPluginRegistryError)
    expect(() => installedPluginSkillRoots({
      home: '/home/u', readInstalledPluginsJson: () => JSON.stringify({ plugins: 'nope' }),
    })).toThrow(InstalledPluginRegistryError)
  })

  it('plugin registry key 不是 <plugin>@<marketplace> → schema 损坏，fail-loud', () => {
    const json = JSON.stringify({ plugins: { demo: [{ installPath: '/cache/demo/1.0.0' }] } })
    expect(() => installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => json }))
      .toThrow(InstalledPluginRegistryError)
  })

  it('plugin registry installPath 不是绝对路径 → schema 损坏，fail-loud', () => {
    const json = JSON.stringify({ plugins: { 'demo@mkt': [{ installPath: 'relative/cache/demo' }] } })
    expect(() => installedPluginSkillRoots({ home: '/home/u', readInstalledPluginsJson: () => json }))
      .toThrow(InstalledPluginRegistryError)
  })

  it('缺省 readInstalledPluginsJson（真 fs）对不存在的 home 不抛错，只回退到空表', () => {
    const roots = installedPluginSkillRoots({ home: '/definitely-not-a-real-home-dir-xyz' })
    expect(roots.size).toBe(0)
  })
})

describe('createProductionSkillContentLocator（H10 r1 复审阻断4：唯一生产 locator——裸 id 走扁平根，namespaced id 走真实插件根）', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'prod-skill-locator-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function makeSkillDir(baseDir: string, id: string, content: string): Promise<string> {
    const dir = join(baseDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
    return dir
  }

  async function writeBundledRegistry(pluginRoot: string, skill: string, token = skill): Promise<void> {
    const manifest = await buildCanonicalManifest(skill, join(pluginRoot, 'skills', skill))
    const digest = `sha256:${manifest.treeSha256}`
    await mkdir(join(pluginRoot, 'templates'), { recursive: true })
    await writeFile(join(pluginRoot, 'templates', 'skill-sources.yaml'), [
      'version: 3',
      'hash_algorithm: tree-sha256-v1',
      'skills:',
      `  ${token}: { tool: bundled, source: tenon, content_skill: ${skill}, tier: mandatory, official: true, source_kind: bundled, source_ref: skills/${skill}, content_hash: ${digest}, coordinate: tenon:skills/${skill}@${digest} }`,
      '',
    ].join('\n'), 'utf8')
  }

  it('runner=codex：仅存在于 ~/.claude 的裸 skill 不可用于 readiness，且不读取 Claude registry', async () => {
    const home = join(root, 'home')
    await makeSkillDir(join(home, '.claude', 'skills'), 'claude-only', '# claude only')
    let registryReads = 0
    const locator = createProductionSkillContentLocator({
      home,
      runner: 'codex',
      readdirDirNames: () => [],
      readInstalledPluginsJson: () => {
        registryReads++
        return null
      },
    })

    await expect(locator.locate('claude-only')).rejects.toBeInstanceOf(SkillContentNotFoundError)
    expect(registryReads).toBe(0)
  })

  it('runner=codex：仅存在于 Claude registry 的 namespaced skill 不可用于 readiness', async () => {
    const home = join(root, 'home')
    const installPath = join(home, '.claude', 'plugins', 'cache', 'market', 'vendor', '1.0.0')
    await makeSkillDir(join(installPath, 'skills'), 'leaf', '# claude plugin leaf')
    let registryReads = 0
    const locator = createProductionSkillContentLocator({
      home,
      runner: 'codex',
      readdirDirNames: () => [],
      readInstalledPluginsJson: () => {
        registryReads++
        return JSON.stringify({ plugins: { 'vendor@market': [{ installPath }] } })
      },
    })

    await expect(locator.locate('vendor:leaf')).rejects.toBeInstanceOf(SkillContentNotFoundError)
    expect(registryReads).toBe(0)
  })

  it('runner=codex：skills CLI 安装到 ~/.agents/skills 的裸 skill 可用于 readiness', async () => {
    const home = join(root, 'home')
    const agentsDir = await makeSkillDir(join(home, '.agents', 'skills'), 'grill-with-docs', '# agent neutral')
    const locator = createProductionSkillContentLocator({
      home, runner: 'codex', readdirDirNames: () => [], readInstalledPluginsJson: () => null,
    })

    const located = await locator.locate('grill-with-docs')

    expect(located.contentDir).toBe(await realpath(agentsDir))
  })

  it('runner=codex：registry 逻辑 token 映射到 skills-cli 当前真实安装 id', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    await mkdir(join(pluginRoot, 'templates'), { recursive: true })
    await writeFile(join(pluginRoot, 'templates', 'skill-sources.yaml'), [
      'version: 1',
      'skills:',
      '  react-best-practices: { tool: skills-cli, source: vercel-labs/agent-skills, skill: vercel-react-best-practices, tier: recommended, official: false }',
      '',
    ].join('\n'), 'utf8')
    const installed = await makeSkillDir(join(home, '.agents', 'skills'), 'vercel-react-best-practices', '# current upstream id')
    const locator = createProductionSkillContentLocator({
      home, pluginRoot, runner: 'codex', readdirDirNames: () => [], readInstalledPluginsJson: () => null,
    })

    const located = await locator.locate('react-best-practices')

    expect(located).toEqual({ skillId: 'react-best-practices', contentDir: await realpath(installed) })
  })

  it('runner=codex：plugin 逻辑 token 映射到 Codex plugin 内的真实 skill id', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    await mkdir(join(pluginRoot, 'templates'), { recursive: true })
    await writeFile(join(pluginRoot, 'templates', 'skill-sources.yaml'), [
      'version: 1',
      'skills:',
      '  tailwind-css-patterns: { tool: claude-plugin, source: agents-inc, skill: web-styling-tailwind, tier: recommended, official: false }',
      '',
    ].join('\n'), 'utf8')
    const installed = await makeSkillDir(
      join(home, '.codex', 'plugins', 'cache', 'agents-inc', 'web-styling-tailwind', '5.0.0', 'skills'),
      'web-styling-tailwind',
      '# tailwind',
    )
    const locator = createProductionSkillContentLocator({
      home, pluginRoot, runner: 'codex', readInstalledPluginsJson: () => null,
    })

    const located = await locator.locate('tailwind-css-patterns')

    expect(located).toEqual({ skillId: 'tailwind-css-patterns', contentDir: await realpath(installed) })
  })

  it('runner=codex：builtin 逻辑 token 通过 content_skill 映射到可冻结的真实 Codex skill 内容', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    await mkdir(join(pluginRoot, 'templates'), { recursive: true })
    await writeFile(join(pluginRoot, 'templates', 'skill-sources.yaml'), [
      'version: 1',
      'skills:',
      '  verify: { tool: builtin, source: claude-code, content_skill: verification-before-completion, tier: mandatory, official: true }',
      '',
    ].join('\n'), 'utf8')
    const installed = await makeSkillDir(
      join(home, '.codex', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '6.1.1', 'skills'),
      'verification-before-completion',
      '# verification before completion',
    )
    const locator = createProductionSkillContentLocator({ home, pluginRoot, runner: 'codex' })

    const located = await locator.locate('verify')

    expect(located).toEqual({ skillId: 'verify', contentDir: await realpath(installed) })
  })

  it('runner=claude-code：仍可从 ~/.claude/skills 定位兼容 skill', async () => {
    const home = join(root, 'home')
    const claudeDir = await makeSkillDir(join(home, '.claude', 'skills'), 'claude-compatible', '# compatible')
    const locator = createProductionSkillContentLocator({
      home, runner: 'claude-code', readdirDirNames: () => [], readInstalledPluginsJson: () => null,
    })

    const located = await locator.locate('claude-compatible')

    expect(located.contentDir).toBe(await realpath(claudeDir))
  })

  it('裸 skill id（无 ":"）→ 委托 productionSkillContentRoots 的扁平根，行为与既有 flat locator 一致', async () => {
    const home = join(root, 'home')
    await makeSkillDir(join(home, '.claude', 'skills'), 'bare-skill', '# bare')
    const locator = createProductionSkillContentLocator({
      home, readdirDirNames: () => [], readInstalledPluginsJson: () => null,
    })
    const located = await locator.locate('bare-skill')
    expect(located.skillId).toBe('bare-skill')
    expect(located.contentDir).toContain('bare-skill')
  })

  it('Codex tier 有候选时直接采用 Codex 内容，不把不同内容的 Claude 候选混入歧义判定', async () => {
    const home = join(root, 'home')
    const codexDir = await makeSkillDir(join(home, '.codex', 'skills'), 'shared-skill', '# codex')
    await makeSkillDir(join(home, '.claude', 'skills'), 'shared-skill', '# claude fallback')
    const locator = createProductionSkillContentLocator({
      home, readdirDirNames: () => [], readInstalledPluginsJson: () => null,
    })

    const located = await locator.locate('shared-skill')

    expect(located.contentDir).toBe(await realpath(codexDir))
  })

  it('selected bundle authority：pluginRoot 与 Codex global 同名内容不同时采用 bundle', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    const bundled = await makeSkillDir(join(pluginRoot, 'skills'), 'brainstorming', '# bundled')
    await writeBundledRegistry(pluginRoot, 'brainstorming')
    await makeSkillDir(join(home, '.codex', 'skills'), 'brainstorming', '# divergent global')
    const locator = createProductionSkillContentLocator({
      home,
      pluginRoot,
      readdirDirNames: () => [],
      readInstalledPluginsJson: () => null,
    })

    const located = await locator.locate('brainstorming')

    expect(located.contentDir).toBe(await realpath(bundled))
  })

  it('runner-specific locator 也必须先通过 bundled provenance，drift 不得降级到 Codex tier', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    await makeSkillDir(join(pluginRoot, 'skills'), 'brainstorming', '# bundled')
    await writeBundledRegistry(pluginRoot, 'brainstorming')
    await makeSkillDir(join(home, '.codex', 'skills'), 'brainstorming', '# lower tier')
    await writeFile(join(pluginRoot, 'skills', 'brainstorming', 'SKILL.md'), '# drift\n', 'utf8')
    const locator = createProductionSkillContentLocator({
      home,
      pluginRoot,
      runner: 'codex',
      readdirDirNames: () => [],
      readInstalledPluginsJson: () => null,
    })

    await expect(locator.locate('brainstorming')).rejects.toMatchObject({ category: 'content-hash-mismatch' })
  })

  it('v3 declared bundled root missing rejects before lower-tier fallback', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    await makeSkillDir(join(pluginRoot, 'skills'), 'brainstorming', '# bundled')
    await writeBundledRegistry(pluginRoot, 'brainstorming')
    await rm(join(pluginRoot, 'skills'), { recursive: true, force: true })
    await makeSkillDir(join(home, '.codex', 'skills'), 'brainstorming', '# lower tier')
    let lowerTierReads = 0
    const locator = createProductionSkillContentLocator({
      home,
      pluginRoot,
      runner: 'codex',
      readdirDirNames: () => {
        lowerTierReads += 1
        return []
      },
      readInstalledPluginsJson: () => null,
    })

    await expect(locator.locate('brainstorming')).rejects.toMatchObject({ name: 'SkillProvenanceLocatorError' })
    expect(lowerTierReads).toBe(0)
  })

  it('malformed current registry rejects before lower-tier fallback even without bundled root', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    await mkdir(join(pluginRoot, 'templates'), { recursive: true })
    await writeFile(join(pluginRoot, 'templates', 'skill-sources.yaml'), 'version: 4\nnot: a registry\n', 'utf8')
    await makeSkillDir(join(home, '.codex', 'skills'), 'brainstorming', '# lower tier')
    let lowerTierReads = 0
    const locator = createProductionSkillContentLocator({
      home,
      pluginRoot,
      runner: 'codex',
      readdirDirNames: () => {
        lowerTierReads += 1
        return []
      },
      readInstalledPluginsJson: () => null,
    })

    await expect(locator.locate('brainstorming')).rejects.toMatchObject({ name: 'SkillProvenanceLocatorError' })
    expect(lowerTierReads).toBe(0)
  })

  it('selected bundle authority：bundle 命中时不枚举损坏的 lower-trust Codex cache', async () => {
    const home = join(root, 'home')
    const pluginRoot = join(root, 'plugin')
    const bundled = await makeSkillDir(join(pluginRoot, 'skills'), 'brainstorming', '# bundled')
    await writeBundledRegistry(pluginRoot, 'brainstorming')
    let lowerTierReads = 0
    const locator = createProductionSkillContentLocator({
      home,
      pluginRoot,
      readdirDirNames: () => {
        lowerTierReads += 1
        throw new SkillCacheSchemaError('damaged lower-trust cache')
      },
      readInstalledPluginsJson: () => null,
    })

    await expect(locator.locate('brainstorming')).resolves.toEqual({
      skillId: 'brainstorming',
      contentDir: await realpath(bundled),
    })
    expect(lowerTierReads).toBe(0)
  })

  it('Codex tier 有候选时不读取损坏的 Claude fallback registry', async () => {
    const home = join(root, 'home')
    const codexDir = await makeSkillDir(join(home, '.codex', 'skills'), 'codex-only', '# codex')
    let registryReads = 0
    const locator = createProductionSkillContentLocator({
      home,
      readdirDirNames: () => [],
      readInstalledPluginsJson: () => {
        registryReads += 1
        return '{broken fallback registry'
      },
    })

    const located = await locator.locate('codex-only')

    expect(located.contentDir).toBe(await realpath(codexDir))
    expect(registryReads).toBe(0)
  })

  it('裸 skill 能从真实 Codex cache 的 <authority>/<plugin>/<version>/skills 布局定位', async () => {
    const home = join(root, 'home')
    const cachedDir = await makeSkillDir(
      join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'data-analytics', '0.2.8-13ceeea1f599', 'skills'),
      'build-report',
      '# cached build report',
    )
    const locator = createProductionSkillContentLocator({ home })

    const located = await locator.locate('build-report')

    expect(located.contentDir).toBe(await realpath(cachedDir))
  })

  it('Codex tier 无候选时，裸 skill 回退到 Claude registry 指向的真实 versioned plugin cache', async () => {
    const home = join(root, 'home')
    const installPath = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '6.1.1')
    const fallbackDir = await makeSkillDir(join(installPath, 'skills'), 'brainstorming', '# claude fallback')
    const registry = JSON.stringify({
      plugins: { 'superpowers@claude-plugins-official': [{ installPath }] },
    })
    const locator = createProductionSkillContentLocator({
      home, readdirDirNames: () => [], readInstalledPluginsJson: () => registry,
    })

    const located = await locator.locate('brainstorming')

    expect(located.contentDir).toBe(await realpath(fallbackDir))
  })

  it('Codex cache 的 version entry 不是目录 → schema 损坏 fail-loud，不回退 agents 同名 skill', async () => {
    const home = join(root, 'home')
    const pluginDir = join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'broken-plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'not-a-version-directory'), 'broken cache entry', 'utf8')
    await makeSkillDir(join(home, '.agents', 'skills'), 'fallback-skill', '# agents fallback')

    await expect(async () => {
      const locator = createProductionSkillContentLocator({ home, readInstalledPluginsJson: () => null })
      await locator.locate('fallback-skill')
    }).rejects.toThrow(/cache.*schema|schema.*cache/i)
  })

  it('Codex cache 的 version entry 是悬空 symlink → schema 损坏 fail-loud，不按 ENOENT 回退', async () => {
    const home = join(root, 'home')
    const pluginDir = join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'broken-plugin')
    await mkdir(pluginDir, { recursive: true })
    await symlink(join(root, 'missing-version-target'), join(pluginDir, 'dangling-version'))
    await makeSkillDir(join(home, '.agents', 'skills'), 'fallback-skill', '# agents fallback')

    await expect(async () => {
      const locator = createProductionSkillContentLocator({ home, readInstalledPluginsJson: () => null })
      await locator.locate('fallback-skill')
    }).rejects.toThrow(/cache.*schema|schema.*cache/i)
  })

  it('Codex cache 的 .codex-remote-plugin-install.json 损坏 → cache schema fail-loud', async () => {
    const home = join(root, 'home')
    const pluginDir = join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'remote-plugin')
    await makeSkillDir(join(pluginDir, '1.0.0', 'skills'), 'cached-skill', '# cached')
    await writeFile(join(pluginDir, '.codex-remote-plugin-install.json'), '{not valid json', 'utf8')

    await expect(async () => {
      const locator = createProductionSkillContentLocator({ home, readInstalledPluginsJson: () => null })
      await locator.locate('cached-skill')
    }).rejects.toThrow(SkillCacheSchemaError)
  })

  it('namespaced id（plugin:skill）→ 按 installed_plugins.json 换算到插件真实 skills/ 根，定位到 leaf；返回的 skillId 是完整原始 token', async () => {
    const installPath = join(root, 'cache', 'mkt', 'my-plugin', '2.0.0')
    await makeSkillDir(join(installPath, 'skills'), 'my-skill', '# namespaced')
    const json = JSON.stringify({ plugins: { 'my-plugin@mkt': [{ installPath }] } })
    const locator = createProductionSkillContentLocator({
      home: join(root, 'home'), readdirDirNames: () => [], readInstalledPluginsJson: () => json,
    })
    const located = await locator.locate('my-plugin:my-skill')
    expect(located.skillId).toBe('my-plugin:my-skill') // 完整 token 回填，不是内部定位用的 leaf 'my-skill'
    expect(located.contentDir).toContain(join('skills', 'my-skill'))
  })

  it('namespaced skill 优先真实 Codex <authority>/<plugin>/local/skills 布局，不混入 Claude registry 候选', async () => {
    const home = join(root, 'home')
    const codexDir = await makeSkillDir(
      join(home, '.codex', 'plugins', 'cache', 'claude-plugins-official', 'frontend-design', 'local', 'skills'),
      'frontend-design',
      '# codex local',
    )
    const claudeInstallPath = join(root, 'claude-cache', 'frontend-design', 'unknown')
    await makeSkillDir(join(claudeInstallPath, 'skills'), 'frontend-design', '# claude fallback')
    const registry = JSON.stringify({
      plugins: { 'frontend-design@claude-plugins-official': [{ installPath: claudeInstallPath }] },
    })
    const locator = createProductionSkillContentLocator({
      home, readInstalledPluginsJson: () => registry,
    })

    const located = await locator.locate('frontend-design:frontend-design')

    expect(located.contentDir).toBe(await realpath(codexDir))
  })

  it('namespaced id 但插件命名空间未在 installed_plugins.json 中 → SkillContentNotFoundError（与裸 id 全根未命中同一失败语义）', async () => {
    const locator = createProductionSkillContentLocator({
      home: join(root, 'home'), readdirDirNames: () => [],
      readInstalledPluginsJson: () => JSON.stringify({ plugins: {} }),
    })
    await expect(locator.locate('nonexistent-plugin:some-skill')).rejects.toBeInstanceOf(SkillContentNotFoundError)
  })

  it('namespaced id 插件已装但该 leaf skill 不在其 skills/ 目录下 → SkillContentNotFoundError（内层 createFsSkillContentLocator 既有语义原样冒出）', async () => {
    const installPath = join(root, 'cache', 'mkt', 'my-plugin', '2.0.0')
    await mkdir(join(installPath, 'skills'), { recursive: true }) // 插件装了，但没有这个 skill
    const json = JSON.stringify({ plugins: { 'my-plugin@mkt': [{ installPath }] } })
    const locator = createProductionSkillContentLocator({
      home: join(root, 'home'), readdirDirNames: () => [], readInstalledPluginsJson: () => json,
    })
    await expect(locator.locate('my-plugin:missing-skill')).rejects.toBeInstanceOf(SkillContentNotFoundError)
  })

  it('实测：本机真实已装的 superpowers:brainstorming 能被真实定位（零注入，读真 ~/.claude；无该插件的机器诚实跳过，不假绿）', async (ctx) => {
    const probe = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
    let installedRaw: string
    try {
      installedRaw = await readFile(probe, 'utf8')
    } catch (e) {
      console.warn(`[HONEST SKIP] 本机读不到 ${probe}（${(e as Error).message}），无法验证真实 namespaced 定位 → 跳过`)
      return ctx.skip()
    }
    if (!installedRaw.includes('"superpowers@')) {
      console.warn('[HONEST SKIP] 本机 installed_plugins.json 未装 superpowers 插件 → 跳过')
      return ctx.skip()
    }
    const locator = createProductionSkillContentLocator({ home: homedir() })
    const located = await locator.locate('superpowers:brainstorming')
    expect(located.skillId).toBe('superpowers:brainstorming')
    // 真是插件当前生效版本目录下的 skills/brainstorming，不是猜的路径；也不是裸扁平根误配出来的巧合。
    expect(located.contentDir.endsWith(join('skills', 'brainstorming'))).toBe(true)
    expect(located.contentDir).toContain(`${join('claude-plugins-official', 'superpowers')}`)
  })
})

describe('default skill bundle 资产真实性', () => {
  it('ship frontend/backend 不把外部 commit-commands 命令当 mandatory skill slot', () => {
    const manifest = loadManifest(join(process.cwd(), 'templates', 'manifest.yaml'))
    const resolver = createEffectiveSkillResolver({
      mandatorySkills: manifest.mandatorySkills,
      recommendedSkills: manifest.recommendedSkills,
    })
    const capability = compileEffectiveWorkflowPlan('default').capabilities.skills

    for (const profileId of ['frontend', 'backend']) {
      const resolution = resolveSkillBundle(resolver, {
        kind: 'default', stepId: 'ship', profileId, capability,
      })
      expect(resolution.slots.map((slot) => slot.token)).not.toContain('commit-commands:commit-push-pr')
      expect(resolution.slots.map((slot) => slot.token)).toContain('finishing-a-development-branch')
    }
  })

  it('默认 bundled registry 不依赖外部 commit-push-pr 命令', async () => {
    const sources = await readFile(join(process.cwd(), 'templates', 'skill-sources.yaml'), 'utf8')
    const sourceLine = sources.split('\n').find((line) => line.trimStart().startsWith('commit-commands:commit-push-pr:'))

    expect(sourceLine).toBeUndefined()
  })
})

describe('createExecutionCoordinatePort', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coord-port-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const ctxFor = (change: string): { change: string } => ({ change })

  it('default workflow：resolution.kind=default，stepId=当前 phase', async () => {
    const store = mockStore({ x: mockState({ phase: 'build' }) })
    const port = createExecutionCoordinatePort({ store, repoRoot: cwd })
    const coord = await port.capture(ctxFor('x') as never)
    expect(coord.resolution).toMatchObject({ kind: 'default', stepId: 'build' })
    if (coord.resolution.kind === 'default') {
      expect(coord.resolution.capability?.steps.find((step) => step.stepId === 'build')?.requiredSkillIds)
        .toEqual([])  // chat 分支不声明技能：没有 track 的 default 解析不依赖上游字节
    }
    expect(typeof coord.inputsDigest).toBe('string')
    expect(coord.inputsDigest.length).toBeGreaterThan(0)
  })

  it('default workflow：存在 frozen WorkflowRun snapshot 时 phase capability 来自 snapshot', async () => {
    const frozen = compileEffectiveWorkflowPlan('default')
    const state = {
      ...mockState({ phase: 'build' }),
      runMetadata: {
        runId: 'workflow-run-frozen-capability',
        transitionSequence: 0,
        workflowPlanFingerprint: frozen.workflowFingerprint,
        workflowPlanSnapshot: workflowPlanSnapshot(frozen),
      },
    }
    const port = createExecutionCoordinatePort({ store: mockStore({ x: state }), repoRoot: cwd })
    const coord = await port.capture(ctxFor('x') as never)
    if (coord.resolution.kind !== 'default') throw new Error('expected default coordinate')
    expect(coord.resolution.capability?.steps.find((step) => step.stepId === 'build')?.requiredSkillIds)
      .toEqual([])
    expect(coord.workflowRunId).toBe('workflow-run-frozen-capability')
  })

  it('default workflow：pre-issue#43 frozen snapshot 的空 build Skill 不被当前模板 phase capability 覆盖', async () => {
    const source = await readFile(join(process.cwd(), 'templates', 'workflows', 'default.yaml'), 'utf8')
    const current = parseWorkflow(source)
    const emptyBuild = (steps: typeof current.steps) => steps.map((step) => step.id === 'build' ? { ...step, skills: [] } : step)
    const historical = {
      ...current,
      steps: emptyBuild(current.steps),
      ...(current.tracks === undefined ? {} : { tracks: Object.fromEntries(Object.entries(current.tracks).map(([id, branch]) => [id, { ...branch, steps: emptyBuild(branch.steps) }])) }),
    }
    const frozen = compileEffectiveWorkflowPlan('default', historical)
    const state = {
      ...mockState({ phase: 'build' }),
      runMetadata: {
        runId: 'workflow-run-pre-issue-43',
        transitionSequence: 0,
        workflowPlanFingerprint: frozen.workflowFingerprint,
        workflowPlanSnapshot: workflowPlanSnapshot(frozen),
      },
    }
    const port = createExecutionCoordinatePort({ store: mockStore({ x: state }), repoRoot: cwd })
    const coord = await port.capture(ctxFor('x') as never)
    if (coord.resolution.kind !== 'default') throw new Error('expected default coordinate')
    expect(coord.resolution.capability?.steps.find((step) => step.stepId === 'build')?.requiredSkillIds)
      .toEqual([])
    expect(coord.workflowRunId).toBe('workflow-run-pre-issue-43')
  })

  it('capture 把 .pipeline.yaml 的稳定 runMetadata.runId 作为 workflowRunId 真透传，不用 attempt id 冒充', async () => {
    const state = { ...mockState({ phase: 'build' }), runMetadata: { runId: 'workflow-run-real-42', transitionSequence: 0 } }
    const store = mockStore({ x: state })
    const port = createExecutionCoordinatePort({ store, repoRoot: cwd })
    const coord = await port.capture(ctxFor('x') as never)
    expect(coord.workflowRunId).toBe('workflow-run-real-42')
  })

  it('capture() 在 change lock 内读取（store.withLock 被调用一次，锁定该 change 目录）', async () => {
    const store = mockStore({ x: mockState({ phase: 'build' }) })
    const port = createExecutionCoordinatePort({ store, repoRoot: cwd })
    await port.capture(ctxFor('x') as never)
    expect(store.withLock.calls.length).toBe(1)
    expect(store.withLock.calls[0]![0]).toContain('x')
  })

  it('custom workflow + 真实 workflow 文件存在 → resolution.kind=custom，step 为编译后的真实 StepIR（含声明 skills）', async () => {
    const wfDir = join(cwd, '.pipeline', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(
      join(wfDir, 'onboarding.yaml'),
      `name: onboarding
steps:
  - id: intake
    label: intake
    gate: null
    skills:
      - id: some-skill
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: done
  - id: done
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`,
      'utf8',
    )
    const store = mockStore({ x: mockState({ phase: 'intake', workflow: 'onboarding' }) })
    const port = createExecutionCoordinatePort({ store, repoRoot: cwd })
    const coord = await port.capture(ctxFor('x') as never)
    expect(coord.resolution.kind).toBe('custom')
    if (coord.resolution.kind === 'custom') {
      expect(coord.resolution.step.id).toBe('intake')
      expect(coord.resolution.step.skills).toEqual([{ id: 'some-skill' }])
    }
  })

  it('custom workflow 但对应 .pipeline/workflows/<id>.yaml 文件缺失 → 非 fail-loud，产出空声明 step（同 effective-artifacts.ts 既有口径：无文件=无声明）', async () => {
    const store = mockStore({ x: mockState({ phase: 'build', workflow: 'ghost-workflow' }) })
    const port = createExecutionCoordinatePort({ store, repoRoot: cwd })
    const coord = await port.capture(ctxFor('x') as never)
    expect(coord.resolution.kind).toBe('custom')
    if (coord.resolution.kind === 'custom') {
      expect(coord.resolution.step.skills).toEqual([])
      expect(coord.resolution.step.id).toBe('build')
    }
  })

  it('custom workflow 文件存在但当前 phase 不在图里 → fail-loud 抛错（数据完整性问题，不能悄悄放行）', async () => {
    const wfDir = join(cwd, '.pipeline', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(
      join(wfDir, 'onboarding.yaml'),
      `name: onboarding
steps:
  - id: intake
    label: intake
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`,
      'utf8',
    )
    const store = mockStore({ x: mockState({ phase: 'not-a-real-step', workflow: 'onboarding' }) })
    const port = createExecutionCoordinatePort({ store, repoRoot: cwd })
    await expect(port.capture(ctxFor('x') as never)).rejects.toThrow()
  })

  it('readCurrentInputsDigest 在状态不变时与 capture() 的 inputsDigest 一致', async () => {
    const store = mockStore({ x: mockState({ phase: 'build' }) })
    const port = createExecutionCoordinatePort({ store, repoRoot: cwd })
    const coord = await port.capture(ctxFor('x') as never)
    const digest2 = await port.readCurrentInputsDigest(ctxFor('x') as never)
    expect(digest2).toBe(coord.inputsDigest)
  })

  it('readCurrentInputsDigest 在 phase 变化后与原 inputsDigest 不同（TOCTOU 可检测）', async () => {
    const storeBefore = mockStore({ x: mockState({ phase: 'build' }) })
    const port1 = createExecutionCoordinatePort({ store: storeBefore, repoRoot: cwd })
    const coord = await port1.capture(ctxFor('x') as never)

    const storeAfter = mockStore({ x: mockState({ phase: 'verify' }) })
    const port2 = createExecutionCoordinatePort({ store: storeAfter, repoRoot: cwd })
    const digestAfter = await port2.readCurrentInputsDigest(ctxFor('x') as never)
    expect(digestAfter).not.toBe(coord.inputsDigest)
  })
})
