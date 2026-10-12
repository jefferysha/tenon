/**
 * loops registry —— `.pipeline/loops.yaml` 窄解析 + JSON Schema 关键字子集校验 + 四态载入契约。
 *
 * 老仓真相源（严格移植，行号锚 workflow-plugin/skills/pipeline/scripts/loops_registry.py）：
 *   · validate() 73-141      —— 手写 JSON Schema 关键字子集校验器（type/required/additionalProperties/
 *                                enum/pattern/minLength/minItems/minimum/const/properties/items），
 *                                未实现关键字 fail-loud（NotImplementedError，R3 不静默放行）。
 *   · load_registry() 149-177 —— 缺文件→(null,[]) / 坏解析→(null,[err]) / 校验失败→(null,[err]) / 合法→(data,[])。
 *   · loops.schema.json      —— 数据模式（version const 1 / loops[] minItems 1 / budget / kill_criteria …）。
 *
 * 本仓改进（CONTRACT §1：kernel 零第三方依赖，禁 yaml npm 包）：老仓靠 PyYAML `safe_load`；本仓手写
 * **块式 YAML 窄解析器**（复用 flow/manifest.ts 的窄解析风格），支持嵌套 mapping / 块序列 /
 * 序列内 mapping 项 / 内联流式列表 / 引号与裸标量 / int·bool·null / 注释。其余 YAML 特性一律不支持，
 * 结构错误返回定位 error（不 throw 出模块，契约同老仓 load_registry）。
 *
 * 本轮新增（老仓无）：schema 纳入 `autonomy_level`（enum L1/L2/L3，可选；缺省由 loadRegistry 派生填 L1）——
 * loop-engineering 分级放权字段先入 schema，执行面留 #38。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoopEntry, LoopRegistry } from './types.js'
import { required } from '../required.js'

// ── 窄 YAML 解析器（块式，缩进决定层级；零第三方）─────────────────────────────

type YamlScalar = string | number | boolean | null
export type YamlValue = YamlScalar | YamlValue[] | { [k: string]: YamlValue }

interface Token {
  indent: number
  kind: 'kv' | 'dash' | 'scalar'
  key?: string
  rest?: string // kv 的值原文（未解析）；空串 = 嵌套块 / null
  raw?: string // scalar 的原文
}

const KEY_RE = /^([A-Za-z_][\w.-]*):(?:\s+(.*)|\s*)$/

/** 词法：逐行 → token 流（跳过空行/整行注释；序列项拆成 dash + 内联 kv/scalar）。 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '') continue
    const trimmedStart = line.replace(/^\s*/, '')
    if (trimmedStart.startsWith('#')) continue
    const indent = line.length - trimmedStart.length
    const content = trimmedStart

    if (content === '-' || content.startsWith('- ')) {
      const dashRest = content.slice(1)
      const after = dashRest.replace(/^\s*/, '')
      const itemCol = indent + 1 + (dashRest.length - after.length)
      tokens.push({ indent, kind: 'dash' })
      if (after !== '') {
        const km = after.match(KEY_RE)
        if (km) tokens.push({ indent: itemCol, kind: 'kv', key: required(km[1]), rest: km[2] ?? '' })
        else tokens.push({ indent: itemCol, kind: 'scalar', raw: after })
      }
      continue
    }

    const km = content.match(KEY_RE)
    if (km) {
      tokens.push({ indent, kind: 'kv', key: required(km[1]), rest: km[2] ?? '' })
    } else {
      tokens.push({ indent, kind: 'scalar', raw: content })
    }
  }
  return tokens
}

class YamlParseError extends Error {}

function parseScalar(raw: string): YamlValue {
  let s = raw.trim()
  // 引号/内联列表内部不裁注释；裸标量裁行尾 ` #...`
  if (!(s.startsWith('"') || s.startsWith("'") || s.startsWith('['))) {
    const cm = s.match(/^(.*?)\s+#.*$/)
    if (cm) s = required(cm[1]).trimEnd()
  }
  if (s === '') return null
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((x) => parseScalar(x))
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1)
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1)
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

function parseMapping(tokens: Token[], start: number, indent: number): { value: YamlValue; next: number } {
  const map: { [k: string]: YamlValue } = {}
  let i = start
  while (i < tokens.length && required(tokens[i]).indent === indent && required(tokens[i]).kind === 'kv') {
    const t = required(tokens[i])
    i++
    if ((t.rest ?? '') === '') {
      if (i < tokens.length && required(tokens[i]).indent > indent) {
        const r = parseValue(tokens, i, required(tokens[i]).indent)
        map[required(t.key)] = r.value
        i = r.next
      } else {
        map[required(t.key)] = null
      }
    } else {
      map[required(t.key)] = parseScalar(required(t.rest))
    }
  }
  return { value: map, next: i }
}

