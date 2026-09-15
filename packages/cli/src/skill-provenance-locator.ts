import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  createFsSkillContentLocator,
  isPathSafeSkillId,
  SkillContentAccessError,
  SkillContentInvalidError,
  SkillContentNotFoundError,
  type SkillContentLocator,
} from '@tenon/automation'
import {
  parseSkillProvenanceRegistry,
  parseSkillSources,
  parseUpstreamSkillLock,
  parseUpstreamSkillSources,
  SkillProvenanceRegistryError,
  type SkillProvenanceRegistry,
  type UpstreamSkillLockEntry,
} from '@tenon/kernel'
import { buildCanonicalManifest } from '@tenon/automation'

export class SkillProvenanceLocatorError extends Error {
  override readonly name = 'SkillProvenanceLocatorError'
  readonly _tag = 'SkillProvenanceLocatorError'
  constructor(
    readonly category: string,
    message: string,
  ) {
    super(`[${category}] ${message}`)
  }
}

function errnoCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : 'unknown'
}

function candidateExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw new SkillProvenanceLocatorError('filesystem-safety-error', `读取 bundled candidate 失败: ${path}（${String(error)}）`)
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertSafeSkillsRoot(root: string): string {
  let rootEntry
  try {
    rootEntry = lstatSync(root)
  } catch (error) {
    throw new SkillProvenanceLocatorError('filesystem-safety-error', `读取 bundled skillsRoot 失败: ${root}（${String(error)}）`)
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new SkillProvenanceLocatorError(
      'filesystem-safety-error',
      `bundled skillsRoot 必须是普通目录，拒绝 symlink/非目录: ${root}`,
    )
  }
  try {
    return realpathSync(root)
  } catch (error) {
    throw new SkillProvenanceLocatorError('filesystem-safety-error', `解析 bundled skillsRoot realpath 失败: ${root}（${String(error)}）`)
  }
}

function assertSafeSkillRoot(root: string, skillId: string): string {
  const path = join(root, skillId)
  const rootReal = assertSafeSkillsRoot(root)
  let entry
  try {
    entry = lstatSync(path)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new SkillProvenanceLocatorError(
        'missing-distributed-skill',
        `registry 声明的 bundled Skill '${skillId}' 不存在`,
      )
    }
    throw new SkillProvenanceLocatorError('filesystem-safety-error', `读取 bundled Skill 失败: ${path}（${String(error)}）`)
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new SkillProvenanceLocatorError(
      'filesystem-safety-error',
      `bundled Skill '${skillId}' 必须是 skillsRoot 内的普通目录，拒绝 symlink/非目录`,
    )
  }
  let candidateReal: string
  try {
    candidateReal = realpathSync(path)
  } catch (error) {
    throw new SkillProvenanceLocatorError('filesystem-safety-error', `解析 bundled Skill realpath 失败: ${path}（${String(error)}）`)
  }
  if (!pathWithin(rootReal, candidateReal)) {
    throw new SkillProvenanceLocatorError(
      'filesystem-safety-error',
      `bundled Skill '${skillId}' realpath 逃逸 skillsRoot: ${candidateReal}`,
    )
  }
  return candidateReal
}

/** Generic alias projection retained for explicitly legacy/runner compatibility paths. */
export function loadSkillAliases(pluginRoot: string | undefined): ReadonlyMap<string, string> {
  if (pluginRoot === undefined) return new Map()
  const path = join(pluginRoot, 'templates', 'skill-sources.yaml')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return new Map()
    throw new SkillProvenanceLocatorError('registry-read-error', `读取 skill source registry 失败: ${path}（${String(error)}）`)
  }
  const aliases = new Map<string, string>()
  for (const row of parseSkillSources(text)) {
    const physical = row.contentSkill
      ?? ((row.tool === 'skills-cli' || row.tool === 'claude-plugin') ? row.skill : undefined)
    if (!row.token.includes(':') && physical !== undefined && physical !== row.token) aliases.set(row.token, physical)
  }
  return aliases
}

function withLogicalSkillAliases(locator: SkillContentLocator, aliases: ReadonlyMap<string, string>): SkillContentLocator {
  if (aliases.size === 0) return locator
  return {
    async locate(skillId) {
      const physicalId = aliases.get(skillId) ?? skillId
      const located = await locator.locate(physicalId)
      return physicalId === skillId ? located : { skillId, contentDir: located.contentDir }
    },
  }
}

function physicalId(sourceRef: string): string {
  return sourceRef.slice('skills/'.length)
}

