/**
 * loadManifest —— templates/manifest.yaml 的手写窄解析器 + 全派生面（BACKLOG #18 / GOAL A1）。
 *
 * 单一真相源护城河（GOAL B2/D8）：所有派生字段都从 yaml 数据真解析而来，零硬编码——
 * 改 yaml 即改派生，正是老仓 review_phases「半接线」欠账（manifest.py 能派生但消费方
 * state-transition.sh:159-161 硬编码未读）的构造性反面。回归锚见 manifest-derive.test.ts。
 *
 * 派生函数盘点（× = 派生什么 → 消费方；括号内为老仓 skills/pipeline/scripts/manifest.py 行号）：
 *   · phases/transitions/reviewPhases  ← 老 sorted_phases 212 / get_transitions 372 / review_phases。
 *       消费方：createFlowEngine（引擎真读，engine.ts:30-34）。
 *   · mandatorySkills / recommendedSkills ← 老 evidence 346-355（per phase×track，`_all` 兜底）。
 *       老消费方：pipeline-guard.sh（经 gen_sh 563 派生的 manifest_mandatory/_recommended）。
 *       新仓消费方两条：① router 缓存链——hooks/router-gen.mjs:74-77 与等价的
 *         packages/cli/src/commands/gen-router.ts:41-44 经 skillsFor 派生
 *         RECSKILL_/MANDSKILL_<phase>_<track> 写进 .pipeline-router.generated.sh，
 *         hooks/router.sh:202-203 source 后每轮注入提示；② dashboard 配置面——
 *         packages/server/src/config.ts:60 flattenMandatorySkills → server.ts:512 GET /api/config。
 *       两表在 router 注入面的差别**只是文案分级**（router.sh:215-216「推荐 skill」/「本相位强制 skill」）：
 *       老仓 evidence 的「强制缺失 = [HARD] 阻断」判定未移植（GUARD-RULES.md:119，O6/E4/S6/B8/V8/V9/P5
 *       全 ❌），故 mandatory 缺失**不阻断 phase transition，也不影响 AFK scheduler**。
 *       但它并非全无后果：`tenon doctor` 对两表分级处置（doctor.ts:236 起——mandatory 缺失报
 *       **red 且返回非零**，recommended 缺失只报 yellow），即它会让 doctor 的就绪检查失败。
 *       gate.sh / session-start.sh 不读本派生（前者走 internal-skill-gate 的 skill DAG 判定，
 *       后者只打印静态横幅）——它们曾被规划为消费方，实际接线落在了 router 与 server。
 *   · breadcrumbs ← 老 breadcrumb 子命令 1031-1037（phases.<phase>.breadcrumb block scalar）。
 *       老消费方：pipeline-router.sh breadcrumb_body（每轮被动注入）。
 *       新仓消费方：router-gen.mjs:66-67 / gen-router.ts:35-36 派生 BREADCRUMB_<phase> →
 *       hooks/router.sh:201 间接变量取值，每轮随注入体输出。
 *   · skillsFor（纯 helper）← 老 evidence 346-355 的三级回退（per-track → `_all` → 空）。
 *       消费方：同 mandatorySkills/recommendedSkills 的 ① router 缓存链。
 *
 * 窄解析子集（CONTRACT §1 禁 yaml npm 包）：
 *   · 顶层键 `key:` / `key: [inline, list]`
 *   · 块序列（两空格缩进 `- item`）
 *   · transitions / *_skills 小节的 `from: [to1, to2]` 条目（skill token 逐字保留，含 a|b 备选与 : 前缀）
 *   · breadcrumb 小节：`phase: |` 字面块标量（缩进决定块界，末尾换行 rstrip，对齐老 CLI）
 *   · `#` 整行注释、行尾注释（前置空白 + #）、空行
 * 其余 YAML 特性一律不支持；结构错误 fail-loud（ManifestError），
 * 对齐老内核 state-transition.sh「manifest 不可用 → HARD STOP，绝不静默丢 review-gate」。
 */
