/**
 * M1 全栈 Spec 覆盖矩阵（pipeline-guard-lib.sh:112-160 逐字对齐）——spec 出口的覆盖 gate。
 *
 * 从 guard.ts 拆出：那边是相位出口规则表的求值器与字段投影，这边是一张与规则表无关的领域矩阵
 * （profile × 层 → 适用性、🔒 锁概念、design_doc 里 ```coverage 围栏块的解析）。求值需要的两个
 * 标量（preset / design_doc）由调用方读出后传入，本模块因此不 import guard.ts，物理上无环。
 */
import type { GuardContext } from '../types.js'

export interface CoverageInput {
  readonly ctx: GuardContext
  /** state.fields.preset 的标量值（hotfix / tweak 把 required-blank 降级为 WARN）。 */
  readonly preset: string
  /** state.fields.design_doc 的标量值；空或 "null" 视同没有覆盖块。 */
  readonly designDoc: string
}

// ===== M1 全栈 Spec 覆盖矩阵（pipeline-guard-lib.sh:112-160 逐字对齐）=====

const COVERAGE_LAYERS = [
  'L1_api', 'L2_data', 'L3_rules', 'L4_state', 'L5_errors',
  'L6_security', 'L7_perf', 'L8_deps', 'L10_terms',
] as const

type Applicability = 'required' | 'optional' | 'na'

/** 每 coverage profile 每层适用性（lib:119-141）；表外层 = na；none 在入口直接跳过。 */
const COVERAGE_PROFILE_APPLICABILITY: Readonly<Record<string, Readonly<Record<string, Applicability>>>> = {
  backend: {
    L1_api: 'required', L2_data: 'required', L3_rules: 'required', L4_state: 'required',
    L5_errors: 'required', L6_security: 'required', L8_deps: 'required',
    L7_perf: 'optional', L10_terms: 'optional',
  },
  frontend: {
    L4_state: 'required', L5_errors: 'required',
    L1_api: 'optional', L3_rules: 'optional', L6_security: 'optional',
    L7_perf: 'optional', L8_deps: 'optional', L10_terms: 'optional',
  },
  pm: {
    L3_rules: 'required',
    L2_data: 'optional', L4_state: 'optional', L10_terms: 'optional',
  },
}

/** 🔒 概念→层（lib:144：默认仅 auth→L6_security） */
const COVERAGE_LOCK_CONCERN: Readonly<Record<string, string>> = { L6_security: 'auth' }

/** design_doc 的 ```coverage 围栏块内容行（lib awk '/^```coverage/{f=1;next} /^```/{f=0} f'） */
function coverageBlockLines(content: string | undefined): string[] {
  if (content === undefined) return []
  const out: string[] = []
  let inBlock = false
  for (const line of content.split('\n')) {
    if (/^```coverage/.test(line)) { inBlock = true; continue }
    if (/^```/.test(line)) { inBlock = false; continue }
    if (inBlock) out.push(line)
  }
  return out
}

/** 层状态（lib:147-155）：filled|waived 之外（含缺行/坏值）一律 blank */
function coverageBlockStatus(lines: readonly string[], layer: string): 'filled' | 'waived' | 'blank' {
  const row = lines.find((l) => l.startsWith(`${layer}:`))
  if (row === undefined) return 'blank'
  const m = /^[ \t]*([a-zA-Z]+)/.exec(row.slice(layer.length + 1))
  const st = m?.[1]
  return st === 'filled' || st === 'waived' ? st : 'blank'
}

/** touches 受保护域（lib:157-160 + guard.sh:450 tr ',' ' ' 词切） */
function coverageTouches(lines: readonly string[]): string[] {
  const row = lines.find((l) => l.startsWith('touches:'))
  if (row === undefined) return []
  return row.slice('touches:'.length).split(/[,\s]+/).filter((w) => w !== '')
}

/** M1 覆盖 gate（guard.sh:436-477 emit_coverage_status + 510-528 spec 显式步） */
export function evaluateCoverage(
  input: CoverageInput,
  failures: string[],
  warnings: string[],
): void {
  const { ctx, preset, designDoc } = input
  if (ctx.readFile === undefined || ctx.coverageProfile === 'none') return
  const content = designDoc !== '' && designDoc !== 'null' ? ctx.readFile(designDoc) : undefined
  const lines = coverageBlockLines(content)
  const touches = coverageTouches(lines)
  const applicability = COVERAGE_PROFILE_APPLICABILITY[ctx.coverageProfile]

  // emit 行格式照老仓：`$layer $app $status $verdict$tag`（na 层 skip，连锁也不查——guard.sh:459）
  const blockedLines: string[] = []
  let lockViolations = 0
  for (const layer of COVERAGE_LAYERS) {
    const app = applicability?.[layer] ?? 'na'
    if (app === 'na') continue
    const status = coverageBlockStatus(lines, layer)
    const concern = COVERAGE_LOCK_CONCERN[layer]
    const locked = concern !== undefined && touches.includes(concern)
    if (locked) {
      // 🔒 锁层必须 filled，waive/blank 都违反（guard.sh:467-469）
      if (status !== 'filled') {
        blockedLines.push(`${layer} ${app} ${status} BLOCKED LOCKVIOLATION`)
        lockViolations += 1
      }
    } else if (app === 'required' && status === 'blank') {
      blockedLines.push(`${layer} ${app} ${status} BLOCKED`)
    }
  }

  // hotfix/tweak：required-blank 降级 WARN，仅 🔒 锁违反计入阻塞（guard.sh:512-524）
  const waive = preset === 'hotfix' || preset === 'tweak'
  const covBlock = waive ? lockViolations : blockedLines.length
  if (waive) {
    const warnBlank = blockedLines.length - lockViolations
    if (warnBlank > 0) {
      warnings.push(`${preset}：${warnBlank} 层覆盖留空（已豁免，建议补；🔒 锁不豁免）`)
    }
  }
  if (covBlock > 0) {
    // 怎么解开写在失败行里：这条指引原先散在阶段 skill 的散文中，现在只剩这一处。
    failures.push(
      `spec 出口：全栈 Spec 覆盖（${covBlock} 层阻塞）；`
      + '在 design_doc 的 ```coverage 块为每个阻塞层写 filled -> <章节> 或 waived -> <理由>'
      + '（touches 含 auth 时 L6 不可 waived）',
    )
    for (const l of blockedLines) warnings.push(`覆盖阻塞: ${l}`)
  }
}
