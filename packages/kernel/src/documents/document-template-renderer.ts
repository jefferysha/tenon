import {
  DOCUMENT_LOCALES,
  DOCUMENT_LOCALE_CATALOGS,
  DOCUMENT_PRESENTATION_REGISTRY,
  DOCUMENT_TEMPLATE_IDS,
  DOCUMENT_WORKFLOW_STEP_IDS,
  DOCUMENT_WORKFLOW_STEP_LABELS,
  type DocumentLocale,
  type DocumentTemplateId,
} from './document-presentation-registry.js'

export {
  DOCUMENT_TEMPLATE_IDS,
  DOCUMENT_WORKFLOW_STEP_IDS,
  DOCUMENT_WORKFLOW_STEP_LABELS,
} from './document-presentation-registry.js'
export const DEFAULT_DOCUMENT_LOCALE: DocumentLocale = 'zh-CN'

/**
 * 骨架里「这里还没写」的记号，渲染与判定共用这一份（document-placeholders.ts 据它拒绝登记
 * 仍含占位符的文档）。改记号只改这里，判定随之改变，不会出现骨架换了词而登记闸认不出来。
 */
export const DOCUMENT_PENDING_WORD: Readonly<Record<DocumentLocale, string>> = {
  'zh-CN': '待填写',
  en: 'Pending',
}
export const DOCUMENT_PROMPT_TAG: Readonly<Record<DocumentLocale, string>> = {
  'zh-CN': '[待填写]',
  en: '[pending]',
}

export interface WorkflowStepPresentation {
  readonly id: string
  readonly label?: string
}

export interface DocumentTemplateVariables {
  readonly change: string
  readonly workflowStepLabelSource?: 'localized-builtin' | 'workflow-defined'
  readonly workflowSteps?: readonly WorkflowStepPresentation[]
  readonly designDoc?: string
}

export interface DocumentPathVariables {
  readonly change: string
  readonly capability?: string
}

function isLocale(value: string): value is DocumentLocale {
  return (DOCUMENT_LOCALES as readonly string[]).includes(value)
}