import { readFileSync } from 'node:fs'
import { PHASES } from '../types.js'
import type { ManifestData, Phase } from '../types.js'
import { WORKFLOW_ACTIONS, type WorkflowAction } from '../workflow/policy.js'

export class ManifestError extends Error {
  constructor(message: string) {
    super(`manifest: ${message}`)
    this.name = 'ManifestError'
  }
}

const PHASE_SET: ReadonlySet<string> = new Set(PHASES)

/** skill 表的 profile 键：三种标准矩阵 + free 产物 profile + `_all` 全 track 兜底哨兵。 */
export type SkillTrackKey = 'pm' | 'frontend' | 'backend' | 'free' | '_all'
const SKILL_TRACK_SET: ReadonlySet<string> = new Set<SkillTrackKey>(['pm', 'frontend', 'backend', 'free', '_all'])

/** phase → track → skill token 列表（a|b 备选逐字保留，消费方自择其一） */
export type SkillTable = Readonly<Record<Phase, Readonly<Partial<Record<SkillTrackKey, readonly string[]>>>>>

export interface SkillActionAuthorityManifestV1 {
  readonly version: 'v1'
  readonly grants: Readonly<Partial<Record<SkillTrackKey, readonly WorkflowAction[]>>>
}

/**
 * loadManifest 的完整返回面（types.ts::ManifestData 的扩展）。
 * 字段留在本文件、没有并进 types.ts::ManifestData：后者是**引擎面最小契约**
 * （FlowEngine/createFlowEngine 只需 phases/transitions/reviewPhases），本接口是解析器的全量产出，
 * 二者分开可让引擎不依赖 skill/breadcrumb 派生。导出链：flow/index.ts **具名** re-export（:7-12），
 * kernel index.ts 再 `export *`；消费方从 `@tenon/kernel` 具名导入（如 server/src/config.ts:60）。
 */
export interface ExtendedManifestData extends ManifestData {
  /** phase×track 强制 skill 表。消费方与「强制」在新仓的实际效力（仅注入文案）见文件头盘点。 */
  mandatorySkills: SkillTable
  /** phase×track 推荐 skill 表。与 mandatorySkills 同链路，仅注入文案措辞不同。 */
  recommendedSkills: SkillTable
  /** Explicit closed action grants by Skill profile; never inferred from skill slots or prose. */
  skillActionAuthority: SkillActionAuthorityManifestV1 | null
  /** phase → breadcrumb prose；hooks/router.sh:201 每轮注入。缺相位则键缺省。 */
  breadcrumbs: Readonly<Partial<Record<Phase, string>>>
}

/**
 * skill 三级回退查询（对齐老 evidence 346-355：per-track → `_all` → 空）。
 * 纯 helper；消费方 hooks/router-gen.mjs:74-75 与 cli/src/commands/gen-router.ts:41-42 调用之，
 * 回退逻辑单源于此、两处消费方都不重抄。
 */
export function skillsFor(table: SkillTable, phase: Phase, track: string): readonly string[] {
  const row = table[phase]
  if (!row) return []
  if (track in row) return row[track as SkillTrackKey] ?? []
  if ('_all' in row) return row._all ?? []
  return []
}

/**
 * skill token 归一（G2 P5）——把一个 manifest skill token 的 `a|b` 备选语法拆成具体
 * alternatives 列表（保序）。manifest 把 `a|b` 原样保留、要求消费方自择其一（见 skillsFor 头注 +
 * SkillTable 注释 + templates/manifest.yaml `opsx:explore|openspec-explore` 等）；EffectiveSkillResolver
 * （artifact register 的 producer 校验接缝）据本 helper 把一个 token 展开成「满足其一即可」的具体
 * skill 集。无 `|` 的 token → 单元素 [token]（具体 skill id 退化态）。
 *
 * 畸形 token fail-loud（绝不静默过滤，对齐 loadManifest 的 fail-loud 纪律）：
 *   · 空 branch（`a|`、`|b`、`a||b`）—— 备选语法不许空段，manifest 数据错误；
 *   · 重复 branch（`a|a`）—— 同一 slot 内重复具体 id，manifest 数据错误；
 *   · branch 按 `:`（namespaced `plugin:skill` 分隔符）再拆一层后，任一段为空或恰为 `.`
 *     （如单独的 `.`、`superpowers:`、`:brainstorming`、`superpowers:.`）—— 这类 id 下游经
 *     `join(root, id)` 定位物理内容时会解析回根目录本身，等于把整个 skill 根目录错当一个 skill
 *     交出去（H10 r1 复审阻断4；对齐 `packages/automation/src/skills/types.ts::isPathSafeSkillId`
 *     的路径纪律——那层校验拦得住 `/`、`..`，但拦不住裸 `.`，本处在 token 语义层把这个口子堵上）。
 * 本 helper 只做纯字符串归一，不改 manifest 数据模型；错误用 ManifestError（token 源出 manifest）。
 */
