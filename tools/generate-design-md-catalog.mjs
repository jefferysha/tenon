#!/usr/bin/env node
/**
 * 把 VoltAgent/awesome-design-md 的每个品牌目录写成一条 DESIGN.md 资源（`design-md-<slug>.yaml`）。
 *
 * 目录只收录链接：品牌视觉归各公司所有，条目标为不可再分发，内容在选用时由 `npx getdesign add <slug>`
 * 落到项目根目录。需要联网，手动运行后提交产物，CI 不跑。同一天重跑输出逐字节一致。
 *
 * 用法：node tools/generate-design-md-catalog.mjs [--check]
 *   --check  只比对现有文件，有差异时退出码 1（不写盘）
 */
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(REPO_ROOT, 'templates', 'resources', 'builtin')
const REPO = 'VoltAgent/awesome-design-md'
const RAW = `https://raw.githubusercontent.com/${REPO}/HEAD`
const LICENSE_URL = `${RAW}/LICENSE`
/** 品牌条目 id 前缀；手工维护的条目一律不用这个前缀，本脚本会删掉前缀下多余的文件。 */
const PREFIX = 'design-md-'
const SLUG = /^[a-z0-9][a-z0-9.-]{0,50}$/u
/** 条目 id 不收点号：`linear.app` → `design-md-linear-app`，安装命令仍用上游目录名。 */
const idOf = (slug) => `${PREFIX}${slug.replace(/\./gu, '-')}`

async function fetchOnce(url, accept) {
  const response = await fetch(url, { headers: { accept, 'user-agent': 'tenon-design-md-catalog' } })
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return accept === 'application/vnd.github+json' ? response.json() : response.text()
}

/** 每个请求重试一次；第二次仍失败就抛出，宁可不出目录也不写半份。 */
async function get(url, accept) {
  try {
    return await fetchOnce(url, accept)
  } catch {
    return fetchOnce(url, accept)
  }
}

/** DESIGN.md front matter 的 name 去掉 -design-analysis 后缀就是品牌名。 */
function brandName(text, slug) {
  const match = /^name:\s*(.+)$/mu.exec(text.slice(0, 2000))
  const raw = (match?.[1] ?? '').trim().replace(/^["']|["']$/gu, '')
  const cleaned = raw.replace(/-design-analysis$/u, '').replace(/-/gu, ' ').trim()
  return cleaned === '' ? slug.replace(/-/gu, ' ') : cleaned
}

/** 与 kernel serializeResourceScalar 同一套裸标量条件，产物才和解析器的规范写法逐字节一致。 */
function scalar(value) {
  const quote = value === '' || value !== value.trim() || value.includes(': ') || value.endsWith(':')
    || /["\\]/u.test(value) || /^[-?:,[\]{}&*!|>'%@`#]/u.test(value)
    || /^(true|false|null|~)$/iu.test(value) || /^-?\d+(?:\.\d+)?$/u.test(value)
  return quote ? JSON.stringify(value) : value
}

function render(slug, name, date) {
  return [
    'schema: tenon-resource/v1',
    `id: ${idOf(slug)}`,
    `name: ${scalar(name)}`,
    'category: design-md',
    'frameworks: []',
    'styling: []',
    'baseline: false',
    'license:',
    '  spdx: MIT',
    `  url: ${LICENSE_URL}`,
    '  redistributable: false',
    '  attribution: false',
    '  commercial: free',
    '  notice: 品牌视觉归各公司所有，仅作参考起步',
    'install:',
    `  - npx getdesign@latest add ${slug}`,
    'skills: []',
    'links:',
    `  source: https://github.com/${REPO}/tree/HEAD/design-md/${slug}`,
    `  design_md: ${RAW}/design-md/${slug}/DESIGN.md`,
    `verified_at: ${date}`,
    '',
  ].join('\n')
}

const check = process.argv.includes('--check')
const date = new Date().toISOString().slice(0, 10)
const listing = await get(`https://api.github.com/repos/${REPO}/contents/design-md`, 'application/vnd.github+json')
if (!Array.isArray(listing)) throw new Error('design-md 目录列表不是数组')
const slugs = listing.filter((item) => item.type === 'dir' && SLUG.test(item.name)).map((item) => item.name).sort()
if (slugs.length === 0) throw new Error('design-md 目录为空')

const written = []
for (const slug of slugs) {
  let text
  try {
    text = await get(`${RAW}/design-md/${slug}/DESIGN.md`, 'text/plain')
  } catch {
    process.stderr.write(`skip ${slug}: DESIGN.md 不可读\n`)
    continue
  }
  const file = join(OUT_DIR, `${idOf(slug)}.yaml`)
  const body = render(slug, brandName(text, slug), date)
  if (written.includes(`${idOf(slug)}.yaml`)) throw new Error(`品牌 id 冲突：${idOf(slug)}`)
  written.push(`${idOf(slug)}.yaml`)
  if (check) continue
  writeFileSync(file, body, 'utf8')
}

// 上游删掉的品牌同步删除，目录不留孤儿条目。
const stale = readdirSync(OUT_DIR).filter((name) => name.startsWith(PREFIX) && !written.includes(name))
for (const name of stale) {
  if (check) process.stderr.write(`stale ${name}\n`)
  else rmSync(join(OUT_DIR, name))
}
if (check && stale.length > 0) process.exit(1)
process.stdout.write(`${written.length} design-md entries\n`)
