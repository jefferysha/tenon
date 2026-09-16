import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyInstructions, deleteInstructionTarget, previewInstructionApply, readInstructionTargets, type InstructionScope,
} from './instructionFiles.js'
import { captureWorkflowRootAnchor, closeWorkflowRootAnchor, type WorkflowRootAnchor } from './workflowRootAnchor.js'

const CODEX_BLOCK = readFileSync(fileURLToPath(new URL('../../../templates/generated/codex-agents-block.md', import.meta.url)), 'utf8')
const dirs: string[] = []
const anchors: WorkflowRootAnchor[] = []

afterEach(async () => {
  for (const anchor of anchors.splice(0)) closeWorkflowRootAnchor(anchor)
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `tenon-instruction-files-${label}-`))
  dirs.push(dir)
  return dir
}

async function project(): Promise<{ root: string; scope: InstructionScope }> {
  const root = await tempDir('project')
  const anchor = captureWorkflowRootAnchor(root)
  anchors.push(anchor)
  return { root, scope: { level: 'project', anchor } }
}

type Body = Record<string, unknown>
const bodyOf = (result: { body: unknown }) => result.body as Body
const targetsOf = (result: { body: unknown }) =>
  bodyOf(result).targets as { id: string; exists: boolean; digest: string; text: string; managed: { tag: string }[]; error: string | null }[]

describe('project instruction files', () => {
  it('GET 列出三个项目文件：摘要、受管块、去掉受管块后的正文；Zed 显示生效文件', async () => {
    const { root, scope } = await project()
    await writeFile(join(root, 'AGENTS.md'), `# 规则\n\n- 一\n\n${CODEX_BLOCK}`)
    const result = readInstructionTargets(scope)
    const targets = targetsOf(result)
    expect(targets.map((target) => target.id)).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'])
    expect(targets[0]).toMatchObject({ exists: true, text: '# 规则\n\n- 一\n', managed: [{ tag: 'CODEX' }], error: null })
    expect(targets[0]?.digest).toMatch(/^sha256:/)
    expect(targets[1]).toMatchObject({ exists: false, digest: 'absent', managed: [] })
    const hosts = bodyOf(result).hosts as { id: string; levels: string; target: string | null; effective_file?: string }[]
    expect(hosts.find((host) => host.id === 'zed')).toMatchObject({ levels: 'project-wins', effective_file: 'AGENTS.md' })
    expect(hosts.find((host) => host.id === 'aider')?.target).toBeNull()
  })

  it('预览：AGENTS.md 的 next 以 Codex 受管块结尾；正文含标记行 400', async () => {
    const { root, scope } = await project()
    await writeFile(join(root, 'AGENTS.md'), `旧正文\n\n${CODEX_BLOCK}`)
    const preview = previewInstructionApply(scope, '# 新规则\n', ['CLAUDE.md', 'AGENTS.md'])
    expect(preview.status).toBe(200)
    const files = bodyOf(preview).files as { id: string; current: string | null; next: string; base_digest: string }[]
    expect(files[0]).toMatchObject({ id: 'CLAUDE.md', current: null, next: '# 新规则\n', base_digest: 'absent' })
    expect(files[1]?.next.endsWith(CODEX_BLOCK)).toBe(true)
    expect(files[1]?.next.startsWith('# 新规则\n\n<!-- PIPELINE:CODEX:START -->')).toBe(true)
    expect(previewInstructionApply(scope, 'x\n<!-- PIPELINE:CODEX:START -->\n', ['CLAUDE.md']).status).toBe(400)
  })

  it('应用 CLAUDE.md + AGENTS.md：两份正文一致，AGENTS.md 保留受管块', async () => {
    const { root, scope } = await project()
    await writeFile(join(root, 'AGENTS.md'), `旧\n\n${CODEX_BLOCK}`)
    const agentsDigest = targetsOf(readInstructionTargets(scope))[0]?.digest ?? ''
    const applied = applyInstructions(scope, '# 共同规则\n\n- 必须测试\n', [
      { id: 'CLAUDE.md', base_digest: 'absent' }, { id: 'AGENTS.md', base_digest: agentsDigest },
    ])
    expect(applied.status).toBe(200)
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# 共同规则\n\n- 必须测试\n')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(`# 共同规则\n\n- 必须测试\n\n${CODEX_BLOCK}`)
    const after = targetsOf(readInstructionTargets(scope))
    expect(after[0]?.text).toBe(after[1]?.text)
  })

  it('预览后文件被外部修改：应用 409，所有文件都不写', async () => {
    const { root, scope } = await project()
    await writeFile(join(root, 'AGENTS.md'), '原文\n')
    const preview = bodyOf(previewInstructionApply(scope, '新\n', ['CLAUDE.md', 'AGENTS.md'])).files as { id: string; base_digest: string }[]
    await writeFile(join(root, 'AGENTS.md'), '别人改了\n')
    const applied = applyInstructions(scope, '新\n', preview.map((file) => ({ id: file.id, base_digest: file.base_digest })))
    expect(applied.status).toBe(409)
    expect(bodyOf(applied)).toMatchObject({ code: 'instruction-file-changed', id: 'AGENTS.md' })
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('别人改了\n')
  })

  it('符号链接目标与无效标记：409，文件不变', async () => {
    const { root, scope } = await project()
    const outside = join(await tempDir('outside'), 'secret.md')
    await writeFile(outside, '外部文件\n')
    await symlink(outside, join(root, 'CLAUDE.md'))
    await writeFile(join(root, 'AGENTS.md'), '<!-- PIPELINE:CODEX:START -->\n没有结束\n')
    const targets = targetsOf(readInstructionTargets(scope))
    expect(targets.find((target) => target.id === 'CLAUDE.md')?.error).toBe('target-symlink')
    expect(targets.find((target) => target.id === 'AGENTS.md')?.error).toBe('managed-block-invalid')
    expect(bodyOf(applyInstructions(scope, 'x\n', [{ id: 'CLAUDE.md', base_digest: 'absent' }]))).toMatchObject({ code: 'target-symlink' })
    expect(bodyOf(applyInstructions(scope, 'x\n', [{ id: 'AGENTS.md', base_digest: 'absent' }]))).toMatchObject({ code: 'managed-block-invalid' })
    expect(await readFile(outside, 'utf8')).toBe('外部文件\n')
  })

  it('删除：无受管块的文件被移除；有受管块只留块；摘要不符 409', async () => {
    const { root, scope } = await project()
    await writeFile(join(root, 'CLAUDE.md'), '规则\n')
    await writeFile(join(root, 'AGENTS.md'), `规则\n\n${CODEX_BLOCK}`)
    const [agents, claude] = targetsOf(readInstructionTargets(scope))
    expect(deleteInstructionTarget(scope, 'CLAUDE.md', 'sha256:0').status).toBe(409)
    expect(bodyOf(deleteInstructionTarget(scope, 'CLAUDE.md', claude?.digest ?? ''))).toMatchObject({ result: 'removed' })
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
    expect(bodyOf(deleteInstructionTarget(scope, 'AGENTS.md', agents?.digest ?? ''))).toMatchObject({ result: 'managed-kept' })
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(CODEX_BLOCK)
    expect(deleteInstructionTarget(scope, 'GEMINI.md', 'absent').status).toBe(404)
  })
})

