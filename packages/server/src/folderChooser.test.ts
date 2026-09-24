import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PICKER_TIMEOUT_MS, createFolderChooser, normalizePickedPath, pickerCommands,
  type PickerCommand, type ProcessOutcome, type ProcessRunner,
} from './folderChooser.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-folder-chooser-'))
  dirs.push(dir)
  return dir
}

const HOSTILE = `x" & do shell script "touch /tmp/pwned" & "'; rm -rf / #`
const outcome = (over: Partial<ProcessOutcome>): ProcessOutcome =>
  ({ code: 0, stdout: '', stderr: '', notFound: false, timedOut: false, ...over })

function fakeRunner(script: (command: PickerCommand) => ProcessOutcome | Promise<ProcessOutcome>): ProcessRunner & { calls: { command: PickerCommand; timeoutMs: number }[] } {
  const calls: { command: PickerCommand; timeoutMs: number }[] = []
  const run: ProcessRunner = async (command, timeoutMs) => {
    calls.push({ command, timeoutMs })
    return script(command)
  }
  return Object.assign(run, { calls })
}

describe('pickerCommands：参数数组，标题与起始目录不进脚本文本', () => {
  it('macOS：osascript -e 逐行脚本，标题与起始目录作为 argv 传入', () => {
    const [command, ...rest] = pickerCommands('darwin', {}, { title: HOSTILE, startDir: '/Users/me/code' })
    expect(rest).toEqual([])
    expect(command?.file).toBe('osascript')
    const args = command?.args ?? []
    expect(args.slice(-2)).toEqual([HOSTILE, '/Users/me/code'])
    const script = args.slice(0, -2)
    expect(script.filter((_, index) => index % 2 === 0).every((flag) => flag === '-e')).toBe(true)
    expect(script.join('\n')).toContain('choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))')
    expect(script.join('\n')).not.toContain('pwned')
    expect(command?.cancelText).toBe('-128')
  })

  it('macOS 无起始目录：脚本不引用 item 2', () => {
    const [command] = pickerCommands('darwin', {}, { title: 'Pick', startDir: null })
    expect(command?.args.at(-1)).toBe('Pick')
    expect(command?.args.join('\n')).not.toContain('item 2')
  })

  it('Windows：PowerShell FolderBrowserDialog，标题与起始目录走环境变量', () => {
    const [command] = pickerCommands('win32', {}, { title: HOSTILE, startDir: 'C:\\code' })
    expect(command?.file).toBe('powershell.exe')
    expect(command?.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command'])
    expect(command?.args[4]).toContain('System.Windows.Forms.FolderBrowserDialog')
    expect(command?.args.join(' ')).not.toContain('pwned')
    expect(command?.env).toEqual({ TENON_PICKER_TITLE: HOSTILE, TENON_PICKER_START: 'C:\\code' })
    expect(command?.cancelCode).toBe(3)
  })

  it('Linux：先 zenity 后 kdialog；没有图形界面时没有候选', () => {
    const commands = pickerCommands('linux', { DISPLAY: ':0' }, { title: 'Pick', startDir: '/home/me/' })
    expect(commands.map((command) => [command.file, command.args])).toEqual([
      ['zenity', ['--file-selection', '--directory', '--title=Pick', '--filename=/home/me/']],
      ['kdialog', ['--getexistingdirectory', '/home/me/', '--title', 'Pick']],
    ])
    expect(pickerCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' }, { title: 'Pick', startDir: null })).toHaveLength(2)
    expect(pickerCommands('linux', {}, { title: 'Pick', startDir: null })).toEqual([])
    expect(pickerCommands('freebsd', {}, { title: 'Pick', startDir: null })).toEqual([])
  })
})

describe('normalizePickedPath', () => {
  it('去掉换行与结尾斜杠；只接受真实目录', async () => {
    const dir = await tempDir()
    expect(normalizePickedPath(`${dir}/\n`)).toBe(dir)
    expect(normalizePickedPath('relative/path\n')).toBeNull()
    expect(normalizePickedPath(`${join(dir, 'missing')}\n`)).toBeNull()
    await symlink(dir, join(dir, 'link'))
    expect(normalizePickedPath(join(dir, 'link'))).toBeNull()
    expect(normalizePickedPath('')).toBeNull()
  })
})

describe('createFolderChooser', () => {
  it('选中：返回规范化的绝对路径，超时上限 5 分钟', async () => {
    const dir = await tempDir()
    const run = fakeRunner(() => outcome({ stdout: `${dir}/\n` }))
    const chooser = createFolderChooser({ platform: 'darwin', env: {}, run })
    expect(await chooser.choose({ title: 'Pick', startDir: null })).toEqual({ ok: true, path: dir })
    expect(run.calls[0]?.timeoutMs).toBe(PICKER_TIMEOUT_MS)
  })

  it('macOS 取消（-128）→ cancelled；其他失败（无图形会话）→ unavailable', async () => {
    const cancel = createFolderChooser({ platform: 'darwin', env: {}, run: fakeRunner(() => outcome({ code: 1, stderr: 'execution error: User canceled. (-128)' })) })
    expect(await cancel.choose({ title: 'Pick', startDir: null })).toEqual({ ok: false, cancelled: true })
    const broken = createFolderChooser({ platform: 'darwin', env: {}, run: fakeRunner(() => outcome({ code: 1, stderr: 'execution error: (-1713)' })) })
    expect(await broken.choose({ title: 'Pick', startDir: null })).toEqual({ ok: false, unavailable: true })
  })

  it('Windows 取消退出码 3 → cancelled；超时 → cancelled', async () => {
    const cancel = createFolderChooser({ platform: 'win32', env: {}, run: fakeRunner(() => outcome({ code: 3 })) })
    expect(await cancel.choose({ title: 'Pick', startDir: null })).toEqual({ ok: false, cancelled: true })
    const slow = createFolderChooser({ platform: 'win32', env: {}, run: fakeRunner(() => outcome({ code: -1, timedOut: true })) })
    expect(await slow.choose({ title: 'Pick', startDir: null })).toEqual({ ok: false, cancelled: true })
  })

  it('Linux：zenity 不存在就换 kdialog；都不存在 → unavailable', async () => {
    const dir = await tempDir()
    const fallback = fakeRunner((command) => (command.file === 'zenity' ? outcome({ code: -1, notFound: true }) : outcome({ stdout: `${dir}\n` })))
    const chooser = createFolderChooser({ platform: 'linux', env: { DISPLAY: ':0' }, run: fallback })
    expect(await chooser.choose({ title: 'Pick', startDir: null })).toEqual({ ok: true, path: dir })
    expect(fallback.calls.map((call) => call.command.file)).toEqual(['zenity', 'kdialog'])

    const none = createFolderChooser({ platform: 'linux', env: { DISPLAY: ':0' }, run: fakeRunner(() => outcome({ code: -1, notFound: true })) })
    expect(await none.choose({ title: 'Pick', startDir: null })).toEqual({ ok: false, unavailable: true })
    const headless = fakeRunner(() => outcome({}))
    expect(await createFolderChooser({ platform: 'linux', env: {}, run: headless }).choose({ title: 'Pick', startDir: null }))
      .toEqual({ ok: false, unavailable: true })
    expect(headless.calls).toEqual([])
  })

  it('同一时刻只允许一个对话框：第二次调用 busy，第一次结束后可再开', async () => {
    const dir = await tempDir()
    let release: (value: ProcessOutcome) => void = () => undefined
    const run = fakeRunner(() => new Promise<ProcessOutcome>((resolve) => { release = resolve }))
    const chooser = createFolderChooser({ platform: 'darwin', env: {}, run })
    const first = chooser.choose({ title: 'Pick', startDir: null })
    expect(await chooser.choose({ title: 'Pick', startDir: null })).toEqual({ ok: false, busy: true })
    release(outcome({ stdout: dir }))
    expect(await first).toEqual({ ok: true, path: dir })
    const again = chooser.choose({ title: 'Pick', startDir: null })
    release(outcome({ code: 1, stderr: '(-128)' }))
    expect(await again).toEqual({ ok: false, cancelled: true })
  })
})
