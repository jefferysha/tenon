/**
 * doctor 的平台支持检查（P0-6）。受支持的是 macOS、Linux 与 WSL：hooks 与安装脚本是 bash，测试服务的启停走 /bin/sh。
 * 原生 Windows（含 Git Bash / MSYS，Node 在它们里都报 win32）不在其中——直接红灯并指向 WSL，
 * 而不是等到某个 hook 静默不生效。其余没有验证过的类 Unix 平台只给黄灯，不拦。
 */
import { readFileSync } from 'node:fs'
import type { DoctorPlatform, DoctorProbes } from '../deps.js'
import { green, red, yellow, type DoctorCheck } from './doctor-check.js'

const INSTALLATION_DOC = 'docs/usage/installation.md（Supported platforms / 支持的平台）'

export interface PlatformInputs {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  /** `/proc/version` 的内容；读不到（非 Linux、被隔离）为 undefined。 */
  readonly procVersion: () => string | undefined
}

/**
 * WSL 有两个独立信号：WSL 1/2 的发行版里 WSL_DISTRO_NAME 恒被设置；内核版本串（/proc/version）带 "microsoft"。
 * 任一命中即认定；只在 linux 上有意义。
 */
export function detectPlatform(input: PlatformInputs): DoctorPlatform {
  if (input.platform !== 'linux') return { os: input.platform, wsl: false }
  const distro = input.env.WSL_DISTRO_NAME
  if (distro !== undefined && distro !== '') return { os: 'linux', wsl: true }
  return { os: 'linux', wsl: /microsoft/iu.test(input.procVersion() ?? '') }
}

export function readProcVersion(): string | undefined {
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch {
    return undefined
  }
}

export function checkPlatform(p: DoctorProbes): DoctorCheck {
  if (p.platform === undefined) {
    return red('env:platform', '平台探针未装配（main.ts 集成缺口，无法确认当前平台受支持）', '排除探针环境问题后重跑 tenon doctor')
  }
  const { os, wsl } = p.platform()
  if (os === 'win32') {
    return red(
      'env:platform',
      '原生 Windows 不受支持：hooks 与安装脚本是 bash，测试服务的启停走 /bin/sh；三门拦截与测试服务在这里不保证生效',
      `改在 WSL 2 里安装并运行 Tenon（管理员 PowerShell：wsl --install，之后全部在 WSL 终端里操作，项目也放在 WSL 的文件系统里）；见 ${INSTALLATION_DOC}`,
    )
  }
  if (os === 'linux') return green('env:platform', wsl ? 'WSL（Linux）：受支持' : 'Linux：受支持')
  if (os === 'darwin') return green('env:platform', 'macOS：受支持')
  return yellow(
    'env:platform',
    `${os} 没有被验证过：受支持的是 macOS、Linux 与 WSL；hooks 的 bash 与 /bin/sh 依赖能否满足取决于本机`,
    `如遇 hook 或测试服务异常，改用受支持的平台；见 ${INSTALLATION_DOC}`,
  )
}
