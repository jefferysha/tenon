/**
 * 立项前置条件的落地实现：CLI 与 server 的两个创建入口共用这一个函数，拒绝原因只在这里决定。
 *
 * 只有当所选分支的第一个步骤真的声明了 `design-md` 的 require 槽位时才读资源目录（图标 id 集合），
 * 其余立项一次盘都不多读。
 */
import { DESIGN_MD_PATH, DESIGN_MODEL_PATH, checkDesignSystem } from '../design-system/check.js'
import { assertCreationPreconditions, ProjectDocumentPreconditionError } from '../design-system/precondition.js'
import type { DocumentGovernancePolicy } from '../workflow/document-contract-model.js'
import { createDesignFileReader } from './design-system-fs.js'
import { loadResourceCatalog } from './resource-store.js'

const HINT = '先完成设计体系任务：tenon init <name> --workflow design-system --track free --preset <preset>'

export interface DesignPreconditionInput {
  readonly repoRoot: string
  readonly payloadRoot: string
  readonly configRoot: string
  readonly workflow: string
  readonly track: string
  readonly firstStep: string
  readonly policy?: DocumentGovernancePolicy
}

/** 返回拒绝原因；null = 没有该前置条件，或文档已就绪。 */
export async function designSystemPrecondition(input: DesignPreconditionInput): Promise<string | null> {
  const required = input.policy?.requiresByStep?.[input.firstStep] ?? []
  if (!required.includes('design-md')) return null
  const catalog = await loadResourceCatalog({ payloadRoot: input.payloadRoot, configRoot: input.configRoot })
  const icons = new Set(catalog.resources.filter((item) => item.entry.category === 'icons').map((item) => item.entry.id))
  const reader = createDesignFileReader(input.repoRoot)
  try {
    assertCreationPreconditions(input, [{
      kind: 'design-md',
      paths: [DESIGN_MD_PATH, DESIGN_MODEL_PATH],
      readiness: () => checkDesignSystem(reader, icons),
      hint: HINT,
    }])
    return null
  } catch (error) {
    if (error instanceof ProjectDocumentPreconditionError) return error.message
    throw error
  }
}
