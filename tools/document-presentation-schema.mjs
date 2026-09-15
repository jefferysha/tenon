import Ajv2020 from 'ajv/dist/2020.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Project-scope document kinds and their fixed repository paths (mirrors kernel DOCUMENT_KIND_CATALOG). */
const PROJECT_DOCUMENT_PATHS = { 'design-md': 'DESIGN.md' }

export async function validateDocumentPresentationAssets(root, registry, catalogs) {
  const schema = JSON.parse(await readFile(
    resolve(root, 'templates/documents/schemas/registry.v1.schema.json'),
    'utf8',
  ))
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const validate = ajv.compile(schema)
  const errors = []
  if (!validate(registry)) {
    for (const error of validate.errors ?? []) {
      errors.push(`registry schema ${error.instancePath || '/'} ${error.message ?? '校验失败'}`)
    }
  }

  const templateIds = registry.templates.map((template) => template.id)
  const documentKinds = registry.templates.map((template) => template.kind)
  if (registry.default_locale !== 'zh-CN') errors.push('default_locale 必须是 zh-CN')
  if (JSON.stringify(registry.locales) !== JSON.stringify(['zh-CN', 'en'])) {
    errors.push('locale 必须且只能按 zh-CN、en 顺序声明')
  }
  if (new Set(templateIds).size !== templateIds.length) errors.push('template id 重复')
  if (new Set(documentKinds).size !== documentKinds.length) errors.push('document kind 重复')
  for (const definition of registry.templates) {
    const placeholders = [...definition.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
    const projectPath = Object.hasOwn(PROJECT_DOCUMENT_PATHS, definition.kind)
      ? PROJECT_DOCUMENT_PATHS[definition.kind]
      : undefined
    if (projectPath !== undefined && definition.path !== projectPath) {
      errors.push(`${definition.id}: 项目文档 path 必须是 ${projectPath}`)
    }
    if (projectPath === undefined && !placeholders.includes('change')) {
      errors.push(`${definition.id}: path 必须包含 {change}`)
    }
    const allowed = definition.kind === 'delta-spec' ? ['capability', 'change'] : ['change']
    if (placeholders.some((placeholder) => !allowed.includes(placeholder))) {
      errors.push(`${definition.id}: path 含未声明占位符`)
    }
    if (definition.kind === 'delta-spec' && !placeholders.includes('capability')) {
      errors.push(`${definition.id}: delta-spec path 必须包含 {capability}`)
    }
    if (definition.path.split('/').includes('..') || definition.path.startsWith('/')) {
      errors.push(`${definition.id}: path 必须是项目内相对路径`)
    }
    const sectionKeys = new Set(definition.sections)
    for (const instruction of definition.layout ?? []) {
      const separator = instruction.indexOf(':')
      if (separator === -1) continue
      const sectionKey = instruction.slice(separator + 1)
      if (!sectionKeys.has(sectionKey)) {
        errors.push(`${definition.id}: layout 引用未声明 section '${sectionKey}'`)
      }
    }
  }

  for (const catalog of catalogs) {
    if (catalog.locale === undefined || !registry.locales.includes(catalog.locale)) {
      errors.push(`catalog locale 非法: ${String(catalog.locale)}`)
      continue
    }
    const workflowStepKeys = Object.keys(catalog.workflow_steps ?? {}).sort()
    if (JSON.stringify(workflowStepKeys) !== JSON.stringify([...registry.workflow_steps].sort())) {
      errors.push(`${catalog.locale}: workflow step label 与 registry 不等价`)
    }
    for (const step of registry.workflow_steps) {
      const label = catalog.workflow_steps?.[step]
      if (typeof label !== 'string' || label.trim() === '') {
        errors.push(`${catalog.locale}/workflow_steps/${step}: label 必须是非空字符串`)
      }
    }
    const observed = Object.keys(catalog.templates ?? {}).sort()
    if (JSON.stringify(observed) !== JSON.stringify([...templateIds].sort())) {
      errors.push(`${catalog.locale}: template id 与 registry 不等价`)
    }
    for (const definition of registry.templates) {
      const presentation = catalog.templates?.[definition.id]
      if (presentation === undefined || presentation === null || Array.isArray(presentation)) {
        errors.push(`${catalog.locale}/${definition.id}: 缺少 presentation`)
        continue
      }
      const expectedKeys = [...definition.sections].sort()
      const observedKeys = Object.keys(presentation).sort()
      if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
        errors.push(
          `${catalog.locale}/${definition.id}: registry sections 与 catalog keys 不等价`
          + `（expected=${expectedKeys.join(',')}; observed=${observedKeys.join(',')}）`,
        )
      }
      for (const key of definition.sections) {
        const value = presentation[key]
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push(`${catalog.locale}/${definition.id}/${key}: presentation 必须是非空字符串`)
        }
      }
    }
  }
  return errors
}
