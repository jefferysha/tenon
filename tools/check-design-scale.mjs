#!/usr/bin/env node
/**
 * Dashboard 排版 / 间距 / 圆角刻度门禁。
 *
 * 背景：PRD「颜色、圆角、间距和阴影不再散落定义」里，颜色已经收敛到 token，
 * 字号 / 间距 / 圆角却各自散着十几种任意值（text-[12.5px]、rounded-[7px]、px-[11px]…）。
 * 收敛之后如果没有门禁，下一次改动会立刻把它们加回来，所以刻度和门禁必须同时存在。
 *
 * 真源：packages/dashboard-app/src/index.css 的 `@theme static` 段
 *   · 字号 7 级：micro / caption / body / base / title / section / page
 *   · 圆角 4 级：xs / sm / md / lg（药丸走 rounded-full）
 *   · 间距回到 Tailwind 原生 4px 栅格（gap-1 = 4px…），只保留 px / 0.5 两个亚栅格档
 *
 * 门禁看三类复发：
 *   ① tsx/ts 里重新出现 text-[Npx] / rounded-[Npx] / p|m|gap|space-[Npx] 任意值；
 *   ② tsx/ts 里使用刻度外已退役的类名（text-xs、rounded-xl、裸 rounded 等）——这些类在
 *      `--text-*: initial` / `--radius-*: initial` 之后不再生成，写了会静默丢样式；
 *   ③ 页面级裸 CSS（progress.css / workbench.css）重新硬编码 font-size / border-radius /
 *      非 4px 栅格的 padding|margin|gap。
 * 另外校验 index.css 里刻度档位本身没被偷偷加档或改名——否则「刻度」会重新变成一堆值。
 *
 * 例外：同一行写 `/* scale-exempt: 原因 *\/`（CSS）或 `// scale-exempt: 原因`（TS）。
 * 必须写原因；几何对齐（连接件、开关滑块、圆点光学对齐）是唯一预期的合法用法。
 * 定位类（top/left/right/bottom/inset）不在本门禁范围内：它们对齐的是具体几何，不是节奏。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEXT_SCALE = ['micro', 'caption', 'body', 'base', 'title', 'section', 'page']
export const RADIUS_SCALE = ['xs', 'sm', 'md', 'lg']

const SCAN_DIR = 'packages/dashboard-app/src'
const SCALE_SOURCE = 'packages/dashboard-app/src/index.css'
/** 例外必须写原因：`scale-exempt:` 后面第一个非空字符不能是注释结束符，空理由等于没理由。 */
const EXEMPT = /scale-exempt:[^\S\n]*[^\s*/]/u

/** 间距工具类前缀（含负 margin）。长前缀在前，保证 `space-x` 不被 `p` 之类抢先匹配。 */
const SPACING_PREFIXES = [
  'space-x', 'space-y', 'gap-x', 'gap-y', 'gap',
  'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe', 'p',
  'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me', 'm',
].join('|')
const SIDE = '(?:t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee)'
/** 只拦「纯长度」任意值；calc() / env() / var() / % / vh 表达的是几何或视口，不属节奏刻度。 */
const LENGTH = '-?[0-9]*\\.?[0-9]+(?:px|rem|em|pt)'

const TS_RULES = [
  {
    id: 'text-arbitrary',
    pattern: new RegExp(`(?<![\\w:-])text-\\[${LENGTH}\\]`, 'gu'),
    hint: `改用字号刻度 text-{${TEXT_SCALE.join('|')}}`,
  },
  {
    id: 'text-retired',
    pattern: /(?<![\w:-])text-(?:xs|sm|lg|xl|[2-9]xl)(?![\w-])/gu,
    hint: `该类名已随 --text-*: initial 退役，不再生成任何样式；改用 text-{${TEXT_SCALE.join('|')}}`,
  },
  {
    id: 'radius-arbitrary',
    pattern: new RegExp(`(?<![\\w:-])rounded(?:-${SIDE})?-\\[${LENGTH}\\]`, 'gu'),
    hint: `改用圆角刻度 rounded-{${RADIUS_SCALE.join('|')}}，药丸用 rounded-full`,
  },
  {
    id: 'radius-retired',
    pattern: new RegExp(`(?<![\\w:-])rounded(?:-${SIDE})?(?:-(?:xl|2xl|3xl|4xl))?(?![\\w-])`, 'gu'),
    hint: `该类名已随 --radius-*: initial 退役，不再生成任何样式；改用 rounded-{${RADIUS_SCALE.join('|')}} / rounded-full / rounded-none`,
  },
  {
    id: 'spacing-arbitrary',
    pattern: new RegExp(`(?<![\\w:-])-?(?:${SPACING_PREFIXES})-\\[${LENGTH}\\]`, 'gu'),
    hint: '改用 4px 栅格的原生间距类（gap-1=4px、px-3=12px…），亚栅格只留 -px / -0.5',
  },
]

const CSS_ALLOWED_RADIUS = new RegExp(
  `^(?:0|inherit|999px|50%|var\\(--radius(?:-(?:${RADIUS_SCALE.join('|')}))?\\))$`,
  'u',
)
const CSS_SPACING_PROPERTY = /^(?:padding|margin|gap|row-gap|column-gap|(?:padding|margin)-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)$/u