export function skillTokenAlternatives(token: string): readonly string[] {
  const branches = token.split('|')
  const out: string[] = []
  const seen = new Set<string>()
  for (const branch of branches) {
    if (branch.trim() === '') {
      throw new ManifestError(`skill token '${token}' 含空/纯空白 alternative branch（如 'a|b'、'|b'、'a| |b'，备选语法不许空段）`)
    }
    for (const segment of branch.split(':')) {
      if (segment === '' || segment === '.') {
        throw new ManifestError(
          `skill token '${token}' 的 alternative branch '${branch}' 含非法路径段 ${JSON.stringify(segment)}`
          + `（禁空段、禁单独 '.'——会被物理定位当成整个 skill 根目录）`,
        )
      }
    }
    if (seen.has(branch)) {
      throw new ManifestError(`skill token '${token}' 含重复 alternative branch '${branch}'`)
    }
    seen.add(branch)
    out.push(branch)
  }
  return out
}

function assertPhase(name: string, ctx: string): Phase {
  if (!PHASE_SET.has(name)) {
    throw new ManifestError(`${ctx} 含未知相位 '${name}'（合法：${PHASES.join('/')}）`)
  }
  return name as Phase
}

/** 去掉整行/行尾注释（子集里值不含引号与 #，安全裁剪）；返回 trimEnd 后的行 */
function stripComment(line: string): string {
  const t = line.trimStart()
  if (t.startsWith('#')) return ''
  // 行尾注释：空白 + '#' 起裁剪
  const m = line.match(/^(.*?)\s#/)
  return (m ? m[1]! : line).trimEnd()
}

/** 前导空格数（缩进量）；块标量缩进判界用。全空/空行由调用方先以 trim()==='' 排除 */
function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

/** 解析单行流式列表 `[a, b, c]`；`[]` → []。非法格式 → throw */
function parseFlowList(raw: string, ctx: string): string[] {
  const s = raw.trim()
  const m = s.match(/^\[(.*)\]$/)
  if (!m) throw new ManifestError(`${ctx} 期望单行流式列表 [a, b]，得到 '${raw}'`)
  const inner = m[1]!.trim()
  if (inner === '') return []
  return inner.split(',').map((x) => x.trim()).filter((x) => x !== '')
}

/** 解析单/双引号标量或裸标量（breadcrumb 单行值）；引号内内容逐字保真，裸值裁行尾注释 */
function parseScalarValue(rest: string, ctx: string): string {
  const s = rest.trim()
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1)
    if (end < 0) throw new ManifestError(`${ctx} 单引号未闭合: '${rest}'`)
    return s.slice(1, end)
  }
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end < 0) throw new ManifestError(`${ctx} 双引号未闭合: '${rest}'`)
    return s.slice(1, end)
  }
  const m = s.match(/^(.*?)\s#/)
  return (m ? m[1]! : s).trimEnd()
}

interface RawSections {
  phases?: string[]
  transitions?: Map<string, string[]>
  review_phases?: string[]
  mandatory_skills?: Map<string, string[]>
  recommended_skills?: Map<string, string[]>
  skill_action_authority?: { version: string; grants: Map<string, string[]> }
  breadcrumb?: Map<string, string>
}

