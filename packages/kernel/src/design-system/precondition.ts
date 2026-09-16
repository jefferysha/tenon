/**
 * 立项前置条件：轨道的第一个步骤声明了某个项目级文档 `role: require` 时，该文档必须先就绪。
 *
 * 数据驱动——条件写在工作流 YAML 的 document_contract 里，不在代码里枚举轨道名。default 的前端轨道
 * 因此要求项目 DESIGN.md 就绪；产品轨道可以把 design-md 放在 build 步骤自己产出，那就不拦立项。
 */
import type { DocumentGovernancePolicy, DocumentKind } from '../workflow/document-contract-model.js'
import type { DesignSystemCheck, DesignSystemStatus } from './check.js'

export interface ProjectDocumentKindSpec {
  readonly kind: DocumentKind
  /** 该文档在项目里的固定路径（用于提示，不参与判断）。 */
  readonly paths: readonly string[]
  readiness(root: string): DesignSystemCheck
  /** 未就绪时的引导命令模板；`<name>` 由调用方替换。 */
  readonly hint: string
}

export class ProjectDocumentPreconditionError extends Error {
  readonly kind: DocumentKind
  readonly status: DesignSystemStatus
  readonly problems: readonly string[]
  constructor(message: string, kind: DocumentKind, status: DesignSystemStatus, problems: readonly string[]) {
    super(message)
    this.name = 'ProjectDocumentPreconditionError'
    this.kind = kind
    this.status = status
    this.problems = problems
  }
}

const STATUS_WORD: Record<DesignSystemStatus, string> = {
  missing: '缺失', seed: '起步', incomplete: '不完整', ready: '就绪',
}

export interface CreationPreconditionInput {
  readonly workflow: string
  readonly track: string
  readonly firstStep: string
  readonly policy?: DocumentGovernancePolicy
  readonly repoRoot: string
}

/** 只看第一个步骤的 require 槽位；其它步骤的 require 由步骤自己的读取校验负责。 */
export function assertCreationPreconditions(
  input: CreationPreconditionInput,
  specs: readonly ProjectDocumentKindSpec[],
): void {
  const required = input.policy?.requiresByStep?.[input.firstStep] ?? []
  for (const spec of specs) {
    if (!required.includes(spec.kind)) continue
    const check = spec.readiness(input.repoRoot)
    if (check.status === 'ready') continue
    const head = `工作流 ${input.workflow} 轨道 ${input.track} 要求项目 ${spec.paths[0] ?? spec.kind} 就绪（当前：${STATUS_WORD[check.status]}）；${spec.hint}`
    const detail = check.problems.slice(0, 5).map((problem) => `\n- ${problem}`).join('')
    throw new ProjectDocumentPreconditionError(`${head}${detail}`, spec.kind, check.status, check.problems)
  }
}
