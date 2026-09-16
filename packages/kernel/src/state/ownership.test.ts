/**
 * ownership.ts 纯逻辑单测（BACKLOG #24，GOAL C9：mock 层快速回归；真实副作用见
 * cli/src/sync-uninstall.integration.test.ts）。本文件零 fs——只钉纯函数语义。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  ALL_MANAGED_DIRS,
  OWNED_MANIFEST,
  bannerNudge,
  buildOwnedManifest,
  classifyOwned,
  commandMatchesDeletedPath,
  compareVersions,
  computeContentHash,
  deriveChannelFromInstalled,
  deriveUpgradeChannel,
  getInstalledPluginVersion,
  guardDowngrade,
  isManagedPath,
  isManagedRootDir,
  isOwnedModified,
  isUnknownVersion,
  mergeOwned,
  migrateGateDecision,
  needsCodexUpgrade,
  normalizeOwnedKey,
  parseOwnedManifest,
  pruneOwnedManifest,
  recordOwned,
  scrubHooksFlat,
  scrubHooksNested,
  scrubStructured,
  serializeOwnedManifest,
  shouldInjectConfigSections,
  shouldKeepAgentsMd,
  structuredKindForKey,
} from './ownership.js'

// ── ① content hash（compute_hash parity：CRLF→LF + SHA256 hex）──
describe('computeContentHash — CRLF→LF 归一 + SHA256（老仓 template-hash.py:71-81）', () => {
  test('CRLF 与 LF 同一逻辑内容 → 同 hash（跨 OS checkout 稳定）', () => {
    expect(computeContentHash('a\r\nb\r\nc')).toBe(computeContentHash('a\nb\nc'))
  })
  test('裸 \\r 不归一（保 Mac-classic 语义）→ 与 \\n 不同', () => {
    expect(computeContentHash('a\rb')).not.toBe(computeContentHash('a\nb'))
  })
  test('小写 hex、确定性、空串有定值', () => {
    const h = computeContentHash('hello')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(computeContentHash('')).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── ② key 归一 + 越界守卫（record_write:154-169 + _rel_to_root）──
describe('normalizeOwnedKey — POSIX 相对 + 越界丢（老仓 record_write ② ③）', () => {
  test('反斜杠→正斜杠', () => {
    expect(normalizeOwnedKey('.claude\\settings.json')).toBe('.claude/settings.json')
  })
  test('./ 前缀与冗余段规整', () => {
    expect(normalizeOwnedKey('./a/./b')).toBe('a/b')
    expect(normalizeOwnedKey('a/b/../c')).toBe('a/c')
  })
  test('绝对路径 / 越界 .. / 空 → undefined（uninstall 永不删 cwd 外）', () => {
    expect(normalizeOwnedKey('/etc/passwd')).toBeUndefined()
    expect(normalizeOwnedKey('../evil')).toBeUndefined()
    expect(normalizeOwnedKey('a/../../evil')).toBeUndefined()
    expect(normalizeOwnedKey('')).toBeUndefined()
    expect(normalizeOwnedKey('..')).toBeUndefined()
  })
})

// ── ③ 清单读写（path→hash 对象，非裸数组）──
describe('parse/serialize OwnedManifest — path→hash 对象（老仓 §⓪ 承重半边）', () => {
  test('serialize 按 key 排序 + 2 空格 + 尾换行；roundtrip', () => {
    const text = serializeOwnedManifest({ 'b.md': 'h2', 'a.md': 'h1' })
    expect(text).toBe('{\n  "a.md": "h1",\n  "b.md": "h2"\n}\n')
    expect(parseOwnedManifest(text)).toEqual({ 'a.md': 'h1', 'b.md': 'h2' })
  })
  test('空对象 → {}\\n', () => {
    expect(serializeOwnedManifest({})).toBe('{}\n')
  })
  test('legacy 裸数组 → 各 key hash 空串（无基线保守保留）', () => {
    expect(parseOwnedManifest('["x.md","y.sh"]')).toEqual({ 'x.md': '', 'y.sh': '' })
  })
  test('malformed / 非对象 → {}（fail-open）', () => {
    expect(parseOwnedManifest('not json{')).toEqual({})
    expect(parseOwnedManifest('42')).toEqual({})
    expect(parseOwnedManifest('')).toEqual({})
  })
  test('非字符串 value 归一为空串（容错）', () => {
    expect(parseOwnedManifest('{"a": 1, "b": null}')).toEqual({ a: '', b: '' })
  })
  test('OWNED_MANIFEST 常量对齐老仓', () => {
    expect(OWNED_MANIFEST).toBe('.pipeline-owned.json')
  })
})

// ── ④ 记录写入 + merge（last-wins；merge 并集）──
describe('recordOwned / buildOwnedManifest / mergeOwned（老仓 initialize_owned_manifest 幂等 + last-wins）', () => {
  test('recordOwned 记 key→hash，越界丢', () => {
    let m: Record<string, string> = {}
    m = recordOwned(m, 'a/b.md', 'h1')
    m = recordOwned(m, '../evil', 'hX') // 越界丢
    expect(m).toEqual({ 'a/b.md': 'h1' })
  })
  test('同 key 多次 → 最后一条（last-wins）', () => {
    let m: Record<string, string> = {}
    m = recordOwned(m, 'a.md', 'h1')
    m = recordOwned(m, 'a.md', 'h2')
    expect(m).toEqual({ 'a.md': 'h2' })
  })
  test('buildOwnedManifest 从写入列表构建（真算内容 hash）', () => {
    const m = buildOwnedManifest([
      { rel: 'a.md', content: 'AAA' },
      { rel: 'b.sh', content: 'BBB' },
    ])
    expect(m['a.md']).toBe(computeContentHash('AAA'))
    expect(m['b.sh']).toBe(computeContentHash('BBB'))
  })
  test('mergeOwned 并集，incoming 同 key 覆盖（re-init merge=true）', () => {
    expect(mergeOwned({ a: 'old', c: 'keep' }, { a: 'new', b: 'add' })).toEqual({
      a: 'new',
      b: 'add',
      c: 'keep',
    })
  })
})

// ── ⑤ 用户是否改过（is_template_modified parity）──
describe('isOwnedModified — 承重谓词（老仓 is_template_modified:114-120）', () => {
  test('文件不存在（content undefined）→ false（走 user-deleted 别处）', () => {
    expect(isOwnedModified(undefined, 'anyhash')).toBe(false)
  })
  test('stored 空 → true（无基线保守判改过 → 保留）', () => {
    expect(isOwnedModified('content', '')).toBe(true)
  })
  test('current==stored → false（工具原样，可删）；!= → true（用户改过，保留）', () => {
    const c = 'installed-content'
    expect(isOwnedModified(c, computeContentHash(c))).toBe(false)
    expect(isOwnedModified('user-edited', computeContentHash(c))).toBe(true)
  })
})

// ── ⑥ 五桶分类（analyze_changes parity）──
describe('classifyOwned — 五桶（老仓 analyze_changes:325-360）', () => {
  const tpl = 'TEMPLATE'
  const tplHash = computeContentHash(tpl)
  test('new：无文件无 hash', () => {
    expect(classifyOwned({ templateContent: tpl })).toBe('new')
  })
  test('user_deleted：无文件但有 hash（静默闸，不重建）', () => {
    expect(classifyOwned({ templateContent: tpl, storedHash: tplHash })).toBe('user_deleted')
  })
  test('unchanged：文件字节 == 模板', () => {
    expect(classifyOwned({ fileContent: tpl, templateContent: tpl, storedHash: tplHash })).toBe('unchanged')
  })
  test('auto_update：文件≠模板但 stored==current（用户没动）', () => {
    const cur = 'OLD-VERSION'
    expect(classifyOwned({ fileContent: cur, templateContent: tpl, storedHash: computeContentHash(cur) })).toBe('auto_update')
  })
  test('changed：文件≠模板且 hash 不符', () => {
    expect(classifyOwned({ fileContent: 'USER-EDIT', templateContent: tpl, storedHash: tplHash })).toBe('changed')
  })
  test('changed：文件≠模板且无 hash（保守，绝不 auto_update）', () => {
    expect(classifyOwned({ fileContent: 'USER-EDIT', templateContent: tpl })).toBe('changed')
  })
})

// ── ⑦ AGENTS.md 托管判定 + prune 四规则 ──
describe('shouldKeepAgentsMd + pruneOwnedManifest（老仓 uninstall.sh:79-91 + update-upgrade.py:285-333）', () => {
  // 回归：适配器写的是带 TAG 的 `PIPELINE:CODEX:START`，内核曾只认不带 TAG 的 `PIPELINE:START`，
  // 导致装了 Codex 块的 AGENTS.md 在 sync / uninstall 时被当成用户文件剪掉。
  const codexBlock = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'templates', 'generated', 'codex-agents-block.md'),
    'utf8',
  )
  const wrapped = `# 用户规则\n\n- 保持简单\n\n${codexBlock}`

  test('AGENTS.md：不在磁盘(undefined)→keep；真实 Codex 块被用户文本包住→keep；单个标记/无标记→prune', () => {
    expect(shouldKeepAgentsMd(undefined)).toBe(true)
    expect(shouldKeepAgentsMd(wrapped)).toBe(true)
    expect(shouldKeepAgentsMd('only\n<!-- PIPELINE:CODEX:START -->\nstart\n')).toBe(false)
    expect(shouldKeepAgentsMd('user-own content')).toBe(false)
  })
  test('不带 TAG 的旧标记对不算受管块', () => {
    expect(shouldKeepAgentsMd('<!-- PIPELINE:START -->\nx\n<!-- PIPELINE:END -->\n')).toBe(false)
  })
  test('prune：含真实 Codex 块的 AGENTS.md 保留清单键', () => {
    const { kept, pruned } = pruneOwnedManifest({ 'AGENTS.md': 'h' }, { agentsMdContent: wrapped })
    expect(kept).toEqual({ 'AGENTS.md': 'h' })
    expect(pruned).toEqual([])
  })
  test('prune 规则1：.pipeline/* 与 .pipeline 恒留', () => {
    const { kept, pruned } = pruneOwnedManifest(
      { '.pipeline': 'h', '.pipeline/spec/x': 'h', 'orphan.md': 'h' },
      { knownKeys: [], migrationPaths: [] },
    )
    expect(kept['.pipeline']).toBe('h')
    expect(kept['.pipeline/spec/x']).toBe('h')
    expect(pruned).toEqual(['orphan.md'])
  })
  test('prune 规则2/4：known 集保留、余项剪', () => {
    const { kept, pruned } = pruneOwnedManifest(
      { '.claude/hooks.json': 'h', 'orphan.md': 'h' },
      { knownKeys: ['.claude/hooks.json'], migrationPaths: [] },
    )
    expect(Object.keys(kept)).toEqual(['.claude/hooks.json'])
    expect(pruned).toEqual(['orphan.md'])
  })
  test('prune 规则3：迁移 from/to 保留', () => {
    const { kept } = pruneOwnedManifest(
      { 'old/path.md': 'h' },
      { knownKeys: [], migrationPaths: ['old/path.md'] },
    )
    expect(kept['old/path.md']).toBe('h')
  })
  test('prune 规则2：AGENTS.md 双哨兵 → 剥离（prune）；无哨兵内容传入判剪', () => {
    const { pruned } = pruneOwnedManifest(
      { 'AGENTS.md': 'h' },
      { knownKeys: [], migrationPaths: [], agentsMdContent: 'user own' },
    )
    expect(pruned).toEqual(['AGENTS.md'])
  })
})

// ── ⑧ 结构化文件分发 + hooks scrubber（uninstall-scrubbers.py parity）──
describe('structuredKindForKey（老仓 _structured_kind_for_key:211-224）', () => {
  test('cursor/copilot → flat；opencode/pi/codex 专用；hooks/settings 兜底 nested；余 → null', () => {
    expect(structuredKindForKey('.cursor/hooks.json')).toBe('flat')
    expect(structuredKindForKey('.github/copilot/hooks.json')).toBe('flat')
    expect(structuredKindForKey('.opencode/package.json')).toBe('opencode-package')
    expect(structuredKindForKey('.pi/settings.json')).toBe('pi-settings')
    expect(structuredKindForKey('.codex/config.toml')).toBe('codex-config')
    expect(structuredKindForKey('.claude/settings.json')).toBe('nested')
    expect(structuredKindForKey('.codex/hooks.json')).toBe('nested')
    expect(structuredKindForKey('.claude/agents/foo.md')).toBeNull()
  })
})

describe('commandMatchesDeletedPath — 末位 token 精确/后缀匹配（老仓:46-68，绝不 substring）', () => {
  test('末 token == p 或 endsWith("/"+p) 命中', () => {
    expect(commandMatchesDeletedPath('python3 .claude/hooks/x.py', ['.claude/hooks/x.py'])).toBe(true)
    expect(commandMatchesDeletedPath('bash /abs/.claude/hooks/x.py', ['.claude/hooks/x.py'])).toBe(true)
  })
  test('路径非末位 token → 不误删（老仓真正的守卫是位置，非引号）', () => {
    // 老仓只比对末位空白 token；路径出现在命令中段（后有其它 token）→ 末 token 非路径 → 不命中。
    expect(commandMatchesDeletedPath('echo ".claude/hooks/x.py is referenced" here', ['.claude/hooks/x.py'])).toBe(false)
    expect(commandMatchesDeletedPath('python3 .claude/hooks/x.py --verbose', ['.claude/hooks/x.py'])).toBe(false)
  })
  test('去引号后比对；空/非串 → false', () => {
    expect(commandMatchesDeletedPath('"a/b.py"', ['a/b.py'])).toBe(true)
    expect(commandMatchesDeletedPath('', ['a'])).toBe(false)
  })
})

describe('scrubHooksNested / Flat — 剥本插件条目保留用户（老仓 _scrub_hooks:93-180）', () => {
  test('nested：剥命中 inner hook、空 matcher block 删、空 event 删、空 hooks 删', () => {
    const content = JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ command: 'python3 .claude/hooks/pl.py' }] },
        ],
      },
      model: 'sonnet',
    })
    const { content: out, fullyEmpty } = scrubHooksNested(content, ['.claude/hooks/pl.py'])
    const parsed = JSON.parse(out)
    expect(parsed.hooks).toBeUndefined() // event 空 → 删；hooks 空 → 删
    expect(parsed.model).toBe('sonnet') // 非 hooks 顶层键 verbatim 保留
    expect(fullyEmpty).toBe(false)
  })
  test('nested：保留用户自有 hook（末 token 不命中）', () => {
    const content = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ command: 'my-own-tool run' }] }] },
    })
    const { content: out } = scrubHooksNested(content, ['.claude/hooks/pl.py'])
    expect(JSON.parse(out).hooks.SessionStart).toHaveLength(1)
  })
  test('nested：剥光 root 无键 → fullyEmpty=true（调用方转整删）', () => {
    const content = JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'x .claude/h.py' }] }] } })
    const { fullyEmpty } = scrubHooksNested(content, ['.claude/h.py'])
    expect(fullyEmpty).toBe(true)
  })
  test('flat：event 数组直接是 hook entry，命中即丢', () => {
    const content = JSON.stringify({ hooks: { SessionStart: [{ command: 'x .cursor/h.py' }, { command: 'user tool' }] } })
    const { content: out } = scrubHooksFlat(content, ['.cursor/h.py'])
    expect(JSON.parse(out).hooks.SessionStart).toHaveLength(1)
  })
  test('malformed / 非 dict → 原文不动、fullyEmpty=false（守卫）', () => {
    expect(scrubHooksNested('not json', ['a'])).toEqual({ content: 'not json', fullyEmpty: false })
    expect(scrubHooksNested('[1,2]', ['a'])).toEqual({ content: '[1,2]', fullyEmpty: false })
  })
})

describe('scrubStructured — 诚实 stub 面（opencode/pi/codex/tap 保守保留）', () => {
  test('nested/flat 走真实现', () => {
    const c = JSON.stringify({ hooks: { X: [{ hooks: [{ command: 'x a/b.py' }] }] } })
    expect(scrubStructured('nested', c, ['a/b.py']).fullyEmpty).toBe(true)
  })
  test('opencode-package/pi-settings/codex-config/tap → 诚实 stub：原文不动、fullyEmpty=false（绝不误删）', () => {
    for (const kind of ['opencode-package', 'pi-settings', 'codex-config', 'tap-cleanup'] as const) {
      expect(scrubStructured(kind, 'ORIG', ['a'])).toEqual({ content: 'ORIG', fullyEmpty: false })
    }
  })
})

// ── ⑨ 受管目录守卫 ──
describe('isManagedPath / isManagedRootDir（老仓 uninstall.sh:391-405）', () => {
  test('受管树内 → managedPath；精确根 → managedRootDir', () => {
    expect(isManagedPath('.claude/hooks')).toBe(true)
    expect(isManagedPath('.claude')).toBe(true)
    expect(isManagedPath('random/dir')).toBe(false)
    expect(isManagedRootDir('.claude')).toBe(true)
    expect(isManagedRootDir('.claude/hooks')).toBe(false)
  })
  test('ALL_MANAGED_DIRS 含 .pipeline/.claude/.codex', () => {
    expect(ALL_MANAGED_DIRS).toContain('.pipeline')
    expect(ALL_MANAGED_DIRS).toContain('.claude')
    expect(ALL_MANAGED_DIRS).toContain('.codex')
  })
})

// ── ⑩ 版本协调（compare_versions / guard / gate / banner / channel）──
describe('compareVersions + unknown 一等态（老仓 template-hash.py:218-295 + 391-410）', () => {
  test('基础 semver', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1)
  })
  test('预发布：无预发布 > 有预发布；连字符标识符不误切', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-alpha-1', '1.0.0-alpha-1')).toBe(0)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1)
  })
  test('unknown 一等态：任何真实版 > unknown', () => {
    expect(isUnknownVersion('unknown')).toBe(true)
    expect(compareVersions('0.1.0', 'unknown')).toBe(1)
  })
})

describe('guardDowngrade（老仓 update-upgrade.py:150-184）', () => {
  test('cli<project 无 allow → reject、proceed=false', () => {
    const g = guardDowngrade('1.0.0', '2.0.0', false)
    expect(g.action).toBe('reject')
    expect(g.proceed).toBe(false)
    expect(g.messages.join(' ')).toContain('DOWNGRADE')
  })
  test('cli<project + allow → downgrade、proceed=true', () => {
    const g = guardDowngrade('1.0.0', '2.0.0', true)
    expect(g.action).toBe('downgrade')
    expect(g.proceed).toBe(true)
  })
  test('cli>=project → ok、proceed=true；unknown 不算 downgrade', () => {
    expect(guardDowngrade('2.0.0', '1.0.0', false).action).toBe('ok')
    expect(guardDowngrade('1.0.0', 'unknown', false).proceed).toBe(true)
  })
})

describe('shouldInjectConfigSections（老仓 update-upgrade.py:191-200）', () => {
  test('仅 cli>project ∧ project≠unknown', () => {
    expect(shouldInjectConfigSections('2.0.0', '1.0.0')).toBe(true)
    expect(shouldInjectConfigSections('1.0.0', '1.0.0')).toBe(false)
    expect(shouldInjectConfigSections('1.0.0', '2.0.0')).toBe(false)
    expect(shouldInjectConfigSections('2.0.0', 'unknown')).toBe(false)
  })
})

describe('migrateGateDecision（老仓 update-upgrade.py:207-247）', () => {
  const up = { breaking: true, recommend_migrate: true }
  test('breaking∧recommend∧pending∧!migrate∧cli>project∧≠unknown → required、exit 1', () => {
    const d = migrateGateDecision(2, false, '2.0.0', '1.0.0', up)
    expect(d.decision).toBe('required')
    expect(d.exitCode).toBe(1)
  })
  test('仅 breaking（!recommend）→ tip、exit 0', () => {
    const d = migrateGateDecision(2, false, '2.0.0', '1.0.0', { breaking: true, recommend_migrate: false })
    expect(d.decision).toBe('tip')
    expect(d.exitCode).toBe(0)
  })
  test('migrate=true / pending=0 / 同版 / unknown → ok、exit 0', () => {
    expect(migrateGateDecision(2, true, '2.0.0', '1.0.0', up).decision).toBe('ok')
    expect(migrateGateDecision(0, false, '2.0.0', '1.0.0', up).decision).toBe('ok')
    expect(migrateGateDecision(2, false, '1.0.0', '1.0.0', up).decision).toBe('ok')
    expect(migrateGateDecision(2, false, '2.0.0', 'unknown', up).decision).toBe('ok')
  })
})

describe('needsCodexUpgrade（老仓 update-upgrade.py:340-356）', () => {
  const markers = ['.agents/skills/pipeline-continue/SKILL.md']
  test('.codex 已存在 → false', () => {
    expect(needsCodexUpgrade(true, markers)).toBe(false)
  })
  test('无 .codex 且含 codex-only marker → true', () => {
    expect(needsCodexUpgrade(false, markers)).toBe(true)
  })
  test('无 marker → false', () => {
    expect(needsCodexUpgrade(false, ['random/key.md'])).toBe(false)
  })
})

describe('bannerNudge（老仓 update-upgrade.py:363-398，零网络纯比对）', () => {
  test('cli>project → update 方向', () => {
    expect(bannerNudge('1.0.0', '2.0.0')?.direction).toBe('update')
  })
  test('cli<project → upgrade 方向', () => {
    expect(bannerNudge('2.0.0', '1.0.0')?.direction).toBe('upgrade')
  })
  test('同版 / unknown → null（静默）', () => {
    expect(bannerNudge('1.0.0', '1.0.0')).toBeNull()
    expect(bannerNudge('unknown', '1.0.0')).toBeNull()
  })
})

describe('deriveUpgradeChannel + installed_plugins 派生（老仓 update-upgrade.py:81-143）', () => {
  test('-beta/-rc 后缀派生；beta 先于 rc', () => {
    expect(deriveUpgradeChannel('1.0.0-beta.8')).toBe('beta')
    expect(deriveUpgradeChannel('1.0.0-rc.1')).toBe('rc')
    expect(deriveUpgradeChannel('1.0.0')).toBe('latest')
  })
  test('显式 tag 校验（非法 tag 抛）', () => {
    expect(deriveUpgradeChannel('1.0.0', 'beta')).toBe('beta')
    expect(() => deriveUpgradeChannel('1.0.0', '../evil')).toThrow()
  })
  test('getInstalledPluginVersion 从 fixture 读；坏结构 → null', () => {
    const j = JSON.stringify({ version: 2, plugins: { 'pipeline-workflow@pipeline-workflow': [{ version: '1.2.3' }] } })
    expect(getInstalledPluginVersion(j, 'pipeline-workflow@pipeline-workflow')).toBe('1.2.3')
    expect(getInstalledPluginVersion('bad', 'k')).toBeNull()
    expect(getInstalledPluginVersion('{}', 'k')).toBeNull()
  })
  test('deriveChannelFromInstalled：缺版本 → latest', () => {
    expect(deriveChannelFromInstalled('{}', 'k')).toBe('latest')
    const j = JSON.stringify({ plugins: { k: [{ version: '9.0.0-rc.2' }] } })
    expect(deriveChannelFromInstalled(j, 'k')).toBe('rc')
  })
})
