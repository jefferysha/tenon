import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentEntries } from '../content-manifest.mjs'
import { auditArtifactFileSet } from './artifact-allowlist.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(root, '..')
const dist = resolve(root, 'dist')
const required = ['index.html', 'en/index.html', 'llms.txt', 'installation.html', 'en/installation.html']
const errors = []
const textAssets = []
const expectedHtml = new Set(contentEntries.flatMap((entry) => [
  entry.locales['zh-CN'].target.replace(/\.md$/u, '.html'),
  entry.locales.en.target.replace(/\.md$/u, '.html'),
]))
const expectedTopLevel = new Set([
  ...expectedHtml,
  '404.html',
  'hashmap.json',
  'llms.txt',
  'logo.svg',
  'vp-icons.css',
  'images/dashboard-overview.webp',
  'images/dashboard-progress.webp',
  'images/dashboard-workflow-editor.webp',
  'images/dashboard-workbench.webp',
])
errors.push(...await auditArtifactFileSet(dist, expectedTopLevel))

for (const file of required) {
  try {
    const info = await stat(resolve(dist, file))
    if (!info.isFile()) errors.push(`${file} 不是文件`)
  } catch {
    errors.push(`缺少 ${file}`)
  }
}

const builtFiles = await readdir(dist, { recursive: true }).catch(() => [])
for (const file of builtFiles) {
  const rel = String(file)
  const info = await stat(resolve(dist, rel))
  if (!info.isFile()) continue
  if (rel.endsWith('.woff2')) continue
  if (rel.endsWith('.webp')) continue
  if (!/\.(?:html|js|css|json|txt|svg)$/u.test(rel)) {
    errors.push(`${rel}: 未知公开文件类型`)
    continue
  }
  const body = await readFile(resolve(dist, rel), 'utf8')
  textAssets.push({ rel, body })
  if (rel.endsWith('.html')) {
    const rootAsset = /(?:src|href)="\/(?!tenon\/|\/)/.exec(body)
    if (rootAsset) errors.push(`${rel}: 发现绕过 /tenon/ 的站内绝对路径 ${rootAsset[0]}`)
  }
  if (body.includes('/Users/')) {
    errors.push(`${rel}: 发现用户目录绝对路径`)
  }
  const sensitivePatterns = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, '私钥'],
    [/\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~-]{20,}/iu, 'Bearer 凭证'],
    [/[?&](?:access_token|api_key|token|secret)=[A-Za-z0-9._~-]{12,}/iu, '查询参数凭证'],
    [/(?:\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/u, '用户目录绝对路径'],
  ]
  for (const [pattern, label] of sensitivePatterns) {
    if (pattern.test(body)) errors.push(`${rel}: 发现疑似${label}`)
  }
}

const htmlRoutes = builtFiles.filter((file) => String(file).endsWith('.html') && String(file) !== '404.html')
const expectedRouteCount = contentEntries.length * 2
if (htmlRoutes.length !== expectedRouteCount) {
  errors.push(`公开 HTML 路由应为 ${expectedRouteCount}，实际 ${htmlRoutes.length}`)
}
for (const route of expectedHtml) {
  if (!htmlRoutes.map(String).includes(route)) errors.push(`缺少公开 HTML 路由: ${route}`)
}

const homeHtml = await readFile(resolve(dist, 'index.html'), 'utf8').catch(() => '')
if (!/<main[^>]*class="[^"]*tenon-home-main/u.test(homeHtml)) {
  errors.push('中文首页缺少 main landmark')
}
if (!/<header[\s\S]*<main[^>]*class="[^"]*tenon-home-main[\s\S]*<\/main>[\s\S]*<footer/u.test(homeHtml)) {
  errors.push('中文首页 main 必须位于全局 header 与 footer 之间，不能包裹全局导航')
}
const englishHomeHtml = await readFile(resolve(dist, 'en/index.html'), 'utf8').catch(() => '')
if (!/<main[^>]*class="[^"]*tenon-home-main/u.test(englishHomeHtml)) {
  errors.push('英文首页缺少 main landmark')
}
const artifactCorpus = textAssets.map(({ body }) => body).join('\n')
for (const expected of ['tenon-not-found', '页面未找到', '返回文档首页']) {
  if (!artifactCorpus.includes(expected)) {
    errors.push(`客户端编译产物缺少中文 404 标识: ${expected}`)
  }
}
for (const route of ['installation.html', 'en/installation.html']) {
  const body = await readFile(resolve(dist, route), 'utf8').catch(() => '')
  if (!body.includes('tenon-breadcrumb')) errors.push(`${route}: 缺少 breadcrumb`)
  const expectedGroup = route.startsWith('en/') ? 'Get started' : '开始使用'
  if (!body.includes(expectedGroup)) errors.push(`${route}: breadcrumb 缺少内容分组 ${expectedGroup}`)
}
for (const forbidden of [
  'Main Navigation',
  'Sidebar Navigation',
  '>Pager<',
]) {
  if (homeHtml.includes(forbidden)) errors.push(`中文首页仍包含英文可访问名称: ${forbidden}`)
}

const sourceCorpus = async (locale) => (
  await Promise.all(contentEntries.map(({ locales }) => readFile(resolve(repoRoot, locales[locale].source), 'utf8')))
).join('\n').toLowerCase()
const zhSearchCorpus = await sourceCorpus('zh-CN')
const enSearchCorpus = await sourceCorpus('en')
for (const query of ['安装', '更新', 'review gate', 'verify-fail', '18765', '.pipeline-document-locale.json']) {
  if (!zhSearchCorpus.includes(query.toLowerCase())) errors.push(`中文搜索构建语料缺少固定查询: ${query}`)
}
for (const query of ['installation', 'update', 'review gate', 'verify-fail', '18765', '.pipeline-document-locale.json']) {
  if (!enSearchCorpus.includes(query)) errors.push(`英文搜索构建语料缺少固定查询: ${query}`)
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[docs-smoke] ${error}`)
  process.exitCode = 1
} else {
  console.log('[docs-smoke] PASS: 双语入口、白名单搜索源、敏感信息扫描与 project base artifact 可用')
}
