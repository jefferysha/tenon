import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentEntries } from '../content-manifest.mjs'

const docsSiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(docsSiteRoot, '..')
const outputRoot = resolve(docsSiteRoot, '.generated')
const repositoryFiles = ['CONTRIBUTING', 'SECURITY', 'SUPPORT', 'CODE_OF_CONDUCT', 'README', 'README.zh-CN']
const publicDashboardImages = [
  'dashboard-overview.webp',
  'dashboard-progress.webp',
  'dashboard-workflow-editor.webp',
  'dashboard-workbench.webp',
]

function publicLinks(body, locale) {
  let next = body
  for (const name of repositoryFiles) {
    const target = name === 'README'
      ? (locale === 'en' ? '/en/' : '/')
      : name === 'README.zh-CN'
        ? '/'
        : `https://github.com/jefferysha/tenon/blob/main/${name}.md`
    const escaped = name.replace('.', '\\.')
    next = next.replace(
      new RegExp(`\\((?:\\.\\/)?(?:\\.\\.\\/){0,3}${escaped}(?:\\.md)?\\)`, 'g'),
      `(${target})`,
    )
  }
  return next
}

function publicImages(body) {
  return body
    .replace(
      /\((?:\.\.\/){2,3}docs-site\/public\/images\//g,
      '(/images/',
    )
    .replace(
      /src="(?:\.\.\/){2,3}docs-site\/public\/images\//g,
      'src="/images/',
    )
}

function pageBody(body, entry) {
  if (entry.slug !== 'index') return body

  // The home layout already renders the hero as the page's single h1. Keep the
  // canonical source useful as a standalone Markdown document while demoting
  // only the generated site's duplicate title.
  return body.replace(/^# /m, '## ')
}

function frontmatter(entry, locale) {
  const item = entry.locales[locale]
  const home = entry.slug === 'index'
    ? locale === 'zh-CN'
      ? [
          'layout: home',
          'hero:',
          '  name: Tenon',
          '  text: 让 Agent 交付过程可解释、可复验、可恢复',
          '  tagline: 从正常对话自动选择流程，用 OpenSpec、Skill 证据和 review receipt 串联真实工作。',
          '  actions:',
          "    - theme: brand",
          "      text: 五分钟快速开始",
          "      link: /quickstart",
          "    - theme: alt",
          "      text: 安装到 Codex",
          "      link: /installation",
          'features:',
          '  - title: 按复杂度选择流程',
          '    details: Discussion、Simple、Default、Free 与 Custom 各自遵守真实 DAG，不让每个任务都走最长流程。',
          '  - title: 证据驱动推进',
          '    details: 文档 digest、Skill producer、读取收据和 exact-event review 共同证明为什么可以进入下一阶段。',
          '  - title: 本地优先',
          '    details: Dashboard 和状态留在本机；公共站点只发布经过白名单审计的静态文档。',
        ]
      : [
          'layout: home',
          'hero:',
          '  name: Tenon',
          '  text: Explainable, repeatable, recoverable agent delivery',
          '  tagline: Route normal conversations into the right workflow and connect real work with OpenSpec, Skill evidence, and review receipts.',
          '  actions:',
          "    - theme: brand",
          "      text: Five-minute quickstart",
          "      link: /en/quickstart",
          "    - theme: alt",
          "      text: Install for Codex",
          "      link: /en/installation",
          'features:',
          '  - title: Match process to complexity',
          '    details: Discussion, Simple, Default, Free, and Custom follow their actual DAG instead of forcing every task through the longest path.',
          '  - title: Evidence-driven transitions',
          '    details: Document digests, Skill producers, read receipts, and exact-event reviews explain why a transition is allowed.',
          '  - title: Local first',
          '    details: Dashboard and state remain local; the public site contains only allowlisted static documentation.',
        ]
    : []
  return [
    '---',
    `title: ${JSON.stringify(item.title)}`,
    `description: ${JSON.stringify(item.description)}`,
    `lang: ${locale}`,
    `contentType: ${JSON.stringify(entry.contentType)}`,
    `group: ${JSON.stringify(locale === 'zh-CN' ? entry.group : ({
      开始使用: 'Get started',
      教程: 'Tutorials',
      操作指南: 'How-to guides',
      概念与架构: 'Concepts and architecture',
      参考: 'Reference',
      运维与安全: 'Operations and security',
      发布说明: 'Release notes',
      贡献: 'Contributing',
    })[entry.group] ?? entry.group)}`,
    ...home,
    '---',
    '',
  ].join('\n')
}

await rm(outputRoot, { recursive: true, force: true })
for (const entry of contentEntries) {
  for (const locale of ['zh-CN', 'en']) {
    const item = entry.locales[locale]
    const source = resolve(repoRoot, item.source)
    const target = resolve(outputRoot, item.target)
    const body = pageBody(publicImages(publicLinks(await readFile(source, 'utf8'), locale)), entry)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${frontmatter(entry, locale)}${body.trim()}\n`, 'utf8')
  }
}

const llms = [
  '# Tenon documentation',
  '',
  '> Public, versioned documentation index. Internal ADRs, plans, receipts, and local control-plane data are excluded.',
  '',
  ...contentEntries.flatMap((entry) => [
    `- [zh-CN] ${entry.locales['zh-CN'].title}: /tenon/${entry.locales['zh-CN'].target.replace(/\.md$/, '.html').replace(/index\.html$/, '')}`,
    `- [en] ${entry.locales.en.title}: /tenon/${entry.locales.en.target.replace(/\.md$/, '.html').replace(/index\.html$/, '')}`,
  ]),
  '',
].join('\n')
await mkdir(resolve(docsSiteRoot, 'public'), { recursive: true })
await writeFile(resolve(docsSiteRoot, 'public', 'llms.txt'), llms, 'utf8')
await mkdir(resolve(outputRoot, 'public'), { recursive: true })
await writeFile(resolve(outputRoot, 'public', 'llms.txt'), llms, 'utf8')
await copyFile(resolve(docsSiteRoot, 'public', 'logo.svg'), resolve(outputRoot, 'public', 'logo.svg'))
await mkdir(resolve(outputRoot, 'public', 'images'), { recursive: true })
for (const image of publicDashboardImages) {
  await copyFile(
    resolve(docsSiteRoot, 'public', 'images', image),
    resolve(outputRoot, 'public', 'images', image),
  )
}
