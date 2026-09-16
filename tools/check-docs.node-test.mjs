import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkRepository } from './check-docs.mjs'

const usageFiles = [
  'README.md',
  'installation.md',
  'quickstart.md',
  'routing-and-workflows.md',
  'default-workflow.md',
  'custom-workflows-and-tracks.md',
  'documents-skills-and-evidence.md',
  'dashboard-and-local-api.md',
  'automation-and-loops.md',
  'advanced-tools.md',
  'updates-recovery-and-uninstall.md',
  'troubleshooting.md',
  'security-model.md',
  'release-notes.md',
  'contributor-development.md',
  'cli-reference.md',
]

async function write(root, relativePath, content) {
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-check-docs-'))
  await write(root, 'package.json', JSON.stringify({ version: '1.0.2', engines: { node: '>=22' } }))
  await write(root, 'install.sh', 'TENON_RELEASE_VERSION="1.0.2"\n')
  const installUrl = 'https://raw.githubusercontent.com/jefferysha/tenon/v1.0.2/install.sh'
  const installCommand = `/usr/bin/curl -fsSL ${installUrl} | /bin/bash -s -- --codex`
  await write(root, 'packages/npm-bootstrap/README.md', `# Bootstrap\n\n${installCommand}\n`)
  await write(root, 'packages/server/src/port.ts', 'export const DEFAULT_DASHBOARD_PORT = 18765\n')
  await write(
    root,
    'packages/cli/src/program-install.ts',
    [
      "program.command('setup [sub]')",
      "program.command('update')",
      "program.command('runtime <sub>')",
      "program.command('dashboard')",
      "program.option('--codex')",
      "program.option('--codex')",
      "program.option('--rollback')",
      "program.option('--open')",
    ].join('\n'),
  )
  await write(
    root,
    'packages/cli/src/commands/runtime.ts',
    [
      "if (sub === 'status') return 0",
      "if (sub === 'repair' && opts.rollback === true) return 0",
    ].join('\n'),
  )
  await write(
    root,
    'packages/dashboard-app/src/shell/views.ts',
    [
      "export const VIEWS = ['progress', 'workbench', 'skills'] as const",
      "export type View = (typeof VIEWS)[number]",
    ].join('\n'),
  )
  const defaultStepIds = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']
  const defaultWorkflowYaml = [
    'name: default',
    ...defaultStepIds.flatMap((id) => [
      `  - id: ${id}`,
      '    skills:',
      `      - id: tenon-${id}`,
    ]),
  ].join('\n')
  await write(root, 'templates/workflows/default.yaml', defaultWorkflowYaml)
  const generatedWorkflowSource = [
    'name: default',
    ...defaultStepIds.flatMap((id) => [
      `  - id: ${id}`,
      '    skills:',
      `      - id: tenon-${id}`,
    ]),
  ].join('\n')
  await write(
    root,
    'packages/kernel/src/workflow/default-workflow.generated.ts',
    `export const DEFAULT_WORKFLOW_SOURCE = ${JSON.stringify(generatedWorkflowSource)}\n`,
  )
  await write(
    root,
    'skills/tenon/SKILL.md',
    [
      '# Tenon',
      '## Step 4: Phase dispatch',
      '| phase | skill |',
      '| --- | --- |',
      ...defaultStepIds.map((id) => `| \`${id}\` | \`tenon-${id}\` |`),
    ].join('\n'),
  )
  await write(
    root,
    'templates/workflows/simple.yaml',
    ['name: simple', ...['change', 'verify', 'done', 'escalated'].map((id) => `  - id: ${id}`)].join('\n'),
  )

  const communityLinks = [
    '[Usage](docs/usage/README.md)',
    '[English](README.en.md)',
    '[Contributing](CONTRIBUTING.md)',
    '[Code of Conduct](CODE_OF_CONDUCT.md)',
    '[Security](SECURITY.md)',
    '[Support](SUPPORT.md)',
    '[License](LICENSE)',
  ].join(' · ')
  await write(
    root,
    'README.md',
    `# Tenon\n\n${communityLinks}\n\nRequires Node.js 22+. Dashboard: 127.0.0.1:18765.\n\n${installCommand}\n\n\`tenon setup --codex\`\n\n\`tenon dashboard --open\`\n`,
  )
  await write(
    root,
    'README.en.md',
    [
      '# Tenon',
      '',
      '[中文](README.md) · [Usage](docs/usage/README.md) · [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [License](LICENSE)',
      '',
      '需要 Node.js 22+。Dashboard：127.0.0.1:18765。',
      installCommand,
      '',
      '`tenon setup --codex`',
      '',
      '`tenon dashboard --open`',
    ].join('\n'),
  )
  await write(root, 'README.zh-CN.md', '# 中文说明\n\n[README](README.md)\n')
  for (const file of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'SUPPORT.md']) {
    await write(root, file, `# ${file}\n`)
  }
  await write(root, 'LICENSE', 'MIT\n')

  for (const file of usageFiles) {
    await write(root, `docs/usage/${file}`, `# ${file}\n`)
    await write(
      root,
      `docs/usage/zh-CN/${file === 'README.md' ? 'index.md' : file}`,
      `# ${file}\n`,
    )
  }
  await write(root, 'docs/usage/quickstart.md', `# Quickstart\n\n${installCommand}\n\nUses a prebuilt release; no source compilation.\n`)
  await write(root, 'docs/usage/zh-CN/quickstart.md', `# 快速开始\n\n${installCommand}\n\n使用预构建发布包，不从源码编译。\n`)
  await write(
    root,
    'docs/usage/README.md',
    [
      '# Usage',
      '',
      '[Install](installation.md) · [Routing](routing-and-workflows.md) · [Dashboard](dashboard-and-local-api.md)',
    ].join('\n'),
  )
  await write(
    root,
    'docs/usage/installation.md',
    [
      '# Installation',
      'Requires Node.js 22+.',
      installCommand,
      '`tenon setup --codex`',
      '`tenon update --codex`',
      '`tenon runtime status`',
      '`tenon runtime repair --rollback`',
      '`tenon dashboard --open`',
    ].join('\n\n'),
  )
  await write(
    root,
    'docs/usage/routing-and-workflows.md',
    '# Routing\n\nSimple: change → verify → done → escalated.\n\nThe default Workflow keeps its frozen phase Skills; named profiles remain phase-first and do not become an automatic gate.\n',
  )
  await write(
    root,
    'docs/usage/default-workflow.md',
    `# Default\n\nopen → explore → spec ⇄ build ⇄ verify → ship → archive\n\n${defaultStepIds.map((id) => `\`${id}\` → \`tenon-${id}\``).join(' · ')}\n`,
  )
  await write(
    root,
    'docs/usage/dashboard-and-local-api.md',
    '# Dashboard\n\nProjects → Progress → AFK → Workbench → Machine → Skills → hostPlan are the operational views. Overview is separate. Use 127.0.0.1:18765 and `tenon dashboard --open`.\n',
  )
  await write(
    root,
    'docs/usage/updates-recovery-and-uninstall.md',
    '# Updates\n\n`tenon update --codex`\n\n`tenon runtime status`\n\n`tenon runtime repair --rollback`\n',
  )
  await write(
    root,
    'docs/usage/cli-reference.md',
    [
      '# CLI',
      '`tenon setup --codex`',
      '`tenon update --codex`',
      '`tenon runtime status`',
      '`tenon runtime repair --rollback`',
      '`tenon dashboard --open`',
    ].join('\n\n'),
  )
  await write(
    root,
    'docs/usage/zh-CN/installation.md',
    [
      '# 安装',
      '需要 Node.js 22+。',
      installCommand,
      '`tenon setup --codex`',
      '`tenon update --codex`',
      '`tenon runtime status`',
      '`tenon runtime repair --rollback`',
      '`tenon dashboard --open`',
    ].join('\n\n'),
  )
  await write(
    root,
    'docs/usage/zh-CN/routing-and-workflows.md',
    '# 路由\n\nSimple: change → verify → done → escalated。\n\n默认 Workflow 的阶段 Skill 是冻结要求；具名 profile 仍按 phase-first 合并，不会变成自动要求。\n',
  )
  await write(
    root,
    'docs/usage/zh-CN/default-workflow.md',
    `# 默认流程\n\nopen → explore → spec ⇄ build ⇄ verify → ship → archive\n\n${defaultStepIds.map((id) => `\`${id}\` → \`tenon-${id}\``).join(' · ')}\n`,
  )
  await write(
    root,
    'docs/usage/zh-CN/dashboard-and-local-api.md',
    '# Dashboard\n\nProjects → Progress → AFK → Workbench → Machine → Skills → hostPlan 是操作视图，Overview 独立。使用 127.0.0.1:18765 和 `tenon dashboard --open`。\n',
  )
  await write(
    root,
    'docs/usage/zh-CN/updates-recovery-and-uninstall.md',
    '# 更新\n\n`tenon update --codex`\n\n`tenon runtime status`\n\n`tenon runtime repair --rollback`\n',
  )
  await write(
    root,
    'docs/usage/zh-CN/cli-reference.md',
    [
      '# CLI',
      '`tenon setup --codex`',
      '`tenon update --codex`',
      '`tenon runtime status`',
      '`tenon runtime repair --rollback`',
      '`tenon dashboard --open`',
    ].join('\n\n'),
  )
  return root
}