/** 注释里的示例（本文件、组件文件头都会写 `text-[Npx]`）不该被当成违规，先抹平再扫。 */
function maskComments(source, { line = true } = {}) {
  let out = ''
  let i = 0
  let state = 'code'
  let quote = ''
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (line && char === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (char === '"' || char === "'" || char === '`') { state = 'string'; quote = char }
      out += char; i += 1; continue
    }
    if (state === 'string') {
      if (char === '\\') { out += char + (next ?? ''); i += 2; continue }
      if (char === quote) state = 'code'
      out += char; i += 1; continue
    }
    if (state === 'block' && char === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue }
    if (state === 'line' && char === '\n') { state = 'code'; out += '\n'; i += 1; continue }
    out += char === '\n' ? '\n' : ' '
    i += 1
  }
  return out
}

function collectFiles(dir, accumulator = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collectFiles(path, accumulator)
    else if (/\.(?:ts|tsx|css)$/u.test(path)) accumulator.push(path)
  }
  return accumulator
}

function slash(path) {
  return path.split(sep).join('/')
}

function checkSourceFile(relativePath, source, failures) {
  const lines = source.split('\n')
  const maskedLines = maskComments(source).split('\n')
  maskedLines.forEach((masked, index) => {
    if (EXEMPT.test(lines[index] ?? '')) return
    for (const rule of TS_RULES) {
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(masked)) !== null) {
        failures.push(`${relativePath}:${index + 1} ${rule.id}: \`${match[0]}\` — ${rule.hint}`)
      }
    }
  })
}

function checkStyleFile(relativePath, source, failures) {
  const lines = source.split('\n')
  const maskedLines = maskComments(source, { line: false }).split('\n')
  maskedLines.forEach((masked, index) => {
    if (EXEMPT.test(lines[index] ?? '')) return
    const declaration = /^\s*([a-z-]+)\s*:\s*([^;{}]+);/u.exec(masked)
    if (declaration === null) return
    const property = declaration[1]
    const value = declaration[2].replace(/\s*!important\s*$/u, '').trim()
    const at = `${relativePath}:${index + 1}`
    if (property === 'font-size') {
      if (!new RegExp(`^var\\(--text-(?:${TEXT_SCALE.join('|')})\\)$`, 'u').test(value)) {
        failures.push(`${at} css-font-size: \`${value}\` — 裸 CSS 也要引刻度：var(--text-{${TEXT_SCALE.join('|')}})`)
      }
      return
    }
    if (property === 'border-radius') {
      const rest = value.split(/\s+/u).filter((part) => !CSS_ALLOWED_RADIUS.test(part))
      if (rest.length > 0) {
        failures.push(`${at} css-radius: \`${value}\` — 改用 var(--radius-{${RADIUS_SCALE.join('|')}})，药丸用 999px`)
      }
      return
    }
    if (CSS_SPACING_PROPERTY.test(property)) {
      for (const [, raw] of value.matchAll(/(-?[0-9]*\.?[0-9]+)px/gu)) {
        const px = Math.abs(Number(raw))
        if (px % 4 !== 0 && px > 2) {
          failures.push(`${at} css-spacing: \`${property}: ${value}\` — ${raw}px 不在 4px 栅格上（亚栅格只留 1px / 2px）`)
        }
      }
    }
  })
}

function checkScaleDefinition(root, failures) {
  const path = join(root, SCALE_SOURCE)
  const css = readFileSync(path, 'utf8')
  const block = /@theme\s+static\s*\{([\s\S]*?)\n\}/u.exec(css)
  if (block === null) {
    failures.push(`${SCALE_SOURCE} scale-source: 找不到 @theme static 刻度段；刻度必须集中声明在这里`)
    return
  }
  const body = maskComments(block[1], { line: false })
  const declared = (prefix) =>
    [...body.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9]+)\\s*:`, 'gmu'))].map((match) => match[1])
  const expect = (prefix, scale) => {
    const actual = [...new Set(declared(prefix))]
    const missing = scale.filter((step) => !actual.includes(step))
    const extra = actual.filter((step) => !scale.includes(step))
    if (missing.length > 0) failures.push(`${SCALE_SOURCE} scale-source: --${prefix}-* 缺档位 ${missing.join(', ')}`)
    if (extra.length > 0) failures.push(`${SCALE_SOURCE} scale-source: --${prefix}-* 多出档位 ${extra.join(', ')}；加档等于重新散落刻度`)
  }
  expect('text', TEXT_SCALE)
  expect('radius', RADIUS_SCALE)
  for (const namespace of ['text', 'radius']) {
    if (!new RegExp(`--${namespace}-\\*\\s*:\\s*initial`, 'u').test(body)) {
      failures.push(`${SCALE_SOURCE} scale-source: 缺 \`--${namespace}-*: initial\`；不清空默认档位就会留下同义双写的类名`)
    }
  }
}

export function checkDesignScale(root) {
  const failures = []
  checkScaleDefinition(root, failures)
  const scanRoot = join(root, SCAN_DIR)
  for (const path of collectFiles(scanRoot)) {
    const relativePath = slash(relative(root, path))
    const source = readFileSync(path, 'utf8')
    if (path.endsWith('.css')) checkStyleFile(relativePath, source, failures)
    else checkSourceFile(relativePath, source, failures)
  }
  return failures
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const failures = checkDesignScale(root)
  if (failures.length > 0) {
    console.error(`design scale check failed (${failures.length}):`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
  } else {
    console.log(
      `design scale check passed (${TEXT_SCALE.length} type steps, ${RADIUS_SCALE.length} radius steps, 4px spacing grid across ${SCAN_DIR})`,
    )
  }
}
