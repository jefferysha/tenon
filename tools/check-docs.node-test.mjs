import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkRepository, findPlainTextTagContinuations, findWrappedAngleCodeSpans } from './check-docs.mjs'

const usageFiles = [
  'README.md',
  'installation.md',
  'quickstart.md',
  'routing-and-workflows.md',
  'default-workflow.md',
  'custom-workflows-and-tracks.md',
  'documents-skills-and-evidence.md',
  'agents.md',
  'dashboard-and-local-api.md',
  'automation-and-loops.md',
  'advanced-tools.md',
  'updates-recovery-and-uninstall.md',
  'troubleshooting.md',
  'security-model.md',
  'ci-verification.md',
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
      "export const VIEWS = ['workspace', 'workflow', 'projects', 'library', 'skills'] as const",
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
    'packages/cli/src/program-users.ts',
    [
      "program.command('user')",
      "user.command('set <id>')",
      "program.command('owner')",
      "owner.command('take <change>')",
      "owner.command('set <change> <id>')",
    ].join('\n'),
  )
  await write(
    root,
    'docs/CONTRACT.md',
    '# CONTRACT\n\n`tenon user` / `tenon user set` / `tenon owner take` / `tenon owner set`\n',
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
    '# Dashboard\n\nWorkspace → Workflow → Projects → Library → Skills are the operational views; AFK, Machine and hostPlan are not. Overview is separate. Use 127.0.0.1:18765 and `tenon dashboard --open`.\n',
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
      '`tenon user` · `tenon user set` · `tenon owner take` · `tenon owner set`',
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
    '# Dashboard\n\nWorkspace → Workflow → Projects → Library → Skills 是操作视图，AFK、Machine 与 hostPlan 不是，Overview 独立。使用 127.0.0.1:18765 和 `tenon dashboard --open`。\n',
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
      '`tenon user` · `tenon user set` · `tenon owner take` · `tenon owner set`',
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
      "export const VIEWS = ['workspace', 'workflow', 'missing'] as const",
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

test('identity and ownership commands must be documented in both CLI references and CONTRACT', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'docs/usage/zh-CN/cli-reference.md', '# CLI\n\n`tenon setup --codex`\n\n`tenon update --codex`\n\n`tenon runtime status`\n\n`tenon runtime repair --rollback`\n\n`tenon dashboard --open`\n\n`tenon user`\n')
  await write(root, 'docs/CONTRACT.md', '# CONTRACT\n\n`tenon user` / `tenon user set`\n')
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /zh-CN\/cli-reference\.md: missing identity\/ownership command `tenon owner take`/)
  assert.match(failures, /docs\/CONTRACT\.md: missing identity\/ownership command `tenon owner set`/)
  assert.doesNotMatch(failures, /docs\/usage\/cli-reference\.md: missing identity/)
})

test('identity and ownership commands must stay registered', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'packages/cli/src/program-users.ts', "program.command('user')\nuser.command('set <id>')\n")
  assert.match(checkRepository(root).join('\n'), /program-users\.ts: missing documented `tenon owner take` command/)
})

test('current install docs must not claim the retired 1.x releases were already deleted', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const zh = await readFile(join(root, 'docs/usage/zh-CN/installation.md'), 'utf8')
  await write(root, 'docs/usage/zh-CN/installation.md', `${zh}\n\n已退役的 1.x Release 与标签全部删除。\n`)
  const en = await readFile(join(root, 'docs/usage/installation.md'), 'utf8')
  await write(root, 'docs/usage/installation.md', `${en}\n\nThe retired 1.x releases were\nremoved.\n`)
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /zh-CN\/installation\.md: claims the retired 1\.x releases\/tags were deleted/)
  assert.match(failures, /docs\/usage\/installation\.md: claims the retired 1\.x releases\/tags were deleted/)

  await write(root, 'docs/usage/zh-CN/installation.md', `${zh}\n\n已退役的 1.x Release 与标签仍在，计划在 v0.x 真实宿主验收后删除。\n`)
  await write(root, 'docs/usage/installation.md', `${en}\n\nThe retired 1.x releases and tags are still published and will be removed after the v0.x real-host acceptance.\n`)
  assert.deepEqual(checkRepository(root), [])
})

