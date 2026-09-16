/**
 * 设计体系的 Node 读取端口：把仓库根下的相对路径读成文本，越界路径与非普通文件按缺失处理。
 */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import type { DesignFileReader } from '../design-system/check.js'

const MAX_BYTES = 2 * 1024 * 1024

function insideRoot(root: string, relativePath: string): string | null {
  if (isAbsolute(relativePath) || normalize(relativePath).startsWith('..')) return null
  const path = resolve(join(root, relativePath))
  return path.startsWith(resolve(root)) ? path : null
}

export function createDesignFileReader(repoRoot: string): DesignFileReader {
  return {
    read: (relativePath) => {
      const path = insideRoot(repoRoot, relativePath)
      if (path === null) return null
      try {
        const info = statSync(path)
        if (!info.isFile() || info.size > MAX_BYTES) return null
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
  }
}
