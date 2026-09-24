/**
 * 本机原生「选择文件夹」对话框：server 与浏览器同在一台机器上，由 server 调起系统对话框并把绝对路径交回页面。
 *
 * - macOS：osascript `choose folder`；提示语与起始目录经 `on run argv` 传入，不进 AppleScript 源码。
 * - Windows：PowerShell `FolderBrowserDialog`；提示语与起始目录经环境变量传入，不进脚本文本。
 * - Linux：先 zenity，再 kdialog；没有 DISPLAY / WAYLAND_DISPLAY 视为无图形界面。
 *
 * 全部用 execFile 传参数组，不经 shell。用户取消 → cancelled；命令不存在、无图形界面、异常退出 → unavailable，
 * 页面据此改用页面内目录浏览器。同一时刻只允许一个对话框（busy），单次最长等待 5 分钟（超时按取消处理）。
 */
import { execFile } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export type FolderPick =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly unavailable: true }
  | { readonly ok: false; readonly busy: true }

export interface PickerCommand {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** 表示「用户取消」的退出码。 */
  readonly cancelCode: number
  /** stderr 含此片段时也按取消处理（osascript 取消是 -128）。 */
  readonly cancelText?: string
}

export interface ProcessOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly notFound: boolean
  readonly timedOut: boolean
}

export type ProcessRunner = (command: PickerCommand, timeoutMs: number) => Promise<ProcessOutcome>

export interface FolderPickRequest { readonly title: string; readonly startDir: string | null }

export interface FolderChooser { choose(request: FolderPickRequest): Promise<FolderPick> }

export const PICKER_TIMEOUT_MS = 5 * 60 * 1000

const MAC_SCRIPT_WITH_START = [
  'on run argv',
  'return POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))',
  'end run',
]
const MAC_SCRIPT = ['on run argv', 'return POSIX path of (choose folder with prompt (item 1 of argv))', 'end run']

const WINDOWS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = $env:TENON_PICKER_TITLE',
  '$dialog.ShowNewFolderButton = $true',
  'if ($env:TENON_PICKER_START) { $dialog.SelectedPath = $env:TENON_PICKER_START }',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath); exit 0 }',
  'exit 3',
].join('; ')

/** 按平台给出候选命令（按顺序尝试，命令不存在就换下一个）；没有候选 = 本机不支持原生对话框。 */
export function pickerCommands(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  request: FolderPickRequest,
): PickerCommand[] {
  const { title, startDir } = request
  if (platform === 'darwin') {
    const script = startDir === null ? MAC_SCRIPT : MAC_SCRIPT_WITH_START
    return [{
      file: 'osascript',
      args: [...script.flatMap((line) => ['-e', line]), title, ...(startDir === null ? [] : [startDir])],
      cancelCode: 1,
      cancelText: '-128',
    }]
  }
  if (platform === 'win32') {
    return [{
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT],
      env: { TENON_PICKER_TITLE: title, TENON_PICKER_START: startDir ?? '' },
      cancelCode: 3,
    }]
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return []
  const start = startDir === null ? [] : [`${startDir.replace(/\/+$/u, '')}/`]
  return [
    { file: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`, ...start.map((dir) => `--filename=${dir}`)], cancelCode: 1 },
    { file: 'kdialog', args: ['--getexistingdirectory', ...(startDir === null ? [] : [startDir]), '--title', title], cancelCode: 1 },
  ]
}

/** 对话框输出的路径：去掉换行与结尾斜杠，必须是真实存在的目录（不跟随符号链接）。 */
export function normalizePickedPath(stdout: string): string | null {
  const raw = stdout.replace(/[\r\n]+$/u, '')
  if (raw === '' || raw.includes('\0') || !isAbsolute(raw)) return null
  const trimmed = raw.length > 1 ? raw.replace(/[\\/]+$/u, '') : raw
  const path = resolvePath(trimmed === '' || /^[A-Za-z]:$/u.test(trimmed) ? raw : trimmed)
  try {
    const entry = lstatSync(path)
    return entry.isDirectory() && !entry.isSymbolicLink() ? path : null
  } catch {
    return null
  }
}

export const runPickerProcess: ProcessRunner = (command, timeoutMs) => new Promise((resolve) => {
  execFile(command.file, [...command.args], {
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 64 * 1024,
    windowsHide: false,
    env: command.env === undefined ? process.env : { ...process.env, ...command.env },
  }, (error, stdout, stderr) => {
    if (error === null) {
      resolve({ code: 0, stdout: String(stdout), stderr: String(stderr), notFound: false, timedOut: false })
      return
    }
    const errno = Reflect.get(error, 'code')
    resolve({
      code: typeof errno === 'number' ? errno : -1,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      notFound: errno === 'ENOENT',
      timedOut: error.killed === true || Reflect.get(error, 'signal') === 'SIGTERM',
    })
  })
})

export interface FolderChooserDeps {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly run?: ProcessRunner
  readonly timeoutMs?: number
}

export function createFolderChooser(deps: FolderChooserDeps): FolderChooser {
  const run = deps.run ?? runPickerProcess
  const timeoutMs = deps.timeoutMs ?? PICKER_TIMEOUT_MS
  let open = false
  return {
    async choose(request) {
      if (open) return { ok: false, busy: true }
      open = true
      try {
        for (const command of pickerCommands(deps.platform, deps.env, request)) {
          const outcome = await run(command, timeoutMs)
          if (outcome.notFound) continue
          if (outcome.timedOut) return { ok: false, cancelled: true }
          if (outcome.code === 0) {
            const path = normalizePickedPath(outcome.stdout)
            return path === null ? { ok: false, unavailable: true } : { ok: true, path }
          }
          const cancelled = command.cancelText === undefined
            ? outcome.code === command.cancelCode
            : outcome.code === command.cancelCode && outcome.stderr.includes(command.cancelText)
          return cancelled ? { ok: false, cancelled: true } : { ok: false, unavailable: true }
        }
        return { ok: false, unavailable: true }
      } finally {
        open = false
      }
    },
  }
}
