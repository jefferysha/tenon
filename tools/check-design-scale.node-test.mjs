import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkDesignScale, RADIUS_SCALE, TEXT_SCALE } from './check-design-scale.mjs'

const SRC = 'packages/dashboard-app/src'

const SCALE_CSS = `@theme static {
  --text-*: initial;
  --text-micro: 11px;
  --text-caption: 12px;
  --text-body: 13px;
  --text-base: 14px;
  --text-title: 16px;
  --text-section: 20px;
  --text-page: 28px;

  --radius-*: initial;
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-md: var(--radius);
  --radius-lg: 16px;
}
`

async function write(root, relativePath, content) {
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** 干净基线：刻度声明齐全、类名与裸 CSS 都落在刻度上。每条负测只在它之上改一处。 */
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tenon-design-scale-'))
  await write(root, `${SRC}/index.css`, overrides.indexCss ?? SCALE_CSS)
  await write(
    root,
    `${SRC}/view/View.tsx`,
    overrides.tsx ??
      'export const CLS = "rounded-md rounded-full rounded-none rounded-t-lg gap-2 px-3 -mt-1 text-caption text-section"\n',
  )
  await write(
    root,
    `${SRC}/view/view.css`,
    overrides.css ??
      '.row {\n  font-size: var(--text-body);\n  border-radius: var(--radius-sm);\n  gap: 8px;\n  padding: 0 12px 2px;\n  margin: 16px 0 0;\n}\n',
  )
  return root
}

async function failuresFor(overrides) {
  const root = await fixture(overrides)
  try {
    return checkDesignScale(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('刻度内的类名、裸 CSS 与刻度声明构成干净基线', async () => {
  assert.deepEqual(await failuresFor({}), [])
})

test('刻度档位与真源常量一致（改档位要同时改门禁）', () => {
  assert.deepEqual(TEXT_SCALE, ['micro', 'caption', 'body', 'base', 'title', 'section', 'page'])
  assert.deepEqual(RADIUS_SCALE, ['xs', 'sm', 'md', 'lg'])
})

test('字号任意值被拦下', async () => {
  const failures = await failuresFor({ tsx: 'export const CLS = "text-[12.5px]"\n' })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /view\/View\.tsx:1 text-arbitrary: `text-\[12\.5px\]`/u)
})

test('圆角任意值被拦下', async () => {
  const failures = await failuresFor({ tsx: 'export const CLS = "rounded-[7px] rounded-tl-[22px]"\n' })
  assert.equal(failures.length, 2)
  assert.match(failures.join('\n'), /radius-arbitrary: `rounded-\[7px\]`/u)
  assert.match(failures.join('\n'), /radius-arbitrary: `rounded-tl-\[22px\]`/u)
})

test('间距任意值被拦下，含负 margin', async () => {
  const failures = await failuresFor({ tsx: 'export const CLS = "px-[11px] gap-y-[3px] -mt-[5px]"\n' })
  assert.equal(failures.length, 3)
  assert.match(failures.join('\n'), /spacing-arbitrary: `px-\[11px\]`/u)
  assert.match(failures.join('\n'), /spacing-arbitrary: `gap-y-\[3px\]`/u)
  assert.match(failures.join('\n'), /spacing-arbitrary: `-mt-\[5px\]`/u)
})

test('刻度外的退役类名被拦下——它们在 initial 清空后会静默丢样式', async () => {
  const failures = await failuresFor({ tsx: 'export const CLS = "text-xs text-3xl rounded rounded-xl"\n' })
  assert.equal(failures.length, 4)
  assert.match(failures.join('\n'), /text-retired: `text-xs`/u)
  assert.match(failures.join('\n'), /text-retired: `text-3xl`/u)
  assert.match(failures.join('\n'), /radius-retired: `rounded`/u)
  assert.match(failures.join('\n'), /radius-retired: `rounded-xl`/u)
})

test('几何类任意值不在门禁范围内：定位偏移与尺寸对齐的是几何而非节奏', async () => {
  const failures = await failuresFor({
    tsx: 'export const CLS = "top-[3px] -left-[47px] w-[26px] min-h-[360px] leading-[1.55]"\n',
  })
  assert.deepEqual(failures, [])
})

test('calc / env / var 的间距不算硬编码刻度', async () => {
  const failures = await failuresFor({
    tsx: 'export const CLS = "pb-[calc(88px+env(safe-area-inset-bottom))] gap-[var(--x)] my-[8vh]"\n',
  })
  assert.deepEqual(failures, [])
})

test('注释里的反例不会被误报', async () => {
  const failures = await failuresFor({
    tsx: '/* 迁移说明：text-[11px] 与 rounded-[9px] 已退役 */\n// gap-[7px] 同理\nexport const CLS = "text-micro"\n',
  })
  assert.deepEqual(failures, [])
})

test('裸 CSS 重新硬编码字号 / 圆角 / 非栅格间距都会红', async () => {
  const failures = await failuresFor({
    css: '.row {\n  font-size: 11px;\n  border-radius: 9px;\n  gap: 5px;\n  margin-top: 14px;\n}\n',
  })
  assert.equal(failures.length, 4)
  assert.match(failures.join('\n'), /css-font-size: `11px`/u)
  assert.match(failures.join('\n'), /css-radius: `9px`/u)
  assert.match(failures.join('\n'), /css-spacing: `gap: 5px`/u)
  assert.match(failures.join('\n'), /css-spacing: `margin-top: 14px`/u)
})

test('药丸 / 圆点 / 继承等非刻度圆角仍然合法', async () => {
  const failures = await failuresFor({
    css: '.pill {\n  border-radius: 999px;\n}\n.dot {\n  border-radius: 50%;\n}\n.bar {\n  border-radius: inherit;\n}\n.card {\n  border-radius: var(--radius) var(--radius) 0 0;\n}\n',
  })
  assert.deepEqual(failures, [])
})

test('scale-exempt 必须写原因：写了放行，空理由仍然红', async () => {
  const withReason = await failuresFor({
    css: '.dot {\n  margin-top: 6px; /* scale-exempt: 8px 圆点与首行文字光学对齐 */\n}\n',
  })
  assert.deepEqual(withReason, [])
  const withoutReason = await failuresFor({ css: '.dot {\n  margin-top: 6px; /* scale-exempt: */\n}\n' })
  assert.equal(withoutReason.length, 1)
  assert.match(withoutReason[0], /css-spacing: `margin-top: 6px`/u)
})

test('刻度真源被加档 / 缺档 / 少了 initial 清空都会红', async () => {
  const added = await failuresFor({ indexCss: SCALE_CSS.replace('  --text-page: 28px;', '  --text-hero: 40px;\n  --text-page: 28px;') })
  assert.equal(added.length, 1)
  assert.match(added[0], /--text-\* 多出档位 hero/u)

  const missing = await failuresFor({ indexCss: SCALE_CSS.replace('  --radius-lg: 16px;\n', '') })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /--radius-\* 缺档位 lg/u)

  const unbounded = await failuresFor({ indexCss: SCALE_CSS.replace('  --text-*: initial;\n', '') })
  assert.equal(unbounded.length, 1)
  assert.match(unbounded[0], /缺 `--text-\*: initial`/u)

  const absent = await failuresFor({ indexCss: '/* no theme block */\n' })
  assert.match(absent.join('\n'), /找不到 @theme static 刻度段/u)
})
