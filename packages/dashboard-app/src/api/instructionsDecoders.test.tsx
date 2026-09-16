import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeComposeResult, decodeInstructionApply, decodeInstructionDelete, decodeInstructionPreview, decodeInstructionState,
  decodeProjectCreatePlan, decodeProjectCreated, decodeTemplateDocument, decodeTemplateList,
} from './instructionsDecoders'
import { InstructionApiError, saveTemplate } from './instructionsClient'

const summary = { source: 'builtin', category: 'backend', id: 'go', title: 'Go', frameworks: [], digest: 'sha256:1', errors: [] }
const list = { ok: true, sync: { id: 'instruction-templates', state: 'unchanged' }, templates: [summary] }
const block = { title: 'Go', frameworks: [], directory: 'backend/', directory_label: '后端', catalog: [], catalog_ref: null, variables: [{ key: 'app', default: 'app' }] }
const document = { ok: true, source: 'builtin', category: 'backend', id: 'go', text: '---\n', digest: 'sha256:1', block, errors: [] }
const target = { id: 'AGENTS.md', path: '/repo/AGENTS.md', exists: true, digest: 'sha256:2', text: '# x\n', managed: [{ tag: 'CODEX' }], bytes: 4, error: null }
const state = { ok: true, level: 'project', root: '/repo', hosts: [{ id: 'zed', levels: 'project-wins', target: 'AGENTS.md', effective_file: '.rules' }], targets: [target] }
const previewFile = { id: 'CLAUDE.md', path: '/repo/CLAUDE.md', base_digest: 'absent', current: null, next: '# x\n' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('instruction decoders accept exact server shapes', () => {
  it('模板列表、单个模板、拼合结果', () => {
    expect(decodeTemplateList(list)?.templates[0]?.id).toBe('go')
    expect(decodeTemplateList({ ...list, sync: { id: 'x', state: 'failed', detail: 'bad' } })?.sync).toEqual({ id: 'x', state: 'failed', detail: 'bad' })
    expect(decodeTemplateList({ ...list, sync: null })?.sync).toBeNull()
    expect(decodeTemplateDocument(document)?.block?.variables).toEqual([{ key: 'app', default: 'app' }])
    expect(decodeTemplateDocument({ ...document, block: null })?.block).toBeNull()
    expect(decodeComposeResult({ ok: true, markdown: '# p\n', directories: [{ path: 'sql/', label: '脚本' }], bytes: 4 })?.bytes).toBe(4)
  })

  it('指令文件读取、预览、应用、删除', () => {
    expect(decodeInstructionState(state)?.hosts[0]?.effective_file).toBe('.rules')
    expect(decodeInstructionState({ ...state, hosts: [{ id: 'aider', levels: 'needs-config', target: null }] })?.hosts[0]?.target).toBeNull()
    expect(decodeInstructionPreview({ ok: true, files: [previewFile] })).toEqual([previewFile])
    expect(decodeInstructionApply({ ok: true, files: [{ id: 'CLAUDE.md', digest: 'sha256:3' }] })).toEqual([{ id: 'CLAUDE.md', digest: 'sha256:3' }])
    expect(decodeInstructionDelete({ ok: true, result: 'managed-kept' })).toBe('managed-kept')
  })

  it('新建项目 dry run 与执行结果', () => {
    const plan = { ok: true, root: '/p/shop', git: 'init', registration: 'add', directories: [{ path: 'sql/', exists: false }], files: [previewFile] }
    expect(decodeProjectCreatePlan(plan)?.directories).toEqual([{ path: 'sql/', exists: false }])
    expect(decodeProjectCreated({ ok: true, root: '/p/shop', git: 'init', registration: 'add', directories: ['sql/'], files: [] })?.root).toBe('/p/shop')
  })
})

describe('instruction decoders reject extra keys, missing keys and wrong enums', () => {
  it.each([
    ['list extra key', () => decodeTemplateList({ ...list, extra: 1 })],
    ['list missing sync', () => decodeTemplateList({ ok: true, templates: [] })],
    ['summary wrong source', () => decodeTemplateList({ ...list, templates: [{ ...summary, source: 'shared' }] })],
    ['summary wrong category', () => decodeTemplateList({ ...list, templates: [{ ...summary, category: 'devops' }] })],
    ['sync wrong state', () => decodeTemplateList({ ...list, sync: { id: 'x', state: 'stale' } })],
    ['document missing digest', () => decodeTemplateDocument({ ...document, digest: undefined })],
    ['block extra key', () => decodeTemplateDocument({ ...document, block: { ...block, extra: true } })],
    ['state wrong level', () => decodeInstructionState({ ...state, level: 'team' })],
    ['host wrong levels', () => decodeInstructionState({ ...state, hosts: [{ id: 'x', levels: 'merged', target: null }] })],
    ['target wrong error', () => decodeInstructionState({ ...state, targets: [{ ...target, error: 'boom' }] })],
    ['target extra key', () => decodeInstructionState({ ...state, targets: [{ ...target, extra: 1 }] })],
    ['preview missing next', () => decodeInstructionPreview({ ok: true, files: [{ ...previewFile, next: undefined }] })],
    ['delete wrong result', () => decodeInstructionDelete({ ok: true, result: 'gone' })],
    ['plan wrong git', () => decodeProjectCreatePlan({ ok: true, root: '/p', git: 'clone', registration: 'add', directories: [], files: [] })],
    ['created wrong registration', () => decodeProjectCreated({ ok: true, root: '/p', git: 'none', registration: 'maybe', directories: [], files: [] })],
    ['ok false', () => decodeComposeResult({ ok: false, markdown: '', directories: [], bytes: 0 })],
  ])('%s', (_name, run) => {
    expect(run()).toBeNull()
  })
})

describe('instructions client errors keep server code, list and conflict digest', () => {
  it('409 template-changed carries the current digest', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, code: 'template-changed', error: '模板已被修改', digest: 'sha256:9' }),
    }))
    const error = await saveTemplate('backend', 'mine', 'x', 'absent').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(InstructionApiError)
    expect(error).toMatchObject({ status: 409, code: 'template-changed', digest: 'sha256:9' })
  })

  it('400 invalid carries the error list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, code: 'invalid', errors: ['1: 缺少 title'] }) }))
    const error = await saveTemplate('backend', 'mine', 'x', 'absent').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'invalid', errors: ['1: 缺少 title'] })
  })
})
