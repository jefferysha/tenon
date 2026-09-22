import { required } from '../required.js'
import { parseFlowBody, stripFlowComment, unquoteFlowValue } from './flow-yaml.js'

/**
 * skill source registry 的纯解析契约。
 *
 * CLI setup/doctor 与 Dashboard machine readiness 必须消费同一份 token -> 安装源/真实 skill id/tier
 * 映射，否则 Codex 的 ~/.agents/skills 安装会被 UI 按旧 token 误报。这里仅负责解析文本，不负责定位文件，
 * 因而 kernel 保持零 fs/运行环境策略；各 adapter 自行选择 fail-open 或 fail-loud 的读取语义。
 */

export type SkillTool = 'claude-plugin' | 'skills-cli' | 'npm' | 'builtin' | 'bundled'
const TOOL_SET: ReadonlySet<string> = new Set<SkillTool>([
  'claude-plugin', 'skills-cli', 'npm', 'builtin', 'bundled',
])

export type SkillTier = 'mandatory' | 'recommended' | 'conditional' | 'optional'
const TIER_SET: ReadonlySet<string> = new Set<SkillTier>([
  'mandatory', 'recommended', 'conditional', 'optional',
])

export interface SkillSourceDefinition {
  token: string
  tool: SkillTool
  source: string
  skill?: string
  /** Physical SKILL.md directory id used when a logical/builtin token has no same-name content tree. */
  contentSkill?: string
  tier: SkillTier
  official: boolean
  engine?: string
  bin?: string
  unavailable?: boolean
  alt?: string
  note?: string
}

export class SkillSourcesError extends Error {
  constructor(message: string) {
    super(`skill-sources: ${message}`)
    this.name = 'SkillSourcesError'
  }
}

export type SkillProvenanceSourceKind = 'bundled'
export const SKILL_PROVENANCE_REGISTRY_VERSION = 3 as const
export const SKILL_PROVENANCE_HASH_ALGORITHM = 'tree-sha256-v1' as const

/** Stable categories shared by the strict parser, filesystem verifier and bundled CLI. */
export const SKILL_PROVENANCE_ERROR_CATEGORIES = [
  'unsupported-registry-version',
  'unknown-source-kind',
  'invalid-source-ref',
  'missing-distributed-skill',
  'unregistered-distributed-skill',
  'duplicate-distributed-source',
  'content-hash-mismatch',
  'coordinate-mismatch',
  'legacy-provenance-source',
  'invalid-skill-sources',
  'invalid-skill-lock',
  'mandatory-skill-not-invocable',
] as const
export type SkillProvenanceErrorCategory = typeof SKILL_PROVENANCE_ERROR_CATEGORIES[number]

export interface SkillProvenanceSourceDefinition extends SkillSourceDefinition {
  sourceKind: SkillProvenanceSourceKind
  sourceRef: string
  contentHash: `sha256:${string}`
  coordinate: string
}

export interface SkillProvenanceRegistry {
  version: typeof SKILL_PROVENANCE_REGISTRY_VERSION
  hashAlgorithm: typeof SKILL_PROVENANCE_HASH_ALGORITHM
  skills: readonly SkillProvenanceSourceDefinition[]
}

export class SkillProvenanceRegistryError extends SkillSourcesError {
  override readonly name = 'SkillProvenanceRegistryError'
  constructor(
    readonly category: SkillProvenanceErrorCategory,
    message: string,
  ) {
    super(`[${category}] ${message}`)
    this.name = 'SkillProvenanceRegistryError'
  }
}

function parseFlowFields(body: string, token: string): Map<string, string> {
  return parseFlowBody(body, (message) => new SkillSourcesError(`token '${token}' ${message}`))
}

