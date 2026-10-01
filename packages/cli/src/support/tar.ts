/**
 * 最小的 ustar 写入器 + gzip：支持包只需要若干个短名文本文件，不值得为此引依赖或依赖系统 `tar`。
 * 输出是标准 `.tar.gz`，`tar -xzf`、Windows 11 资源管理器、Python tarfile 都能直接解开。
 */
import { gzipSync } from 'node:zlib'

export interface TarEntry {
  /** 归档内的相对路径，POSIX 分隔符，≤ 100 字节（支持包的文件名都很短）。 */
  readonly name: string
  readonly content: Buffer
  /** Unix 秒。 */
  readonly mtime: number
}

const BLOCK = 512

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header(entry: TarEntry): Buffer {
  const name = Buffer.from(entry.name, 'utf8')
  if (name.length === 0 || name.length > 100) throw new Error(`tar entry name must be 1-100 bytes: ${entry.name}`)
  if (entry.name.startsWith('/') || entry.name.split('/').includes('..')) {
    throw new Error(`tar entry name must stay inside the archive: ${entry.name}`)
  }
  const block = Buffer.alloc(BLOCK)
  name.copy(block, 0)
  block.write(octal(0o600, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii')
  block.write(octal(0, 8), 116, 'ascii')
  block.write(octal(entry.content.length, 12), 124, 'ascii')
  block.write(octal(entry.mtime, 12), 136, 'ascii')
  block.write('        ', 148, 'ascii')
  block.write('0', 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

export function createTarGz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    parts.push(header(entry), entry.content)
    const pad = (BLOCK - (entry.content.length % BLOCK)) % BLOCK
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(parts), { level: 9 })
}