/** Upstream skills declared by `skills/skills.lock.json`; any read or parse failure is `invalid-skill-lock`. */
function readUpstreamLockEntries(bundledRoot: string): ReadonlyMap<string, UpstreamSkillLockEntry> {
  let lockText: string
  try {
    lockText = readFileSync(join(bundledRoot, 'skills.lock.json'), 'utf8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return new Map()
    throw new SkillProvenanceLocatorError('invalid-skill-lock', `读取 skills.lock.json 失败（${String(error)}）`)
  }
  try {
    const sources = parseUpstreamSkillSources(readFileSync(join(bundledRoot, 'sources.yaml'), 'utf8'))
    return new Map(parseUpstreamSkillLock(lockText, sources).skills.map((entry) => [entry.id, entry]))
  } catch (error) {
    throw new SkillProvenanceLocatorError('invalid-skill-lock', error instanceof Error ? error.message : String(error))
  }
}

async function verifiedContentDir(
  base: SkillContentLocator,
  bundledRoot: string,
  physical: string,
  expectedHash: string,
): Promise<string> {
  const physicalRealPath = assertSafeSkillRoot(bundledRoot, physical)
  let located
  try {
    located = await base.locate(physical)
  } catch (error) {
    if (error instanceof SkillContentNotFoundError) {
      throw new SkillProvenanceLocatorError('missing-distributed-skill', error.message)
    }
    if (error instanceof SkillContentInvalidError || error instanceof SkillContentAccessError) {
      throw new SkillProvenanceLocatorError('filesystem-safety-error', error.message)
    }
    throw error
  }
  if (located.contentDir !== physicalRealPath) {
    throw new SkillProvenanceLocatorError(
      'filesystem-safety-error',
      `bundled Skill '${physical}' 定位结果未绑定到受信 realpath`,
    )
  }
  let manifest
  try {
    manifest = await buildCanonicalManifest(physical, located.contentDir)
  } catch (error) {
    throw new SkillProvenanceLocatorError(
      'filesystem-safety-error',
      `bundled Skill '${physical}' 内容树无法安全读取: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const actual = `sha256:${manifest.treeSha256}`
  if (actual !== expectedHash) {
    throw new SkillProvenanceLocatorError(
      'content-hash-mismatch',
      `bundled Skill '${physical}' hash drift: expected ${expectedHash}, actual ${actual}`,
    )
  }
  return located.contentDir
}

/**
 * Bundled-only locator that binds every returned tree to the strict v3 registry, or for upstream
 * skills to `skills/skills.lock.json`. It deliberately returns SkillContentNotFoundError only when no
 * bundled path exists; an existing undeclared/drifted path is a higher-tier provenance failure.
 */
export function createProvenanceAwareBundledLocator(pluginRoot: string): SkillContentLocator {
  const bundledRoot = join(pluginRoot, 'skills')
  const base = createFsSkillContentLocator([bundledRoot])
  let upstream: ReadonlyMap<string, UpstreamSkillLockEntry> | undefined
  let registry: SkillProvenanceRegistry | undefined
  const load = (): SkillProvenanceRegistry | undefined => {
    if (registry !== undefined) return registry
    try {
      const raw = readFileSync(join(pluginRoot, 'templates', 'skill-sources.yaml'), 'utf8')
      registry = parseSkillProvenanceRegistry(raw)
      return registry
    } catch (error) {
      const category = error instanceof SkillProvenanceRegistryError ? error.category : 'registry-read-error'
      throw new SkillProvenanceLocatorError(
        category,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return {
    async locate(skillId) {
      if (!isPathSafeSkillId(skillId)) {
        throw new SkillContentInvalidError(`skill id 含路径不安全字符，拒绝定位：${JSON.stringify(skillId)}`)
      }
      assertSafeSkillsRoot(bundledRoot)
      const current = load()
      if (current === undefined) throw new SkillProvenanceLocatorError('registry-read-error', 'canonical registry 未加载')
      const byToken = new Map(current.skills.map((entry) => [entry.token, entry]))
      const byPhysical = new Map(current.skills.map((entry) => [physicalId(entry.sourceRef), entry]))
      const entry = byToken.get(skillId) ?? byPhysical.get(skillId)
      if (entry === undefined) {
        upstream ??= readUpstreamLockEntries(bundledRoot)
        const locked = upstream.get(skillId)
        if (locked !== undefined) {
          return { skillId, contentDir: await verifiedContentDir(base, bundledRoot, locked.id, locked.treeSha256) }
        }
        const directPath = join(bundledRoot, skillId)
        let exists = false
        try {
          exists = candidateExists(directPath)
        } catch (error) {
          throw error
        }
        if (exists) assertSafeSkillRoot(bundledRoot, skillId)
        if (!exists) throw new SkillContentNotFoundError(`bundled Skill '${skillId}' 未登记且不存在`)
        throw new SkillProvenanceLocatorError(
          'unregistered-distributed-skill',
          `bundled Skill '${skillId}' 存在但未在 canonical registry 声明`,
        )
      }
      const physical = physicalId(entry.sourceRef)
      const contentDir = await verifiedContentDir(base, bundledRoot, physical, entry.contentHash)
      const expectedCoordinate = `tenon:${entry.sourceRef}@${entry.contentHash}`
      if (entry.coordinate !== expectedCoordinate) {
        throw new SkillProvenanceLocatorError(
          'coordinate-mismatch',
          `bundled Skill '${physical}' coordinate drift: expected ${expectedCoordinate}, actual ${entry.coordinate}`,
        )
      }
      return { skillId, contentDir }
    },
  }
}