test('accepts a coherent canonical documentation fixture', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(checkRepository(root), [])
})

test('reports the source and target for a missing repository-relative link', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'docs/usage/quickstart.md', '# Quickstart\n\n[Missing](./not-here.md)\n')
  assert.match(checkRepository(root).join('\n'), /docs\/usage\/quickstart\.md:3.*\.\/not-here\.md/)
})

test('rejects a Markdown link that escapes the repository', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'docs/usage/quickstart.md', '# Quickstart\n\n[Outside](../../../outside.md)\n')
  assert.match(checkRepository(root).join('\n'), /escapes repository/)
})

test('rejects a repository-relative Markdown link with a missing fragment', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'docs/usage/quickstart.md', '# Quickstart\n\n[Broken](installation.md#missing-heading)\n')
  assert.match(checkRepository(root).join('\n'), /missing Markdown fragment #missing-heading/)
})

test('detects a production-port claim that drifted from the exported source constant', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'packages/server/src/port.ts', 'export const DEFAULT_DASHBOARD_PORT = 19000\n')
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /README\.md.*19000/)
  assert.match(failures, /dashboard-and-local-api\.md.*19000/)
})

test('rejects main-based public installation and release-version drift', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'install.sh', 'TENON_RELEASE_VERSION="1.0.1"\n')
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  await write(root, 'README.md', readme.replace(
    'https://raw.githubusercontent.com/jefferysha/tenon/v1.0.2/install.sh',
    'https://raw.githubusercontent.com/jefferysha/tenon/main/install.sh',
  ))
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /install\.sh.*1\.0\.2/)
  assert.match(failures, /README\.md.*main\/install\.sh/)
})

