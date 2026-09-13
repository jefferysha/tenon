/**
 * Codex 缓存 skill 信任根 —— 双向对账回归。
 *
 * 宿主缓存路径本身声明了 `<marketplace>/<plugin>/<version>` 身份；只信任路径会让任何继承来的
 * TENON_CODEX_PLUGIN_ROOT 指向同级目录冒充当前选中版本。这里按 activeReleaseRoot 的模式要求
 * payload 自己的 manifest 独立声明同一身份。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { trustedCodexSkillPath } from './codexSkillTrust.js'

let home: string

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

interface CacheIdentityOverrides {
  readonly pluginName?: string
  readonly pluginVersion?: string
  readonly marketplaceName?: string
  readonly omitPluginManifest?: boolean
  readonly omitMarketplaceManifest?: boolean
  readonly undeclaredPlugin?: boolean
}

async function makeCacheRoot(
  version: string,
  overrides: CacheIdentityOverrides = {},
): Promise<string> {
  const root = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', version)
  await mkdir(join(root, 'skills', 'openspec-propose'), { recursive: true })
  await writeFile(join(root, 'skills', 'openspec-propose', 'SKILL.md'), '# propose\n', 'utf8')
  if (overrides.omitPluginManifest !== true) {
    await writeJson(join(root, '.codex-plugin', 'plugin.json'), {
      name: overrides.pluginName ?? 'tenon',
      version: overrides.pluginVersion ?? version,
    })
  }
  if (overrides.omitMarketplaceManifest !== true) {
    await writeJson(join(root, '.agents', 'plugins', 'marketplace.json'), {
      name: overrides.marketplaceName ?? 'tenon',
      plugins: [{ name: overrides.undeclaredPlugin === true ? 'other' : 'tenon' }],
    })
  }
  return root
}

function trusted(root: string): Promise<string | undefined> {
  return trustedCodexSkillPath({ selectedCacheRoot: root }, 'openspec-propose', home)
}

describe('selected Codex cache trust root', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codex-skill-trust-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test('缓存 manifest 与路径声明的 marketplace/plugin/version 一致时才可信', async () => {
    const root = await makeCacheRoot('1.0.9')

    expect(await trusted(root)).toBe(join(root, 'skills', 'openspec-propose', 'SKILL.md'))
  })

  test('宿主缓存可以领先于 managed release，只要它自己声明同一个版本目录', async () => {
    const root = await makeCacheRoot('1.0.9-host-current')

    expect(await trusted(root)).toBe(join(root, 'skills', 'openspec-propose', 'SKILL.md'))
  })

  test('目录名与 manifest version 漂移时拒绝', async () => {
    const root = await makeCacheRoot('1.0.9-folder-drift', { pluginVersion: '1.0.9' })

    expect(await trusted(root)).toBeUndefined()
  })

  test('manifest 声明的 plugin 或 marketplace 身份漂移时拒绝', async () => {
    const pluginDrift = await makeCacheRoot('1.0.9', { pluginName: 'other-plugin' })
    expect(await trusted(pluginDrift)).toBeUndefined()

    await rm(pluginDrift, { recursive: true, force: true })
    const marketplaceDrift = await makeCacheRoot('1.0.9', { marketplaceName: 'other-marketplace' })
    expect(await trusted(marketplaceDrift)).toBeUndefined()

    await rm(marketplaceDrift, { recursive: true, force: true })
    const undeclared = await makeCacheRoot('1.0.9', { undeclaredPlugin: true })
    expect(await trusted(undeclared)).toBeUndefined()
  })

  test('缺少 plugin 或 marketplace manifest 的目录不能靠路径形状获得信任', async () => {
    const noPlugin = await makeCacheRoot('1.0.9', { omitPluginManifest: true })
    expect(await trusted(noPlugin)).toBeUndefined()

    await rm(noPlugin, { recursive: true, force: true })
    const noMarketplace = await makeCacheRoot('1.0.9', { omitMarketplaceManifest: true })
    expect(await trusted(noMarketplace)).toBeUndefined()
  })

  test('manifest 是 symlink 或非法 JSON 时拒绝', async () => {
    const symlinked = await makeCacheRoot('1.0.9')
    const outside = join(home, 'outside-plugin.json')
    await writeJson(outside, { name: 'tenon', version: '1.0.9' })
    await rm(join(symlinked, '.codex-plugin', 'plugin.json'))
    await symlink(outside, join(symlinked, '.codex-plugin', 'plugin.json'))
    expect(await trusted(symlinked)).toBeUndefined()

    await rm(symlinked, { recursive: true, force: true })
    const broken = await makeCacheRoot('1.0.9')
    await writeFile(join(broken, '.codex-plugin', 'plugin.json'), '{not json', 'utf8')
    expect(await trusted(broken)).toBeUndefined()
  })
})
