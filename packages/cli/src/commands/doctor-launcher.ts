import type { DoctorProbes } from '../deps.js'
import { green, yellow, type DoctorCheck } from './doctor-check.js'

const ID = 'runtime:launcher'

/**
 * v0.2.0 launchers pin the device number of the Node binary and its directories. macOS assigns new device
 * numbers at every restart, so those launchers stop working after one; the active release rewrites them on
 * its own, and this check shows the ones it has not (yet) been able to.
 */
export async function checkStableLauncher(p: DoctorProbes): Promise<DoctorCheck> {
  if (p.stableLauncherFormat === undefined) throw new Error('stableLauncherFormat 探针未装配')
  switch (await p.stableLauncherFormat()) {
    case 'legacy':
      return yellow(
        ID,
        '稳定 launcher 仍是 v0.2.0 的设备号钉死格式——macOS 重启后每条 tenon 命令与 hook 会被锁住',
        '运行 tenon setup --claude 或 tenon setup --codex 重写为重启安全格式（再次运行任意 tenon 命令/新开会话也会自动修复）',
      )
    case 'current':
      return green(ID, '稳定 launcher 为重启安全格式（不含设备号）')
    case 'absent':
      return green(ID, '未安装稳定 launcher，无 Node 身份钉可漂移')
    case 'unmanaged':
      return green(ID, '稳定 launcher 不是 Tenon 生成的文件，不检查也不改动')
  }
}