test('finds inline code spans with a placeholder that are hard-wrapped across a line break', () => {
  const markdown = [
    '# Title',
    '',
    'Open a task and `tenon set <new> depends_on',
    '<old>`, then continue.',
    '',
    'Start with `tenon init <name> --workflow',
    'standard --track standard` here.',
    '',
    'A double-backtick span ``tenon test integrity',
    '<change>`` also counts.',
  ].join('\n')
  assert.deepEqual(findWrappedAngleCodeSpans(markdown), [
    { startLine: 3, endLine: 4, code: 'tenon set <new> depends_on <old>' },
    { startLine: 6, endLine: 7, code: 'tenon init <name> --workflow standard --track standard' },
    { startLine: 9, endLine: 10, code: 'tenon test integrity <change>' },
  ])
})

test('leaves single-line spans, wrapped spans without a placeholder and fenced code alone', () => {
  const markdown = [
    'Run `tenon set <new> depends_on <old>` on one line.',
    '',
    'Keep `tenon <command>` and `tenon status',
    '--json` apart: only the second is wrapped, and it has no placeholder.',
    '',
    '```bash',
    'tenon set <new> depends_on',
    '<old>`',
    '```',
    '',
    '- item with an `unclosed span <a>',
    '- another item with <b>` stray backtick',
    '',
    '> quote `tenon <x>` fine',
    '',
    'Escaped \\`not code <a>',
    'still \\`not code <b>',
    '',
    '| col | `a <b>` |',
    '| --- | --- |',
  ].join('\n')
  assert.deepEqual(findWrappedAngleCodeSpans(markdown), [])
})

test('does not pair a code span across a list item, a heading or a blank line', () => {
  const markdown = [
    '- first `open <a>',
    '- second close <b>`',
    '',
    'tail `open <c>',
    '',
    'close <d>`',
    '',
    '## Heading `open <e>',
    'close <f>`',
  ].join('\n')
  assert.deepEqual(findWrappedAngleCodeSpans(markdown), [])
})

test('reports a wrapped placeholder code span in any docs/usage page with file and line range', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const routing = await readFile(join(root, 'docs/usage/routing-and-workflows.md'), 'utf8')
  await write(
    root,
    'docs/usage/routing-and-workflows.md',
    `${routing}\nOpen a task and \`tenon set <new> depends_on\n<old>\`.\n`,
  )
  await write(root, 'docs/usage/zh-CN/default-workflow.md', '# 默认流程\n\n运行 `tenon test integrity\n<change>` 查看。\n')
  await write(root, 'docs/usage/zh-CN/extra-page.md', '# Extra\n\n`tenon init <name>\n--workflow standard`\n')
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /docs\/usage\/routing-and-workflows\.md:\d+-\d+: inline code span containing "<" is wrapped across a line break.*tenon set <new> depends_on <old>/)
  assert.match(failures, /docs\/usage\/zh-CN\/default-workflow\.md:3-4: .*tenon test integrity <change>/)
  assert.match(failures, /docs\/usage\/zh-CN\/extra-page\.md:3-4: .*tenon init <name> --workflow standard/)
})

test('accepts the same placeholder code spans once they sit on one line', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const routing = await readFile(join(root, 'docs/usage/routing-and-workflows.md'), 'utf8')
  await write(
    root,
    'docs/usage/routing-and-workflows.md',
    `${routing}\nOpen a task and\n\`tenon set <new> depends_on <old>\`.\n`,
  )
  assert.deepEqual(checkRepository(root), [])
})

test('finds plain-text continuation lines that start with a tag-like token', () => {
  const markdown = [
    '# Title',
    '',
    'Open a task named after the change and keep going until',
    '<change> is merged, then stop.',
    '',
    'Another sentence that wraps right before',
    '</name> closes nothing.',
    '',
    '- a list item that wraps before',
    '  <old attr="x"> and continues',
    '',
    '> a quote that wraps before',
    '> <new>',
  ].join('\n')
  assert.deepEqual(findPlainTextTagContinuations(markdown), [
    { line: 4, token: '<change', text: '<change> is merged, then stop.' },
    { line: 7, token: '</name', text: '</name> closes nothing.' },
    { line: 10, token: '<old', text: '<old attr="x"> and continues' },
    { line: 13, token: '<new', text: '<new>' },
  ])
})

