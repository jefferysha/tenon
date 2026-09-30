/**
 * Opens a URL in the user's default browser without shell interpolation.
 *
 * Only the Dashboard server calls this, and only with a fresh one-time login URL: the caller of
 * `POST /api/session/open` never sees that URL, so handing it to the OS opener is the whole
 * delivery channel.  `xdg-open` reports "no browser" through a quick non-zero exit, so a short
 * grace window turns that into `false`; a process still running after it is a hand-off in progress.
 */
import { spawn } from 'node:child_process'

const EXIT_GRACE_MS = 1_500

export function openerCommand(url: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] }
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/c', 'start', '', url] }
  return { file: 'xdg-open', args: [url] }
}

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const command = openerCommand(url, platform)
  return new Promise((resolveOpened) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (opened: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolveOpened(opened)
    }
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' })
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
    child.once('spawn', () => {
      child.unref()
      timer = setTimeout(() => finish(true), EXIT_GRACE_MS)
      timer.unref?.()
    })
  })
}