function parseEntry(line: string, lineNo: number): SkillSourceDefinition {
  const brace = line.indexOf('{')
  const close = line.lastIndexOf('}')
  if (brace < 0 || close < brace) {
    throw new SkillSourcesError(`第 ${lineNo} 行不是 'token: { ... }' 形态: '${line.trim()}'`)
  }
  const keyPart = line.slice(0, brace).trim()
  if (!keyPart.endsWith(':')) {
    throw new SkillSourcesError(`第 ${lineNo} 行键须以 ':' 结尾: '${line.trim()}'`)
  }
  const token = keyPart.slice(0, -1).trim()
  if (token === '') throw new SkillSourcesError(`第 ${lineNo} 行 token 为空`)

  const f = parseFlowFields(line.slice(brace + 1, close), token)
  const tool = f.get('tool')
  if (!tool || !TOOL_SET.has(tool)) {
    throw new SkillSourcesError(`token '${token}' tool 非法或缺失: '${tool ?? ''}'（合法：${[...TOOL_SET].join('/')}）`)
  }
  const source = f.get('source')
  if (source === undefined || source === '') throw new SkillSourcesError(`token '${token}' 缺 source`)
  const tier = f.get('tier')
  if (!tier || !TIER_SET.has(tier)) {
    throw new SkillSourcesError(`token '${token}' tier 非法或缺失: '${tier ?? ''}'（合法：${[...TIER_SET].join('/')}）`)
  }
  const officialRaw = f.get('official')
  if (officialRaw !== 'true' && officialRaw !== 'false') {
    throw new SkillSourcesError(`token '${token}' official 须为 true/false: '${officialRaw ?? ''}'`)
  }

  const entry: SkillSourceDefinition = {
    token,
    tool: tool as SkillTool,
    source,
    tier: tier as SkillTier,
    official: officialRaw === 'true',
  }
  const skill = f.get('skill')
  if (skill !== undefined && skill !== '') entry.skill = skill
  const contentSkill = f.get('content_skill')
  if (contentSkill !== undefined && contentSkill !== '') entry.contentSkill = contentSkill
  const engine = f.get('engine')
  if (engine !== undefined && engine !== '') entry.engine = engine
  const bin = f.get('bin')
  if (bin !== undefined && bin !== '') entry.bin = bin
  const unavailableRaw = f.get('unavailable')
  if (unavailableRaw !== undefined) {
    if (unavailableRaw !== 'true' && unavailableRaw !== 'false') {
      throw new SkillSourcesError(`token '${token}' unavailable 须为 true/false: '${unavailableRaw}'`)
    }
    entry.unavailable = unavailableRaw === 'true'
  }
  const alt = f.get('alt')
  if (alt !== undefined && alt !== '') entry.alt = alt
  const note = f.get('note')
  if (note !== undefined && note !== '') entry.note = note
  return entry
}

/** 解析 templates/skill-sources.yaml 支持的窄 YAML 子集；坏结构 fail-loud。 */
export function parseSkillSources(text: string): SkillSourceDefinition[] {
  const lines = text.split('\n')
  const out: SkillSourceDefinition[] = []
  const seen = new Set<string>()
  let inSkills = false

  for (let i = 0; i < lines.length; i++) {
    const line = stripFlowComment(required(lines[i]))
    if (line.trim() === '') continue
    const indented = /^\s/.test(line)
    if (!inSkills) {
      if (/^skills:\s*$/.test(line)) inSkills = true
      continue
    }
    if (!indented) {
      inSkills = /^skills:\s*$/.test(line)
      continue
    }
    const entry = parseEntry(line, i + 1)
    if (seen.has(entry.token)) {
      throw new SkillSourcesError(`token '${entry.token}' 重复声明（第 ${i + 1} 行）`)
    }
    seen.add(entry.token)
    out.push(entry)
  }
  return out
}

const STRICT_ENTRY_FIELDS = new Set([
  'tool', 'source', 'skill', 'content_skill', 'tier', 'official', 'engine', 'bin',
  'unavailable', 'alt', 'note', 'source_kind', 'source_ref', 'content_hash', 'coordinate',
])

function strictError(category: SkillProvenanceErrorCategory, message: string): SkillProvenanceRegistryError {
  return new SkillProvenanceRegistryError(category, message)
}

function strictEntryLine(line: string, lineNo: number): {
  readonly entry: SkillSourceDefinition
  readonly fields: ReadonlyMap<string, string>
} {
  try {
    const entry = parseEntry(line, lineNo)
    const brace = line.indexOf('{')
    const close = line.lastIndexOf('}')
    if (line.slice(close + 1).trim() !== '') {
      throw strictError('invalid-source-ref', `第 ${lineNo} 行 closing brace 后含尾随 token`)
    }
    const fields = parseFlowFields(line.slice(brace + 1, close), entry.token)
    for (const key of fields.keys()) {
      if (!STRICT_ENTRY_FIELDS.has(key)) {
        throw strictError('invalid-source-ref', `token '${entry.token}' 含未知 registry 字段 '${key}'`)
      }
    }
    return { entry, fields }
  } catch (error) {
    if (error instanceof SkillProvenanceRegistryError) throw error
    throw strictError('invalid-source-ref', error instanceof Error ? error.message : String(error))
  }
}

function strictField(
  fields: ReadonlyMap<string, string>,
  token: string,
  key: string,
  category: SkillProvenanceErrorCategory = 'invalid-source-ref',
): string {
  const value = fields.get(key)
  if (value === undefined || value.trim() === '') throw strictError(category, `token '${token}' 缺少 ${key}`)
  return value
}

function strictPhysicalId(sourceRef: string): string | undefined {
  if (!sourceRef.startsWith('skills/') || sourceRef.length <= 'skills/'.length) return undefined
  const id = sourceRef.slice('skills/'.length)
  if (!isSafeProvenanceId(id)) return undefined
  return id
}

function isSafeProvenanceId(id: string): boolean {
  return id.length > 0
    && id !== '.'
    && id !== '..'
    && !id.includes('/')
    && !id.includes('\\')
    && !id.includes('\0')
}

/**
 * Strict decoder for the canonical v3 registry. It deliberately does not call
 * `parseSkillSources()`: generic compatibility parsing is allowed to remain
 * permissive, while install/verify/doctor/bundle consumers use this fail-closed path.
 */