test('leaves fenced code, code spans, intentional HTML blocks and balanced or harmless tags alone', () => {
  const markdown = [
    '```text',
    'prose that wraps before',
    '<change> inside a fence',
    '```',
    '',
    '~~~',
    'prose',
    '<name>',
    '~~~',
    '',
    'A wrapped span `tenon set <new> depends_on',
    '<old>` is the wrapped-span check\'s job, not this one.',
    '',
    'Wrapped before a span that opens on the same line',
    '`<change>` and `<name>` stay in code.',
    '',
    '<p align="center"><sub>an intentional HTML block',
    '<b>keeps</b> its own lines',
    '</sub></p>',
    '',
    '<img src="a.webp" alt="x" width="1280"',
    '  height="720" />',
    '',
    '<!-- a comment',
    '<note> hidden -->',
    '',
    'A void element wraps before',
    '<br> and that is fine.',
    '',
    'Balanced inline HTML wraps before',
    '<kbd>Ctrl</kbd> and goes on.',
    '',
    'An autolink wraps before',
    '<https://example.test/a?b=c> and an address',
    '<someone@example.test> are not tags.',
    '',
    'Not a tag name: wraps before',
    '<foo_bar> and before',
    '<5 files and before',
    '<= a limit.',
    '',
    'Escaped, wraps before',
    '\\<change> stays text.',
    '',
    '    <indented> code block line one',
    '    <indented> code block line two',
    '',
    '- <img src="x.webp" />',
    '  <sub>caption</sub>',
  ].join('\n')
  assert.deepEqual(findPlainTextTagContinuations(markdown), [])
})

test('finds a paragraph whose first line starts with an unclosed tag-like token', () => {
  const markdown = [
    '# Title',
    '',
    '<change> starts the paragraph and is not closed.',
    '',
    '<name> starts a paragraph that goes on',
    'over a second line.',
    '',
    '- <old> opens a list item',
    '',
    '1. <new attr="x"> opens a numbered item',
    '',
    '> <quoted> opens a quoted paragraph',
    '',
    '   </stray> a closing tag with no opener',
    '',
    '<alone>',
  ].join('\n')
  assert.deepEqual(findPlainTextTagContinuations(markdown), [
    { line: 3, token: '<change', text: '<change> starts the paragraph and is not closed.' },
    { line: 5, token: '<name', text: '<name> starts a paragraph that goes on' },
    { line: 8, token: '<old', text: '<old> opens a list item' },
    { line: 10, token: '<new', text: '<new attr="x"> opens a numbered item' },
    { line: 12, token: '<quoted', text: '<quoted> opens a quoted paragraph' },
    { line: 14, token: '</stray', text: '</stray> a closing tag with no opener' },
    { line: 16, token: '<alone', text: '<alone>' },
  ])
})

test('leaves first lines alone that are code, intentional HTML, balanced, void or not a tag', () => {
  const markdown = [
    '`<change>` opens with a code span and stays text.',
    '',
    '`tenon set <a>` and then <b> only after the span.',
    '',
    '\\<change> is escaped on the first line.',
    '',
    '<kbd>Ctrl</kbd> is balanced on the first line.',
    '',
    '<b>bold that closes later',
    'on the next line</b> is balanced too.',
    '',
    '<br> is a void element.',
    '',
    '<img src="a.webp" alt="x" width="1280" />',
    '',
    '<img src="b.webp"',
    '  alt="a tag split over lines" />',
    '',
    '- <img src="c.webp" />',
    '',
    '<div class="note">an HTML block on purpose',
    '<change> inside it is the author\'s own',
    '</div>',
    '',
    '<picture>',
    '<source srcset="a.webp">',
    '<img src="a.png" />',
    '</picture>',
    '',
    '<https://example.test/a> is an autolink and <someone@example.test> an address.',
    '',
    '<5 files and <= a limit are not tags.',
    '',
    '## <change>',
    '',
    '| a | <b> |',
    '| - | - |',
    '',
    '    <indented> is an indented code block',
    '',
    '```text',
    '<change> in a fence',
    '```',
  ].join('\n')
  assert.deepEqual(findPlainTextTagContinuations(markdown), [])
})

test('an open tag alone on the first line must be closed somewhere later on the page', () => {
  assert.deepEqual(findPlainTextTagContinuations('<picture>\n<img src="a.png" />\n</picture>\n'), [])
  assert.deepEqual(findPlainTextTagContinuations('<picture>\n\ntext\n\n</picture>\n'), [])
  assert.deepEqual(findPlainTextTagContinuations('<picture>\n<img src="a.png" />\n'), [
    { line: 1, token: '<picture', text: '<picture>' },
  ])
  // A closing tag alone is the end of an HTML block somebody opened on purpose.
  assert.deepEqual(findPlainTextTagContinuations('</picture>\n'), [])
})

