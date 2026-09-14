import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const KEY_BYTES = 32

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isExisting(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

/**
 * Read the per-install key through a no-follow descriptor and require an owner-only regular file of
 * the exact key length.  A symlink, group/world-readable file or truncated key is rejected rather
 * than silently regenerated, because regeneration would make earlier digests unlinkable.
 */
async function readKey(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== KEY_BYTES) throw new Error('observation identity key must be a regular 32-byte file')
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) throw new Error('observation identity key must be owner-only')
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('observation identity key must be owned by the current user')
      }
    }
    const key = Buffer.alloc(KEY_BYTES)
    const { bytesRead } = await handle.read(key, 0, KEY_BYTES, 0)
    if (bytesRead !== KEY_BYTES) throw new Error('observation identity key is truncated')
    return key
  } finally {
    await handle.close()
  }
}

/** Exclusive temp file + no-replace `link()`: concurrent creators converge on the first published key. */
async function createKey(path: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const dirStat = await lstat(dir)
  if (!dirStat.isDirectory()) throw new Error('observation identity key directory must be a real directory')
  const tmp = `${path}.tmp-${randomUUID()}`
  try {
    const handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.write(randomBytes(KEY_BYTES), 0, KEY_BYTES, 0)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(tmp, path)
    } catch (error) {
      if (!isExisting(error)) throw error
    }
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

export async function loadOrCreateObservationKey(path: string): Promise<Buffer> {
  try {
    return await readKey(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await createKey(path)
  return readKey(path)
}

/** Keyed digest: pid/host/session values cannot be confirmed by brute force without the local key. */
export function observationIdentityDigest(key: Buffer, identity: string): string {
  return `hmac-sha256:${createHmac('sha256', key).update(identity, 'utf8').digest('hex')}`
}
