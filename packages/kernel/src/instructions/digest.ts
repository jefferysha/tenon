import { sha256Hex } from '../sha256.js'

export const ABSENT_DIGEST = 'absent'

/** 指令文件 / 模板文件内容摘要：缺失为 `absent`，否则 `sha256:<hex>`。每次写入都带客户端最后看到的摘要。 */
export function instructionDigest(bytes: Uint8Array | null): string {
  return bytes === null ? ABSENT_DIGEST : `sha256:${sha256Hex(bytes)}`
}