function parseSkillActionAuthorityBlock(
  lines: string[], start: number, path: string,
): { value: { version: string; grants: Map<string, string[]> }; next: number } {
  let version: string | undefined
  const grants = new Map<string, string[]>()
  let i = start
  while (i < lines.length) {
    const line = stripComment(lines[i]!)
    if (line.trim() === '') { i++; continue }
    if (!/^\s/.test(line)) break
    const entry = line.match(/^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!entry) throw new ManifestError(`${path}:${i + 1} skill_action_authority 条目格式错误`)
    const key = entry[1]!
    const raw = entry[2]!.trim()
    if (key === 'version') {
      if (version !== undefined || raw === '') throw new ManifestError(`${path}:${i + 1} skill_action_authority.version 重复或为空`)
      version = parseScalarValue(raw, 'skill_action_authority.version')
    } else {
      if (grants.has(key)) throw new ManifestError(`${path}:${i + 1} skill_action_authority.${key} 重复`)
      const list = raw.match(/^\[(.*)\]$/)
      if (list && list[1]!.trim() !== '' && list[1]!.split(',').some((item) => item.trim() === '')) {
        throw new ManifestError(`${path}:${i + 1} skill_action_authority.${key} 含空 action`)
      }
      grants.set(key, parseFlowList(raw, `skill_action_authority.${key}`))
    }
    i++
  }
  if (version === undefined) throw new ManifestError(`${path} skill_action_authority 缺 version`)
  return { value: { version, grants }, next: i }
}

function decodeDoubleQuotedYamlKey(token: string): string | undefined {
  if (!token.startsWith('"') || !token.endsWith('"')) return undefined
  const body = token.slice(1, -1)
  let decoded = ''
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== '\\') {
      decoded += char
      continue
    }
    const escape = body[++i]
    if (escape === undefined) return undefined
    const width = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : 0
    if (width > 0) {
      const hex = body.slice(i + 1, i + 1 + width)
      if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return undefined
      const codePoint = Number.parseInt(hex, 16)
      if (codePoint > 0x10ffff) return undefined
      decoded += String.fromCodePoint(codePoint)
      i += width
      continue
    }
    const simple: Readonly<Record<string, string>> = {
      '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
      ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
    }
    const value = simple[escape]
    if (value === undefined) return undefined
    decoded += value
  }
  return decoded
}

/** 只解码 YAML scalar key；用途仅限识别废弃顶层键，不扩张 manifest 的受支持 YAML 子集。 */
function decodeYamlKey(token: string): string | undefined {
  const trimmed = token.trim()
  if (trimmed.startsWith('"')) return decodeDoubleQuotedYamlKey(trimmed)
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed) ? trimmed : undefined
}