test('does not read a closing tag inside a code span as closing the placeholder', () => {
  const markdown = [
    'Wraps before',
    '<change> and then `</change>` only in code.',
  ].join('\n')
  assert.deepEqual(findPlainTextTagContinuations(markdown), [
    { line: 2, token: '<change', text: '<change> and then `</change>` only in code.' },
  ])
})

test('reports a plain-text tag-like continuation line in any docs/usage page with file and line', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const routing = await readFile(join(root, 'docs/usage/routing-and-workflows.md'), 'utf8')
  await write(
    root,
    'docs/usage/routing-and-workflows.md',
    `${routing}\nStart a task with the name of the change you\n<new> wants to open.\n`,
  )
  await write(root, 'docs/usage/zh-CN/default-workflow.md', '# 默认流程\n\n运行测试之前先确认\n<change> 已经存在。\n')
  await write(root, 'docs/usage/zh-CN/extra-page.md', '# Extra\n\n先写名字\n</name> 再写别的\n')
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /docs\/usage\/routing-and-workflows\.md:\d+: plain-text line starts with the tag-like token "<new".*<new> wants to open\./)
  assert.match(failures, /docs\/usage\/zh-CN\/default-workflow\.md:4: plain-text line starts with the tag-like token "<change"/)
  assert.match(failures, /docs\/usage\/zh-CN\/extra-page\.md:4: plain-text line starts with the tag-like token "<\/name"/)
})

test('accepts the same placeholders once they sit in a code span or are escaped', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const routing = await readFile(join(root, 'docs/usage/routing-and-workflows.md'), 'utf8')
  await write(
    root,
    'docs/usage/routing-and-workflows.md',
    `${routing}\nStart a task with the name of the change you\n\`<new>\` wants to open, and\n\\<other> is escaped.\n`,
  )
  assert.deepEqual(checkRepository(root), [])
})

test('reports a paragraph that opens with a placeholder in any docs/usage page with file and line', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const routing = await readFile(join(root, 'docs/usage/routing-and-workflows.md'), 'utf8')
  await write(
    root,
    'docs/usage/routing-and-workflows.md',
    `${routing}\n<new> is the name of the change you want to open.\n`,
  )
  await write(root, 'docs/usage/zh-CN/default-workflow.md', '# 默认流程\n\n- <change> 必须已经存在。\n')
  const failures = checkRepository(root).join('\n')
  assert.match(failures, /docs\/usage\/routing-and-workflows\.md:\d+: plain-text line starts with the tag-like token "<new".*<new> is the name of the change/)
  assert.match(failures, /docs\/usage\/zh-CN\/default-workflow\.md:3: plain-text line starts with the tag-like token "<change"/)
})

test('accepts the same first lines once the placeholder sits in a code span or is escaped', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const routing = await readFile(join(root, 'docs/usage/routing-and-workflows.md'), 'utf8')
  await write(
    root,
    'docs/usage/routing-and-workflows.md',
    `${routing}\n\`<new>\` is the name of the change you want to open.\n\n\\<other> is escaped.\n\n- \`<change>\` must exist.\n`,
  )
  assert.deepEqual(checkRepository(root), [])
})

test('checks the README files for wrapped code spans and tag-like lines too', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['README.md', 'README.en.md']) {
    const readme = await readFile(join(root, name), 'utf8')
    await write(root, name, `${readme}\nThe hidden command \`tenon internal-skill-provenance verify|sync\n--root <path> [--json]\` is the implementation.\n\n<change> opens a paragraph.\n`)
  }
  const failures = checkRepository(root).join('\n')
  for (const name of ['README.md', 'README.en.md']) {
    const escaped = name.replace('.', '\\.')
    assert.match(failures, new RegExp(`${escaped}:\\d+-\\d+: inline code span containing "<" is wrapped across a line break.*verify\\|sync --root <path> \\[--json\\]`))
    assert.match(failures, new RegExp(`${escaped}:\\d+: plain-text line starts with the tag-like token "<change"`))
  }
})

test('accepts the README placeholder code span once it sits on one line', async (t) => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['README.md', 'README.en.md']) {
    const readme = await readFile(join(root, name), 'utf8')
    await write(root, name, `${readme}\nThe hidden command\n\`tenon internal-skill-provenance verify|sync --root <path> [--json]\` is the implementation.\n`)
  }
  assert.deepEqual(checkRepository(root), [])
})
