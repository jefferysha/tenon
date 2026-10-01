/** 测试用：把 createTarGz 写出的 `.tar.gz` 读回成 { 路径 → 内容 }。只认 ustar 的普通文件。 */
import { gunzipSync } from 'node:zlib'

export interface UnpackedEntry {
  readonly name: string
  readonly content: Buffer
  readonly mode: number
  readonly mtime: number
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8')
}

export function unpackTarGz(archive: Buffer): readonly UnpackedEntry[] {
  const tar = gunzipSync(archive)
  const entries: UnpackedEntry[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const name = field(block, 0, 100)
    const size = Number.parseInt(field(block, 124, 12), 8)
    let sum = 0
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0)
    if (sum !== Number.parseInt(field(block, 148, 8).trim(), 8)) throw new Error(`tar header checksum mismatch for ${name}`)
    if (field(block, 257, 6) !== 'ustar') throw new Error(`not a ustar entry: ${name}`)
    entries.push({
      name,
      content: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
      mode: Number.parseInt(field(block, 100, 8), 8),
      mtime: Number.parseInt(field(block, 136, 12), 8),
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

export function textOf(entries: readonly UnpackedEntry[]): string {
  return entries.map((entry) => `--- ${entry.name}\n${entry.content.toString('utf8')}`).join('\n')
}