function parseSequence(tokens: Token[], start: number, indent: number): { value: YamlValue; next: number } {
  const arr: YamlValue[] = []
  let i = start
  while (i < tokens.length && required(tokens[i]).indent === indent && required(tokens[i]).kind === 'dash') {
    i++ // 吃掉 dash
    if (i < tokens.length && required(tokens[i]).indent > indent) {
      const r = parseValue(tokens, i, required(tokens[i]).indent)
      arr.push(r.value)
      i = r.next
    } else {
      arr.push(null)
    }
  }
  return { value: arr, next: i }
}

function parseValue(tokens: Token[], i: number, indent: number): { value: YamlValue; next: number } {
  const t = required(tokens[i])
  if (t.kind === 'dash') return parseSequence(tokens, i, indent)
  if (t.kind === 'kv') return parseMapping(tokens, i, indent)
  return { value: parseScalar(required(t.raw)), next: i + 1 }
}

/**
 * 窄 YAML 解析：合法 → {data, error:null}；结构不可解析 / 顶层非 collection → {data:null, error}。
 * 契约同老仓 load_registry：解析层不 throw，错误以定位 string 回传（调用方拼进 errors）。
 */
export function parseLoopsYaml(text: string): { data: YamlValue | null; error: string | null } {
  try {
    const tokens = tokenize(text)
    if (tokens.length === 0) return { data: null, error: '空文档（无内容）' }
    const first = required(tokens[0])
    if (first.indent !== 0) throw new YamlParseError(`顶层意外缩进（第一个 token indent=${first.indent}）`)
    let result: { value: YamlValue; next: number }
    if (first.kind === 'kv') result = parseMapping(tokens, 0, 0)
    else if (first.kind === 'dash') result = parseSequence(tokens, 0, 0)
    else throw new YamlParseError('顶层必须是 mapping 或 sequence（得到裸标量）')
    if (result.next !== tokens.length) {
      throw new YamlParseError(`残留未解析内容（自 token #${result.next}，缩进不一致或子集外结构）`)
    }
    return { data: result.value, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── JSON Schema 关键字子集校验器（老 validate 73-141，fail-loud 未实现关键字）──────

const ANNOTATION_KEYWORDS = new Set(['$schema', '$comment', '$id', 'title', 'description'])
const VALIDATION_KEYWORDS = new Set([
  'type', 'required', 'additionalProperties', 'enum', 'pattern',
  'minLength', 'minItems', 'minimum', 'const', 'properties', 'items',
])

type SchemaNode = Record<string, unknown>

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

function typeMatches(instance: unknown, typeSpec: unknown): boolean {
  const types = Array.isArray(typeSpec) ? typeSpec : [typeSpec]
  for (const t of types) {
    if (t === 'object' && instance !== null && typeof instance === 'object' && !Array.isArray(instance)) return true
    if (t === 'array' && Array.isArray(instance)) return true
    if (t === 'string' && typeof instance === 'string') return true
    if (t === 'integer' && typeof instance === 'number' && Number.isInteger(instance)) return true
    if (t === 'number' && typeof instance === 'number') return true
    if (t === 'boolean' && typeof instance === 'boolean') return true
    if (t === 'null' && instance === null) return true
  }
  return false
}

/**
 * 递归校验 instance 是否满足 schema（关键字子集）。返回定位错误列表（空 = 合法）。
 * schema 节点出现未实现关键字 → throw（fail-loud，见老 validate 82-87；R3 不静默放行未实现约束）。
 */
export function validateSchema(instance: unknown, schema: SchemaNode, path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return []

  for (const kw of Object.keys(schema)) {
    if (!ANNOTATION_KEYWORDS.has(kw) && !VALIDATION_KEYWORDS.has(kw)) {
      throw new Error(`loops validator: unsupported schema keyword '${kw}' at ${path || '<root>'}`)
    }
  }

  const label = path || '<root>'
  const errors: string[] = []

  if ('const' in schema) {
    if (instance !== schema.const) {
      errors.push(`${label}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}`)
      return errors
    }
  }

  if ('type' in schema) {
    if (!typeMatches(instance, schema.type)) {
      errors.push(`${label}: expected type ${JSON.stringify(schema.type)}, got ${instance === null ? 'null' : typeof instance}`)
      return errors
    }
  }

  if ('enum' in schema && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(instance)) {
      errors.push(`${label}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(instance)}`)
    }
  }

  if ('pattern' in schema && typeof instance === 'string') {
    if (!new RegExp(schema.pattern as string).test(instance)) {
      errors.push(`${label}: does not match pattern ${JSON.stringify(schema.pattern)}`)
    }
  }

  if ('minLength' in schema && typeof instance === 'string') {
    if (instance.length < (schema.minLength as number)) {
      errors.push(`${label}: expected minLength ${schema.minLength}, got length ${instance.length}`)
    }
  }

  if ('minItems' in schema && Array.isArray(instance)) {
    if (instance.length < (schema.minItems as number)) {
      errors.push(`${label}: expected minItems ${schema.minItems}, got ${instance.length}`)
    }
  }

  if ('minimum' in schema && typeof instance === 'number') {
    if (instance < (schema.minimum as number)) {
      errors.push(`${label}: expected >= ${schema.minimum}, got ${instance}`)
    }
  }

  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    const obj = instance as Record<string, unknown>
    const props = (schema.properties as Record<string, SchemaNode> | undefined) ?? {}
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push(`${joinPath(path, req)}: missing required field`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${joinPath(path, key)}: unexpected additional field (not in schema)`)
      }
    }
    for (const [key, subschema] of Object.entries(props)) {
      if (key in obj) errors.push(...validateSchema(obj[key], subschema, joinPath(path, key)))
    }
  }

  if (Array.isArray(instance) && 'items' in schema) {
    const itemSchema = schema.items as SchemaNode
    instance.forEach((item, idx) => errors.push(...validateSchema(item, itemSchema, `${path}[${idx}]`)))
  }

  return errors
}

// ── schema 常量（老 loops.schema.json 移植 + 本轮 autonomy_level）───────────────

/**
 * H10 §1：`skill_bundle_id` 词法值域——`_all`（manifest 技能表兜底键）或小写字母开头、仅 a-z0-9_-、
 * 总长 ≤32 的 profile id（与工作流分支 id 同一词法，所以 profile 可以直接取分支 id）。下划线开头只放行
 * `_all` 这一个字面量。这里只钉词法：非空值是否形如合法 id。是否是 manifest 里
 * 真实声明过的 profile 是存在性语义校验，不在本函数职责内——本层（loops.yaml 词法/schema 校验）
 * 不持有 manifest 上下文，做不到这一步；那项校验发生在 admission 装配层
 * （packages/automation/src/admission/loop-admission.ts::LoopAdmissionDeps.isSkillProfileKnown，
 * 由 reserveOnce 对具名 profile 调用）。
 */
export const SKILL_BUNDLE_ID_RE = /^_all$|^[a-z][a-z0-9_-]{0,31}$/

/** H11 持久化引用 token：小写字母起始、kebab 段非空；只钉路径安全词法，不校验引用存在性。 */
const SAFE_KEBAB_TOKEN_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export const LOOPS_SCHEMA: SchemaNode = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'loops'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    loops: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: [
          'id', 'name', 'kind', 'goal', 'cadence', 'risk', 'runner',
          'change_prefix', 'phases', 'human_gates', 'design_doc',
          'status', 'budget', 'kill_criteria',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
          name: { type: 'string', minLength: 3 },
          kind: { type: 'string', enum: ['orchestrator', 'executor'] },
          goal: { type: 'string', minLength: 10 },
          cadence: { type: 'string', pattern: '^([0-9]+[mhd](-[0-9]+[mhd])?|continuous)$' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          runner: { type: 'string', minLength: 2 },
          change_prefix: { type: ['string', 'null'] },
          phases: { type: 'array', minItems: 2, items: { type: 'string' } },
          human_gates: { type: 'array', minItems: 1, items: { type: 'string' } },
          // H9 legacy import only. New writers omit this field; iteration state is projected from ledger facts.
          state: { type: 'string', minLength: 2 },
          design_doc: { type: 'string', minLength: 2 },
          status: { type: 'string', enum: ['active', 'paused', 'retired'] },
          budget: {
            type: 'object',
            required: ['max_runs_per_day', 'max_in_flight', 'on_exceed'],
            additionalProperties: false,
            properties: {
              max_runs_per_day: { type: 'integer', minimum: 1 },
              max_in_flight: { type: 'integer', minimum: 0 },
              on_exceed: { type: 'string', minLength: 2 },
              // #36 token 级预算（可选，向后兼容——旧登记表不含即无 token 预算/熔断）：
              max_tokens_per_day: { type: 'integer', minimum: 1 },
              tokens_per_run: { type: 'integer', minimum: 1 },
            },
          },
          kill_criteria: { type: 'array', minItems: 1, items: { type: 'string' } },
          // 本轮新增：分级放权级别（可选；缺省 L1 由 loadRegistry 派生填充）。
          autonomy_level: { type: 'string', enum: ['L1', 'L2', 'L3'] },
          // v5 决议 #12：路径 glob 白/黑名单（可选，缺省 [] 由 loadRegistry 派生填充；
          // denylist 运行时消费见 automation/lifecycle/denylist.ts）。
          allowlist: { type: 'array', items: { type: 'string' } },
          denylist: { type: 'array', items: { type: 'string' } },
          // H11 starter provenance/binding（均可选，旧登记表保持兼容；template catalog 存在性不在本层）。
          template_id: { type: 'string', minLength: 1, pattern: SAFE_KEBAB_TOKEN_RE.source },
          template_version: { const: 1 },
          workflow_id: { type: 'string', minLength: 1, pattern: SAFE_KEBAB_TOKEN_RE.source },
          // H10 §1：skill bundle 引用（可选；缺席/null 由 loadRegistry 派生归一化为 null=unwired）。
          // 非空须过 SKILL_BUNDLE_ID_RE 词法；profile 是否被 manifest 真声明是存在性语义校验，不在此 schema。
          skill_bundle_id: { type: ['string', 'null'], pattern: SKILL_BUNDLE_ID_RE.source },
        },
      },
    },
  },
}

// ── 载入契约（老 load_registry 149-177）────────────────────────────────────────

/** fs 读注入面（默认 node fs；测试注入内存 io）。readText：缺失/不可读 → null。 */
export interface LoopIo {
  readText: (absPath: string) => string | null
}

/**
 * loops.yaml 读 I/O 故障（ENOENT 之外的 EACCES/EIO/EISDIR…）——绝不当成「无 registry」denial（Stage B 返工 #2）。
 * `_tag` 供 scheduler.classifyRoundFailure 归 kind=registry-io（admission reserve 的 registry I/O 故障 =
 * round failure 使 ok=false，而非静默 skip-run denial）。governance.readRegistrySnapshot 亦复用本类型。
 */
export class RegistryReadError extends Error {
  readonly _tag = 'RegistryReadError'
  constructor(message: string) { super(message); this.name = 'RegistryReadError' }
}

export const nodeLoopIo: LoopIo = {
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
}

/**
 * 严格 fs 读注入面（admission reserve 用）：**只** ENOENT→null（合法「无 registry」），其它 I/O 错误
 * （EACCES/EIO/EISDIR…）throw RegistryReadError——绝不把真实 I/O 故障吞成「文件不存在」。搭配 loadRegistry
 * 使用（`loadRegistry(root, nodeLoopIoStrict)`）：ENOENT→{data:null,errors:[]}；其它 I/O→throw（调用方 fail-loud）。
 * 展示读面（list/status/budget/graduation/server 快照）继续用宽容的 nodeLoopIo（不可读→null，不崩显示）。
 */
export const nodeLoopIoStrict: LoopIo = {
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new RegistryReadError(`loops.yaml 读失败（${(e as NodeJS.ErrnoException).code ?? 'IO'}）：${e instanceof Error ? e.message : String(e)}`)
    }
  },
}

const LOOPS_REL_PATH = ['.pipeline', 'loops.yaml']

/** 派生：schema 校验已过的原始数据 → 带默认的 LoopRegistry（autonomy_level 缺省填 L1；
 * allowlist/denylist 缺省填 []，决议 #12 存储侧；H10 §1：skill_bundle_id 缺省/null 归一化填 null，
 * 语义是 unwired，不是空 bundle）。 */
function deriveRegistry(data: Record<string, unknown>): LoopRegistry {
  const errors = validateSchema(data, LOOPS_SCHEMA)
  if (!isValidatedLoopRegistry(data, errors)) {
    throw new Error(`validated loop registry expected: ${errors.join('; ')}`)
  }
  const loops = data.loops.map((loop) => ({
    ...loop,
    autonomy_level: loop.autonomy_level ?? 'L1',
    allowlist: loop.allowlist ?? [],
    denylist: loop.denylist ?? [],
    skill_bundle_id: loop.skill_bundle_id ?? null,
  }))
  return { version: 1, loops }
}

function isValidatedLoopRegistry(
  value: unknown,
  errors: readonly string[],
): value is { readonly version: 1; readonly loops: readonly LoopEntry[] } {
  return errors.length === 0
}

/**
 * 载入 `<repoRoot>/.pipeline/loops.yaml`（老 load_registry 契约）：
 *   文件不存在 → {data:null, errors:[]}；解析失败 / 顶层非 mapping / schema 校验失败 → {data:null, errors:[...]}；
 *   合法 → {data:<带默认>, errors:[]}。
 */
export function loadRegistry(repoRoot: string, io: LoopIo = nodeLoopIo): { data: LoopRegistry | null; errors: string[] } {
  const text = io.readText(join(repoRoot, ...LOOPS_REL_PATH))
  if (text === null) return { data: null, errors: [] }

  const { data, error } = parseLoopsYaml(text)
  if (error !== null) return { data: null, errors: [`loops.yaml: ${error}`] }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { data: null, errors: ['<root>: loops.yaml 顶层必须是 mapping（对象）'] }
  }

  const errors = validateSchema(data, LOOPS_SCHEMA)
  if (errors.length > 0) return { data: null, errors }

  return { data: deriveRegistry(data as Record<string, unknown>), errors: [] }
}