function topLevelKeyToken(raw: string): string | undefined {
  const line = raw.trimStart()
  if (line === '' || line.startsWith('#')) return undefined

  const explicit = line.match(/^\?\s+(.+?)\s*(?:\s+#.*)?$/)
  if (explicit) return explicit[1]

  const quoted = line.match(/^("(?:\\.|[^"\\])*"|'(?:''|[^'])*')\s*:/)
  if (quoted) return quoted[1]

  const plain = line.match(/^([^:#]+?)\s*:/)
  return plain?.[1]
}

function hasDeprecatedRouterKeyAt(lines: readonly string[], index: number): boolean {
  const direct = topLevelKeyToken(lines[index]!)
  if (direct !== undefined && decodeYamlKey(direct) === 'router_patterns') return true

  // YAML explicit mapping key 也允许 `?` 与 scalar 分行；只看当前顶层扫描位置的缩进子行。
  const current = lines[index]!
  if (current.trim() !== '?') return false
  const parentIndent = indentOf(current)
  for (let i = index + 1; i < lines.length; i++) {
    const candidate = lines[i]!
    if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) continue
    if (indentOf(candidate) <= parentIndent) return false
    return decodeYamlKey(candidate.trim()) === 'router_patterns'
  }
  return false
}

function throwDeprecatedRouterKey(path: string, line: number): never {
  throw new ManifestError(
    `${path}:${line} router_patterns 已迁移到 .pipeline/tracks.yaml 的 policy_profile.routing；`
    + '请删除旧字段并在 Track Registry 中声明 routing policy',
  )
}

/** 块小节 `key: [flowlist]`（*_skills 用；key 允许含 `.` 与 `_all`）；返回 {map, next} */
function parseSkillBlock(lines: string[], start: number, path: string, section: string): { map: Map<string, string[]>; next: number } {
  const map = new Map<string, string[]>()
  let i = start
  while (i < lines.length) {
    const l = stripComment(lines[i]!)
    if (l.trim() === '') { i++; continue }
    if (!/^\s/.test(l)) break // 回到顶层
    const entry = l.match(/^\s+([A-Za-z_][A-Za-z0-9_.-]*):\s*(\[.*\])\s*$/)
    if (!entry) {
      throw new ManifestError(`${path}:${i + 1} ${section} 条目须为 'phase.track: [skill, ...]'，得到 '${lines[i]}'`)
    }
    map.set(entry[1]!, parseFlowList(entry[2]!, `${section}.${entry[1]}`))
    i++
  }
  return { map, next: i }
}

/** 块小节 `phase: |`（breadcrumb block scalar）；缩进决定块界，末尾换行 rstrip；返回 {map, next} */
function parseBreadcrumbBlock(lines: string[], start: number, path: string): { map: Map<string, string>; next: number } {
  const map = new Map<string, string>()
  let i = start
  while (i < lines.length) {
    const raw = lines[i]!
    if (raw.trim() === '') { i++; continue }
    const ind = indentOf(raw)
    if (ind === 0) break // 回到顶层（含顶层注释：交回主循环 stripComment 处理）
    if (raw.trimStart().startsWith('#')) { i++; continue } // 小节内注释
    const entry = raw.match(/^(\s+)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!entry) {
      throw new ManifestError(`${path}:${i + 1} breadcrumb 条目须为 'phase: |' 或 'phase: value'，得到 '${lines[i]}'`)
    }
    const keyIndent = entry[1]!.length
    const key = entry[2]!
    const rest = entry[3]!.trim()
    i++
    if (rest === '|' || rest === '|-' || rest === '|+') {
      const blk: string[] = []
      while (i < lines.length) {
        const bl = lines[i]!
        if (bl.trim() === '') { blk.push(''); i++; continue }
        if (indentOf(bl) <= keyIndent) break // 缩进回退 = 块结束
        blk.push(bl)
        i++
      }
      const firstContent = blk.find((x) => x !== '')
      let value = ''
      if (firstContent !== undefined) {
        const blockIndent = indentOf(firstContent)
        value = blk.map((x) => (x === '' ? '' : x.slice(blockIndent))).join('\n').replace(/\n+$/, '')
      }
      map.set(key, value)
    } else {
      map.set(key, parseScalarValue(rest, `breadcrumb.${key}`))
    }
  }
  return { map, next: i }
}

/** 逐行扫描：识别已知顶层小节；未知顶层键连同其缩进块整体跳过（前向兼容） */
function scanSections(text: string, path: string): RawSections {
  const lines = text.split('\n')
  const out: RawSections = {}
  let i = 0
  while (i < lines.length) {
    if (hasDeprecatedRouterKeyAt(lines, i)) throwDeprecatedRouterKey(path, i + 1)
    const line = stripComment(lines[i]!)
    if (line.trim() === '') { i++; continue }
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!top) {
      throw new ManifestError(
        `${path}:${i + 1} 无法解析的顶层行 '${lines[i]}'（窄解析子集外）；`
        + '若该键是旧 router_patterns 的 YAML 等价写法：它已迁移到 '
        + '.pipeline/tracks.yaml 的 policy_profile.routing',
      )
    }
    const key = top[1]!
    const rest = top[2]!.trim()
    if (key === 'phases' || key === 'review_phases') {
      const items: string[] = []
      if (rest !== '') {
        items.push(...parseFlowList(rest, key))
        i++
      } else {
        i++
        while (i < lines.length) {
          const l = stripComment(lines[i]!)
          if (l.trim() === '') { i++; continue }
          const item = l.match(/^\s+-\s+(\S+)\s*$/)
          if (!item) break // 下一个顶层键或子集外结构，交回主循环
          items.push(item[1]!)
          i++
        }
      }
      if (key === 'phases') out.phases = items
      else out.review_phases = items
    } else if (key === 'transitions') {
      if (rest !== '') throw new ManifestError(`${path}:${i + 1} transitions 必须是块小节`)
      const map = new Map<string, string[]>()
      i++
      while (i < lines.length) {
        const l = stripComment(lines[i]!)
        if (l.trim() === '') { i++; continue }
        if (!/^\s/.test(l)) break // 回到顶层
        const entry = l.match(/^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(\[.*\])\s*$/)
        if (!entry) {
          throw new ManifestError(`${path}:${i + 1} transitions 条目须为 'from: [to, ...]'，得到 '${lines[i]}'`)
        }
        map.set(entry[1]!, parseFlowList(entry[2]!, `transitions.${entry[1]}`))
        i++
      }
      out.transitions = map
    } else if (key === 'mandatory_skills' || key === 'recommended_skills') {
      if (rest !== '') throw new ManifestError(`${path}:${i + 1} ${key} 必须是块小节`)
      const r = parseSkillBlock(lines, i + 1, path, key)
      if (key === 'mandatory_skills') out.mandatory_skills = r.map
      else out.recommended_skills = r.map
      i = r.next
    } else if (key === 'skill_action_authority') {
      if (rest !== '') throw new ManifestError(`${path}:${i + 1} skill_action_authority 必须是块小节`)
      if (out.skill_action_authority !== undefined) throw new ManifestError(`${path}:${i + 1} skill_action_authority 小节重复`)
      const r = parseSkillActionAuthorityBlock(lines, i + 1, path)
      out.skill_action_authority = r.value
      i = r.next
    } else if (key === 'breadcrumb') {
      if (rest !== '') throw new ManifestError(`${path}:${i + 1} breadcrumb 必须是块小节`)
      const r = parseBreadcrumbBlock(lines, i + 1, path)
      out.breadcrumb = r.map
      i = r.next
    } else {
      // 未知顶层键：跳过它与其整个缩进块（允许 manifest 未来加节而不破 kernel）
      i++
      while (i < lines.length) {
        const l = lines[i]!
        const stripped = stripComment(l)
        if (stripped.trim() !== '' && !/^\s/.test(stripped)) break
        i++
      }
    }
  }
  return out
}

/** 建空 skill 表（全相位 → {}），供缺节 / 增量填充的基座 */
function emptySkillTable(): Record<Phase, Partial<Record<SkillTrackKey, readonly string[]>>> {
  const t = {} as Record<Phase, Partial<Record<SkillTrackKey, readonly string[]>>>
  for (const p of PHASES) t[p] = {}
  return t
}

/** 派生 skill 表：校验 phase 已声明、track 合法（fail-loud，老 evidence fail-open 的改进），逐条填入 */
function deriveSkillTable(
  raw: Map<string, string[]> | undefined,
  declared: ReadonlySet<Phase>,
  section: string,
): SkillTable {
  const table = emptySkillTable()
  if (!raw) return table
  for (const [pt, list] of raw) {
    const dot = pt.indexOf('.')
    if (dot <= 0 || dot === pt.length - 1) {
      throw new ManifestError(`${section} 键 '${pt}' 须为 'phase.track' 形式`)
    }
    const phaseName = pt.slice(0, dot)
    const track = pt.slice(dot + 1)
    const phase = assertPhase(phaseName, section)
    if (!declared.has(phase)) throw new ManifestError(`${section}.${pt} 相位 '${phaseName}' 未在 phases 声明`)
    if (!SKILL_TRACK_SET.has(track)) {
      throw new ManifestError(`${section}.${pt} 含未知 profile '${track}'（合法：pm/frontend/backend/free/_all）`)
    }
    table[phase][track as SkillTrackKey] = list
  }
  return table
}

function deriveSkillActionAuthority(
  raw: RawSections['skill_action_authority'],
): SkillActionAuthorityManifestV1 | null {
  if (!raw) return null
  if (raw.version !== 'v1') throw new ManifestError(`skill_action_authority.version '${raw.version}' 不受支持（合法：v1）`)
  const actions = new Set<string>(WORKFLOW_ACTIONS)
  const grants: Partial<Record<SkillTrackKey, readonly WorkflowAction[]>> = {}
  for (const [profile, values] of raw.grants) {
    if (!SKILL_TRACK_SET.has(profile)) {
      throw new ManifestError(`skill_action_authority 含未知 profile '${profile}'（合法：pm/frontend/backend/free/_all）`)
    }
    if (new Set(values).size !== values.length || values.some((action) => !actions.has(action))) {
      throw new ManifestError(`skill_action_authority.${profile} 含未知或重复 action`)
    }
    grants[profile as SkillTrackKey] = values as WorkflowAction[]
  }
  return { version: 'v1', grants }
}

export function loadManifest(path: string): ExtendedManifestData {
  const text = readFileSync(path, 'utf8')
  const raw = scanSections(text, path)

  if (!raw.phases || raw.phases.length === 0) throw new ManifestError(`${path} 缺 phases 小节`)
  if (!raw.transitions) throw new ManifestError(`${path} 缺 transitions 小节`)
  if (!raw.review_phases) {
    // fail-loud：review-gate 名单缺失绝不静默（老内核 HARD STOP 语义）
    throw new ManifestError(`${path} 缺 review_phases 键（review-gate 名单不许静默缺失）`)
  }

  const phases = raw.phases.map((p) => assertPhase(p, 'phases'))
  const declared = new Set<Phase>(phases)
  if (declared.size !== phases.length) throw new ManifestError('phases 含重复相位')

  // transitions：每个已声明相位必须有条目（可为 []）；from/to 都必须是已声明相位
  const transitions = {} as Record<Phase, readonly Phase[]>
  for (const p of PHASES) transitions[p] = []
  for (const [from, targets] of raw.transitions) {
    const fromPh = assertPhase(from, 'transitions')
    if (!declared.has(fromPh)) throw new ManifestError(`transitions.${from} 不在已声明 phases 中`)
    transitions[fromPh] = targets.map((t) => {
      const toPh = assertPhase(t, `transitions.${from}`)
      if (!declared.has(toPh)) throw new ManifestError(`transitions.${from} 指向未声明相位 '${t}'`)
      return toPh
    })
  }
  for (const p of phases) {
    if (!raw.transitions.has(p)) {
      throw new ManifestError(`transitions 缺相位 '${p}' 的条目（终态也须显式声明，可为 []）`)
    }
  }

  const reviewPhases = raw.review_phases.map((p) => {
    const ph = assertPhase(p, 'review_phases')
    if (!declared.has(ph)) throw new ManifestError(`review_phases 含未声明相位 '${p}'`)
    return ph
  })

  // —— 全派生面（本轮新增，全部从 yaml 数据真派生，缺节安全降级为空，零硬编码）——
  const mandatorySkills = deriveSkillTable(raw.mandatory_skills, declared, 'mandatory_skills')
  const recommendedSkills = deriveSkillTable(raw.recommended_skills, declared, 'recommended_skills')
  const skillActionAuthority = deriveSkillActionAuthority(raw.skill_action_authority)
  const breadcrumbs: Partial<Record<Phase, string>> = {}
  if (raw.breadcrumb) {
    for (const [phaseName, prose] of raw.breadcrumb) {
      const ph = assertPhase(phaseName, 'breadcrumb')
      if (!declared.has(ph)) throw new ManifestError(`breadcrumb 含未声明相位 '${phaseName}'`)
      breadcrumbs[ph] = prose
    }
  }

  return {
    phases, transitions, reviewPhases, mandatorySkills, recommendedSkills,
    skillActionAuthority, breadcrumbs,
  }
}