describe('user instruction files', () => {
  it('用户级写入 <home>/.claude/CLAUDE.md 与 $CODEX_HOME/AGENTS.md，缺失的中间目录被创建', async () => {
    const home = await tempDir('home')
    const codexHome = join(await tempDir('codex'), 'codex-home')
    const scope: InstructionScope = { level: 'user', homeDir: home, env: { CODEX_HOME: codexHome }, platform: 'darwin' }
    const listed = targetsOf(readInstructionTargets(scope))
    expect(listed.map((target) => target.id)).toEqual(['claude', 'codex', 'gemini', 'zed', 'cline', 'amp', 'devin', 'pi'])
    const applied = applyInstructions(scope, '# 个人规则\n', [{ id: 'claude', base_digest: 'absent' }, { id: 'codex', base_digest: 'absent' }])
    expect(applied.status).toBe(200)
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# 个人规则\n')
    expect(await readFile(join(codexHome, 'AGENTS.md'), 'utf8')).toBe('# 个人规则\n')
    expect(previewInstructionApply(scope, 'x\n', ['copilot']).status).toBe(400)
  })

  it('~/.gemini 是符号链接：409 path-unsafe，链接目标不变', async () => {
    const home = await tempDir('home-link')
    const elsewhere = await tempDir('elsewhere')
    await symlink(elsewhere, join(home, '.gemini'))
    const scope: InstructionScope = { level: 'user', homeDir: home, env: {}, platform: 'darwin' }
    const applied = applyInstructions(scope, '# x\n', [{ id: 'gemini', base_digest: 'absent' }])
    expect(applied.status).toBe(409)
    expect(bodyOf(applied).code).toBe('path-unsafe')
    expect(existsSync(join(elsewhere, 'GEMINI.md'))).toBe(false)
    expect(targetsOf(readInstructionTargets(scope)).find((target) => target.id === 'gemini')?.error).toBe('path-unsafe')
  })

  it.skipIf(process.getuid?.() === 0)('只读目录：422 write-denied', async () => {
    const home = await tempDir('home-readonly')
    await mkdir(join(home, '.claude'))
    await chmod(join(home, '.claude'), 0o555)
    try {
      const scope: InstructionScope = { level: 'user', homeDir: home, env: {}, platform: 'darwin' }
      const applied = applyInstructions(scope, '# x\n', [{ id: 'claude', base_digest: 'absent' }])
      expect(applied.status).toBe(422)
      expect(bodyOf(applied).code).toBe('write-denied')
    } finally {
      await chmod(join(home, '.claude'), 0o755)
    }
  })
})