export function parseSkillProvenanceRegistry(text: string): SkillProvenanceRegistry {
  const lines = text.split('\n')
  let version: number | undefined
  let hashAlgorithm: string | undefined
  let inSkills = false
  let seenVersion = false
  let seenHashAlgorithm = false
  let seenSkills = false
  const skills: SkillProvenanceSourceDefinition[] = []
  const seenTokens = new Set<string>()
  const seenRefs = new Set<string>()

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripFlowComment(required(lines[i]))
    if (line.trim() === '') continue
    if (!inSkills) {
      const versionMatch = /^version:\s*(\d+)\s*$/.exec(line)
      if (versionMatch) {
        if (seenVersion) throw strictError('unsupported-registry-version', `第 ${i + 1} 行重复声明 version`)
        seenVersion = true
        version = Number(versionMatch[1])
        continue
      }
      const algorithmMatch = /^hash_algorithm:\s*(.+?)\s*$/.exec(line)
      if (algorithmMatch) {
        if (seenHashAlgorithm) throw strictError('unsupported-registry-version', `第 ${i + 1} 行重复声明 hash_algorithm`)
        seenHashAlgorithm = true
        hashAlgorithm = unquoteFlowValue(required(algorithmMatch[1]))
        continue
      }
      if (/^skills:\s*$/.test(line)) {
        if (seenSkills) throw strictError('invalid-source-ref', `第 ${i + 1} 行重复声明 skills`)
        seenSkills = true
        inSkills = true
        continue
      }
      throw strictError('unsupported-registry-version', `第 ${i + 1} 行含未知 registry 顶层字段`)
    }

    if (!/^\s/.test(line)) {
      if (/^skills:\s*$/.test(line)) {
        throw strictError('invalid-source-ref', `第 ${i + 1} 行重复声明 skills`)
      }
      throw strictError('invalid-source-ref', `第 ${i + 1} 行位于 skills 块外`)
    }
    const { entry, fields } = strictEntryLine(line, i + 1)
    if (seenTokens.has(entry.token)) {
      throw strictError('duplicate-distributed-source', `token '${entry.token}' 重复声明`)
    }
    seenTokens.add(entry.token)

    const sourceKind = strictField(fields, entry.token, 'source_kind', 'unknown-source-kind')
    if (sourceKind !== 'bundled') {
      throw strictError('unknown-source-kind', `token '${entry.token}' source_kind '${sourceKind}' 不受支持`)
    }
    if (entry.tool !== 'bundled' || entry.source !== 'tenon') {
      throw strictError('unknown-source-kind', `token '${entry.token}' 必须使用 bundled/tenon source`)
    }
    const sourceRef = strictField(fields, entry.token, 'source_ref')
    const physicalId = strictPhysicalId(sourceRef)
    if (physicalId === undefined) {
      throw strictError('invalid-source-ref', `token '${entry.token}' source_ref '${sourceRef}' 不是规范的 skills/<id> 路径`)
    }
    if (seenRefs.has(sourceRef)) {
      throw strictError('duplicate-distributed-source', `source_ref '${sourceRef}' 重复声明`)
    }
    seenRefs.add(sourceRef)

    const contentHash = strictField(fields, entry.token, 'content_hash', 'content-hash-mismatch')
    if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
      throw strictError('content-hash-mismatch', `token '${entry.token}' content_hash 不是 sha256:<64 lowercase hex>`)
    }
    const coordinate = strictField(fields, entry.token, 'coordinate', 'coordinate-mismatch')
    const expectedCoordinate = `tenon:${sourceRef}@${contentHash}`
    if (coordinate !== expectedCoordinate) {
      throw strictError('coordinate-mismatch', `token '${entry.token}' coordinate 与 source_ref/content_hash 不一致`)
    }
    const declaredPhysical = entry.contentSkill ?? entry.token
    if (declaredPhysical !== physicalId) {
      throw strictError('invalid-source-ref', `token '${entry.token}' content_skill 与 source_ref 不一致`)
    }

    skills.push({
      ...entry,
      sourceKind,
      sourceRef,
      contentHash: contentHash as `sha256:${string}`,
      coordinate,
    })
  }

  if (version !== SKILL_PROVENANCE_REGISTRY_VERSION) {
    throw strictError(
      'unsupported-registry-version',
      `registry version '${version === undefined ? '' : version}' 不受支持（需要 ${SKILL_PROVENANCE_REGISTRY_VERSION}）`,
    )
  }
  if (hashAlgorithm !== SKILL_PROVENANCE_HASH_ALGORITHM) {
    throw strictError(
      'unsupported-registry-version',
      `hash_algorithm '${hashAlgorithm ?? ''}' 不受支持（需要 ${SKILL_PROVENANCE_HASH_ALGORITHM}）`,
    )
  }
  if (!inSkills) {
    throw strictError('invalid-source-ref', 'registry 缺少 skills: 条目块')
  }
  return { version: SKILL_PROVENANCE_REGISTRY_VERSION, hashAlgorithm: SKILL_PROVENANCE_HASH_ALGORITHM, skills }
}