function section(catalog: Readonly<Record<string, string>>, key: string): string {
  const value = catalog[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Document Presentation Registry 缺少 section '${key}'`)
  }
  return value
}

export function validateDocumentPresentationRegistry(): void {
  const templateIds = Object.keys(DOCUMENT_PRESENTATION_REGISTRY.templates).sort()
  const expected = [...DOCUMENT_TEMPLATE_IDS].sort()
  if (JSON.stringify(templateIds) !== JSON.stringify(expected)) {
    throw new Error('Document Presentation Registry template id 不完整')
  }
  const baseline = DOCUMENT_LOCALE_CATALOGS[DEFAULT_DOCUMENT_LOCALE]
  for (const locale of DOCUMENT_LOCALES) {
    const workflowLabels: Readonly<Record<string, string>> = DOCUMENT_WORKFLOW_STEP_LABELS[locale]
    const observedWorkflowSteps = Object.keys(workflowLabels).sort()
    const expectedWorkflowSteps = [...DOCUMENT_WORKFLOW_STEP_IDS].sort()
    if (JSON.stringify(observedWorkflowSteps) !== JSON.stringify(expectedWorkflowSteps)) {
      throw new Error(`locale '${locale}' workflow step label 与 Registry 不等价`)
    }
    const catalog = DOCUMENT_LOCALE_CATALOGS[locale]
    for (const templateId of DOCUMENT_TEMPLATE_IDS) {
      const expectedKeys = [...DOCUMENT_PRESENTATION_REGISTRY.templates[templateId].sections].sort()
      const baselineKeys = Object.keys(baseline[templateId]).sort()
      if (JSON.stringify(baselineKeys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`registry template '${templateId}' sections 与默认 catalog 不等价`)
      }
      const observedKeys = Object.keys(catalog[templateId]).sort()
      if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`locale '${locale}' template '${templateId}' section key 不等价`)
      }
    }
  }
}

export function documentTemplateIdForKind(kind: string): DocumentTemplateId {
  const templateId = DOCUMENT_TEMPLATE_IDS.find(
    (candidate) => DOCUMENT_PRESENTATION_REGISTRY.templates[candidate].kind === kind,
  )
  if (templateId === undefined) throw new Error(`未知 document kind '${kind}'`)
  return templateId
}

/** 该 kind 的路径模板，占位符原样保留（如 delta-spec 的 `{capability}`）。 */
export function documentPathTemplateForKind(kind: string): string {
  return DOCUMENT_PRESENTATION_REGISTRY.templates[documentTemplateIdForKind(kind)].path
}

/**
 * 渲染路径；缺变量时返回缺的那个变量名而不是抛。
 *
 * 有些 kind 的路径要到作者拍板后才存在——delta-spec 的 `{capability}` 是人选的，`tenon document
 * scaffold` 要求 `--capability`，没有默认值。投影面（`tenon status --json` 的 step 分块）必须能
 * 如实说「这一条还定不下来」，而不是抛异常把整块投影一起带走（那会让数据驱动的执行者在 spec
 * 相位一无所得）。要求路径必须落定的调用方继续用 documentPathForKind，它照旧 fail-loud。
 */
export function renderDocumentPathForKind(
  kind: string,
  variables: DocumentPathVariables,
): { readonly path: string } | { readonly missing: string } {
  const definition = DOCUMENT_PRESENTATION_REGISTRY.templates[documentTemplateIdForKind(kind)]
  const values: Readonly<Record<string, string | undefined>> = {
    change: variables.change,
    capability: variables.capability,
  }
  let missing: string | undefined
  const output = definition.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key: string) => {
    const value = values[key]
    if (value === undefined || value === '') {
      missing ??= key
      return token
    }
    return value
  })
  if (missing !== undefined) return { missing }
  if (/[{}]/.test(output)) throw new Error(`document kind '${kind}' 路径含未解析占位符`)
  return { path: output }
}

export function documentPathForKind(kind: string, variables: DocumentPathVariables): string {
  const rendered = renderDocumentPathForKind(kind, variables)
  if ('missing' in rendered) throw new Error(`document kind '${kind}' 路径缺少 '${rendered.missing}'`)
  return rendered.path
}

function workflowStepLabel(
  step: WorkflowStepPresentation,
  locale: DocumentLocale,
  stepLabelSource: DocumentTemplateVariables['workflowStepLabelSource'],
): string {
  const explicit = step.label?.trim()
  if (stepLabelSource === 'workflow-defined') return explicit || step.id
  const labels: Readonly<Record<string, string>> = DOCUMENT_WORKFLOW_STEP_LABELS[locale]
  return labels[step.id] ?? explicit ?? step.id
}

function renderLayoutInstruction(
  instruction: string,
  catalog: Readonly<Record<string, string>>,
  locale: DocumentLocale,
  variables: DocumentTemplateVariables,
): readonly string[] {
  const pending = DOCUMENT_PENDING_WORD[locale]
  if (instruction === 'frontmatter') {
    return [
      '---',
      `change: ${variables.change}`,
      ...(variables.designDoc ? [`design-doc: ${variables.designDoc}`] : []),
      `locale: ${locale}`,
      '---',
    ]
  }
  if (instruction === 'task-pending') return [`- [ ] ${pending}`]
  if (instruction === 'scenario-pending') {
    return [`- **WHEN** ${pending}`, `- **THEN** ${pending}`]
  }

  const separator = instruction.indexOf(':')
  if (separator === -1) {
    throw new Error(`Document Presentation Registry layout 指令无效: '${instruction}'`)
  }
  const operation = instruction.slice(0, separator)
  const key = instruction.slice(separator + 1)
  const value = section(catalog, key)
  if (operation === 'workflow-steps') {
    const steps = variables.workflowSteps
      ?? DOCUMENT_WORKFLOW_STEP_IDS.map((id) => ({ id }))
    return steps.flatMap((step, index) => [
      `## ${workflowStepLabel(step, locale, variables.workflowStepLabelSource)}`,
      '',
      `- [ ] ${index === 0 ? value : `${value} (${step.id})`}`,
      ...(index === steps.length - 1 ? [] : ['']),
    ])
  }
  const heading = /^h([1-4])(-pending)?$/u.exec(operation)
  if (heading) {
    const level = Number(heading[1])
    return [`${'#'.repeat(level)} ${value}${heading[2] ? `: ${pending}` : ''}`]
  }
  if (operation === 'quote') return [`> ${value}`]
  if (operation === 'text') return [value]
  if (operation === 'prompt-placeholder') {
    return [`> ${DOCUMENT_PROMPT_TAG[locale]} ${value}`]
  }
  throw new Error(`Document Presentation Registry layout operation 未知: '${operation}'`)
}

export function renderDocumentTemplate(
  templateId: DocumentTemplateId,
  locale: DocumentLocale,
  variables: DocumentTemplateVariables,
): string {
  if (!(DOCUMENT_TEMPLATE_IDS as readonly string[]).includes(templateId)) {
    throw new Error(`未知 document template '${templateId}'`)
  }
  if (!isLocale(locale)) throw new Error(`不支持 document locale '${locale}'`)
  const catalog = DOCUMENT_LOCALE_CATALOGS[locale][templateId]
  const layout = DOCUMENT_PRESENTATION_REGISTRY.templates[templateId].layout
  const output = layout.flatMap((instruction) => [
    ...renderLayoutInstruction(instruction, catalog, locale, variables),
    '',
  ]).join('\n')
  return output.endsWith('\n') ? output : `${output}\n`
}
