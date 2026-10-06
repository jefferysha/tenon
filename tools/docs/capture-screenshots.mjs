#!/usr/bin/env node
/**
 * 重拍文档里的四张 Dashboard 截图（docs-site/public/images/dashboard-*.webp，README 与 docs/usage 引用）。
 *
 * 数据来自 Dashboard e2e 的种子（e2e/dashboard/support/serve.mjs：隔离 HOME / TENON_RUNTIME_HOME、
 * 真实 CLI 播种的演示项目与沙箱项目，身份固定为 e2e@tenon.test），不读也不写开发机的 Tenon 状态。
 * 本脚本只做三件事：拉起种子服务、用 Chromium 逐页拍照、把照片缩成 WebP 写回文档图目录；退出时
 * 无论成败都停掉服务并删掉临时根。
 *
 * 画面约定：视口 1440×900（CSS 像素）、2 倍像素比拍摄，缩到 1280×800 再编码；亮色主题、中文界面
 * （README.md 是主 README）；系统要求减少动态效果，所以 Signal 画布停在静态高亮，每次得到同一帧。
 * 临时根建在 /tmp 下的短路径里，项目页左栏与「接管命令」里露出的路径只有合成的目录名，
 * 不带开发机的 /var/folders 哈希；拍照前再扫一遍页面源码，出现主目录、用户名或 /var/folders 就失败。
 *
 * 用法：npm run build 之后 node tools/docs/capture-screenshots.mjs
 *   --out <目录>          WebP 写到哪里（默认 docs-site/public/images）
 *   --preview-dir <目录>  同时把缩放后的 PNG 预览写到这里（评审用，不入库）
 *   --max-kib <数>        单张 WebP 的体积上限（默认 75）；编码取不超过上限的最高质量
 *   --only <文件名>       只拍一张，如 dashboard-overview.webp
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
// 落定判据与 Dashboard e2e 的 settled() 是同一份实现（纯 ESM，不依赖 TypeScript）。
import { settlePage } from '../../e2e/dashboard/support/settle.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SERVE = join(REPO_ROOT, 'e2e', 'dashboard', 'support', 'serve.mjs')
const STATE_FILE = join(REPO_ROOT, 'test-results', 'dashboard-e2e-server', 'server.json')
const REQUIRED_BUILD = [
  'packages/cli/dist/tenon.mjs',
  'packages/server/dist/dashboard.mjs',
  'packages/dashboard-app/dist/index.html',
]

const VIEWPORT = { width: 1440, height: 900 }
const SCALE = 2
const OUTPUT = { width: 1280, height: 800 }
const SERVER_READY_TIMEOUT_MS = 120_000
const SERVER_STOP_TIMEOUT_MS = 30_000
const CHANGE = 'add-login'

/** 四张图各自的页面与「画好了」的判定。URL 参数与 e2e 的 openView 一致。 */
const SHOTS = [
  {
    file: 'dashboard-overview.webp',
    describe: '工作台 · 所有项目：项目、任务状态与选中任务的下一步',
    query: () => ({ view: 'workspace' }),
    ready: async (page) => {
      const card = page.getByTestId(`task-card-${CHANGE}`)
      await page.getByTestId('task-card-sandbox-change').waitFor()
      await card.waitFor()
      // 列表按最近更新排序、默认选中第一项，两个种子任务谁在前不固定：固定选演示项目的任务。
      const title = page.getByTestId('task-detail-title')
      if ((await title.textContent()) !== CHANGE) await card.click()
      await title.filter({ hasText: CHANGE }).waitFor()
    },
  },
  {
    file: 'dashboard-progress.webp',
    describe: '工作台 · 演示项目的任务，验证阶段：下一步、阶段进度、技能 / 测试 / 评审者',
    query: (state) => ({ view: 'workspace', root: state.project, change: CHANGE, step: 'verify' }),
    ready: async (page) => {
      await page.getByTestId('task-detail-title').filter({ hasText: CHANGE }).waitFor()
      await page.getByTestId('orchestration-stage').waitFor()
      await page.getByTestId('task-gate-row').waitFor()
    },
  },
  {
    file: 'dashboard-workflow-editor.webp',
    describe: '工作流 · 后端轨道的验证阶段：轨道、阶段栏、输入与技能编排',
    query: () => ({ view: 'workflow', wf: 'default', track: 'backend', step: 'verify' }),
    ready: async (page) => {
      await page.getByTestId('workflow-nav').waitFor()
      await page.getByTestId('wb-track-backend').waitFor()
      await page.getByTestId('orchestration-stage').waitFor()
    },
  },
  {
    file: 'dashboard-workbench.webp',
    describe: '工作流 · 后端轨道的总览画布：七阶段 DAG 与静态高亮的 Signal',
    query: () => ({ view: 'workflow', wf: 'default', track: 'backend', step: ':overview' }),
    ready: async (page) => {
      const overview = page.getByTestId('orchestration-overview')
      await overview.waitFor()
      await page.getByTestId('orch-start').waitFor()
      await page.waitForFunction(() => document.querySelector('[data-testid="orchestration-overview"]')?.getAttribute('data-signal') === 'still')
      // 总览默认缩放 0.85，运行时量完画布才落定。
      await page.waitForFunction(() => {
        const viewport = document.querySelector('.react-flow__viewport')
        return viewport !== null && Math.abs(new DOMMatrix(getComputedStyle(viewport).transform).a - 0.85) < 0.01
      })
    },
  },
]