test('quickstarts must use the versioned official installer instead of main', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const quickstart = await readFile(join(root, 'docs/usage/quickstart.md'), 'utf8')
  await write(root, 'docs/usage/quickstart.md', quickstart.replace(
    'https://raw.githubusercontent.com/jefferysha/tenon/v1.0.2/install.sh',
    'https://raw.githubusercontent.com/jefferysha/tenon/main/install.sh',
  ))
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /docs\/usage\/quickstart\.md.*main\/install\.sh/)
})

test('detects workflow shape drift from the YAML step list', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(
    root,
    'templates/workflows/simple.yaml',
    ['name: simple', ...['change', 'verify', 'audit', 'done', 'escalated'].map((id) => `  - id: ${id}`)].join('\n'),
  )
  assert.match(checkRepository(root).join('\n'), /routing-and-workflows\.md.*audit/)
})

test('rejects a default phase Skill missing from the source YAML and generated runtime contract', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await readFile(join(root, 'templates/workflows/default.yaml'), 'utf8')
  await write(root, 'templates/workflows/default.yaml', source.replace('tenon-build', 'wrong-build'))
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /default\.yaml.*build.*tenon-build/)
})

test('rejects a dispatch mapping drift even when source and generated workflow still agree', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const skill = await readFile(join(root, 'skills/tenon/SKILL.md'), 'utf8')
  await write(root, 'skills/tenon/SKILL.md', skill.replace('| `verify` | `tenon-verify` |', '| `verify` | `tenon-build` |'))
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /SKILL\.md.*verify.*tenon-verify/)
})

test('detects drift in the documented runtime subcommands', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'packages/cli/src/commands/runtime.ts', "if (sub === 'repair') return 0\n")
  assert.match(checkRepository(root).join('\n'), /commands\/runtime\.ts.*status/)
})

test('keeps operational views declared in VIEWS', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(
    root,
    'packages/dashboard-app/src/shell/views.ts',
    [
      "export const VIEWS = ['progress', 'workbench', 'missing'] as const",
      "export type View = (typeof VIEWS)[number]",
    ].join('\n'),
  )
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /VIEWS must remain the exact operational set/)
})

test('rejects removing or replacing one of the operational views', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(
    root,
    'packages/dashboard-app/src/shell/views.ts',
    [
      "export const VIEWS = ['progress', 'other'] as const",
      "export type View = (typeof VIEWS)[number]",
    ].join('\n'),
  )
  assert.match(checkRepository(root).join('\n'), /VIEWS must remain the exact operational set/)
})

test('requires README language and community links', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'README.md', '# Tenon\n\nRequires Node.js 22+. Dashboard: 127.0.0.1:18765.\n')
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /README\.md.*README\.en\.md/)
  assert.match(failures, /README\.md.*SECURITY\.md/)
})