function parseArgs(argv) {
  const options = {
    out: join(REPO_ROOT, 'docs-site', 'public', 'images'),
    previewDir: null,
    maxBytes: 75 * 1024,
    only: null,
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个取值`)
    if (flag === '--out') options.out = resolve(value)
    else if (flag === '--preview-dir') options.previewDir = resolve(value)
    else if (flag === '--max-kib') options.maxBytes = Math.round(Number(value) * 1024)
    else if (flag === '--only') options.only = value
    else throw new Error(`未知参数 ${flag}`)
  }
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 1024) throw new Error('--max-kib 必须是不小于 1 的数字')
  if (options.only !== null && !SHOTS.some((shot) => shot.file === options.only)) {
    throw new Error(`--only 必须是 ${SHOTS.map((shot) => shot.file).join(' / ')} 之一`)
  }
  return options
}

/** 种子服务的临时根建在短而合成的路径下：POSIX 用 /tmp（macOS 上 realpath 是 /private/tmp），Windows 用系统临时目录。 */
function createTempParent() {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  return realpathSync(mkdtempSync(join(base, 'tenon-docs-shots-')))
}

/** 起 serve.mjs 并等到它打印就绪行；返回子进程与它写下的状态（地址、种子项目路径、会话 cookie）。 */
async function startSeededServer(tempParent) {
  const child = spawn(process.execPath, [SERVE], {
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: tempParent },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stderr.on('data', (chunk) => { output += chunk })
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`种子服务 ${SERVER_READY_TIMEOUT_MS}ms 内没有就绪\n${output}`)), SERVER_READY_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('dashboard-e2e ready ')) { clearTimeout(timer); resolveReady() }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`种子服务提前退出（${code}）\n${output}`)) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
  return { child, state: JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
}

/** SIGTERM 让 serve.mjs 先杀 dashboard 进程组再删它的临时根；超时才 SIGKILL。 */
async function stopSeededServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), SERVER_STOP_TIMEOUT_MS)
  await exited
  clearTimeout(timer)
}

/** 页面源码里出现开发机的主目录、用户名、/var/folders 或 e2e 身份之外的邮箱就失败：截图里不得带个人信息。 */
async function assertNoPersonalData(page, label) {
  const html = await page.evaluate(() => document.documentElement.outerHTML)
  const forbidden = [homedir(), userInfo().username, '/var/folders', '/Users/', '/home/'].filter((value) => value.length >= 3)
  for (const value of forbidden) {
    if (html.includes(value)) throw new Error(`${label}：页面源码含有 ${JSON.stringify(value)}，不能拍`)
  }
  const emails = (html.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).filter((email) => email !== 'e2e@tenon.test')
  if (emails.length > 0) throw new Error(`${label}：页面源码含有邮箱 ${emails.join(', ')}，不能拍`)
}

/**
 * 在一个空白页里用 Chromium 的画布缩放并编码：2 倍的 PNG 缩到输出尺寸，再二分质量取「不超过体积上限的最高质量」。
 * 返回 WebP 与缩放后的 PNG（预览用）。
 */
async function encode(helper, png, maxBytes) {
  const result = await helper.evaluate(async ({ pngBase64, width, height, limit }) => {
    const toBase64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      return btoa(binary)
    }
    const source = await createImageBitmap(await (await fetch(`data:image/png;base64,${pngBase64}`)).blob())
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, width, height)
    let low = 0.5
    let high = 0.98
    let best = null
    for (let step = 0; step < 8; step += 1) {
      const quality = (low + high) / 2
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
      if (blob.size <= limit) { best = { blob, quality }; low = quality } else high = quality
    }
    if (best === null) return null
    return {
      webp: await toBase64(best.blob),
      quality: best.quality,
      png: await toBase64(await canvas.convertToBlob({ type: 'image/png' })),
    }
  }, { pngBase64: png.toString('base64'), width: OUTPUT.width, height: OUTPUT.height, limit: maxBytes })
  if (result === null) throw new Error(`质量 0.5 编码出来仍超过 ${maxBytes} 字节`)
  return { webp: Buffer.from(result.webp, 'base64'), quality: result.quality, png: Buffer.from(result.png, 'base64') }
}

function assertWebp(buffer, file) {
  const ok = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!ok) throw new Error(`${file} 不是 WebP`)
}

/** 拍一张：打开页面、等它画好并落定、查个人信息、截图、缩放编码、写文件。 */
async function shoot({ page, helper, state, shot, options }) {
  const query = new URLSearchParams(shot.query(state))
  await page.goto(`${state.url}/?${query.toString()}`)
  await shot.ready(page)
  // 鼠标移出画面：点选之后停在卡片上会留下悬停样式。
  await page.mouse.move(0, 0)
  await settlePage(page)
  // 快照在加载后还会刷新一两次，刷新会重置详情的页签与选中项：落定后再确认一遍画面还是想拍的那一页。
  await page.waitForTimeout(600)
  await shot.ready(page)
  await settlePage(page)
  const theme = await page.evaluate(() => `${document.documentElement.dataset.theme}/${document.documentElement.lang}`)
  if (theme !== 'light/zh') throw new Error(`${shot.file}：主题 / 语言是 ${theme}，应为 light/zh`)
  await assertNoPersonalData(page, shot.file)
  const png = await page.screenshot({ type: 'png' })
  const encoded = await encode(helper, png, options.maxBytes)
  assertWebp(encoded.webp, shot.file)
  writeFileSync(join(options.out, shot.file), encoded.webp)
  if (options.previewDir !== null) writeFileSync(join(options.previewDir, shot.file.replace(/\.webp$/, '.png')), encoded.png)
  process.stdout.write(`${shot.file}  ${OUTPUT.width}x${OUTPUT.height}  ${statSync(join(options.out, shot.file)).size} B  quality ${encoded.quality.toFixed(3)}  ${shot.describe}\n`)
}

async function capture(options) {
  for (const path of REQUIRED_BUILD) {
    if (!existsSync(join(REPO_ROOT, path))) throw new Error(`缺少 ${path}：先运行 npm run build`)
  }
  mkdirSync(options.out, { recursive: true })
  if (options.previewDir !== null) mkdirSync(options.previewDir, { recursive: true })
  const tempParent = createTempParent()
  let server = null
  let browser = null
  try {
    server = await startSeededServer(tempParent)
    const { state } = server
    browser = await chromium.launch()
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    await context.addCookies([{ name: state.session.name, value: state.session.value, url: state.url, httpOnly: true, sameSite: 'Strict' }])
    await context.addInitScript(() => {
      try {
        localStorage.setItem('tenon-dashboard-theme', 'light')
        localStorage.setItem('tenon-dashboard-lang', 'zh')
      } catch {
        /* 存储不可用时界面回落到默认值，拍照前的主题断言会发现 */
      }
    })
    const page = await context.newPage()
    const helper = await context.newPage()
    for (const shot of SHOTS.filter((candidate) => options.only === null || candidate.file === options.only)) {
      try {
        await shoot({ page, helper, state, shot, options })
      } catch (error) {
        // 失败时留下当时的画面，方便看是哪一步没等到。
        if (options.previewDir !== null) await page.screenshot({ path: join(options.previewDir, `${shot.file}.failure.png`) }).catch(() => {})
        throw error
      }
    }
  } finally {
    if (browser !== null) await browser.close()
    if (server !== null) await stopSeededServer(server.child)
    rmSync(tempParent, { recursive: true, force: true })
  }
}

try {
  await capture(parseArgs(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`capture-screenshots 失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
