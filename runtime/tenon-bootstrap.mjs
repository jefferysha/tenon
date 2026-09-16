#!/usr/bin/env node
/*
 * Minimal managed-runtime bootstrap.
 *
 * This file deliberately has no imports from the plugin payload.  Host hooks and the stable CLI
 * launcher execute a copied slot of this file, which selects a verified payload release from local
 * runtime state.  Keep the accepted recovery grammar deliberately narrow: it is a repair
 * capability, not a workflow-policy bypass.
 */
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile, appendFile, readdir, stat, utimes } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

const RELEASE_ID = /^sha256-[a-f0-9]{64}$/
const PAYLOAD_DIGEST = /^[a-f0-9]{64}$/
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const GIT_COMMIT = /^[a-f0-9]{40}$/
const RELEASE_HOSTS = new Set(['codex', 'claude', 'adapter', 'manual'])

function safeRoot(value) {
  return typeof value === 'string' && value.trim() !== '' && isAbsolute(value.trim()) ? resolve(value.trim()) : null
}

// A native host loads SKILL.md assets from its own immutable plugin cache, while this bootstrap
// deliberately executes hooks from the separately verified managed release. Capture the host
// provenance before childEnv pins PLUGIN_ROOT to the release, so evidence hooks can attest to the
// exact asset the host actually read without making that cache executable runtime state.
const HOST_PLUGIN_ROOT = safeRoot(process.env.PLUGIN_ROOT) ?? safeRoot(process.env.CLAUDE_PLUGIN_ROOT)

function safePathSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null
}

async function codexPluginIdentity(root) {
  try {
    const plugin = JSON.parse(await readFile(join(root, '.codex-plugin', 'plugin.json'), 'utf8'))
    const marketplace = JSON.parse(await readFile(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'))
    if (!isRecord(plugin) || !isRecord(marketplace) || !Array.isArray(marketplace.plugins)) return null
    const pluginName = safePathSegment(plugin.name)
    const pluginVersion = safePathSegment(plugin.version)
    const marketplaceName = safePathSegment(marketplace.name)
    if (pluginName === null || pluginVersion === null || marketplaceName === null) return null
    const declared = marketplace.plugins.some((entry) => isRecord(entry) && entry.name === pluginName)
    if (!declared) return null
    return { pluginName, pluginVersion, marketplaceName }
  } catch {
    return null
  }
}

async function ordinaryDirectoryChain(base, candidate) {
  const rel = relative(base, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  let current = base
  for (const part of ['', ...rel.split(sep).filter((entry) => entry !== '')]) {
    if (part !== '') current = join(current, part)
    try {
      const item = await lstat(current)
      if (!item.isDirectory() || item.isSymbolicLink()) return false
    } catch {
      return false
    }
  }
  return true
}

async function normalDirectory(path) {
  try {
    const item = await lstat(path)
    return item.isDirectory() && !item.isSymbolicLink()
  } catch {
    return false
  }
}

async function verifiedCodexPluginCacheRoot(candidate, payloadIdentity) {
  const root = safeRoot(candidate)
  if (root === null) return null
  const codexHome = safeRoot(process.env.CODEX_HOME) ?? join(homedir(), '.codex')
  const cacheBase = join(codexHome, 'plugins', 'cache')
  const parts = relative(cacheBase, root).split(sep)
  if (parts.length !== 3 || parts.some((part) => safePathSegment(part) === null)) return null
  if (!await ordinaryDirectoryChain(codexHome, root)) return null
  const identity = await codexPluginIdentity(root)
  if (identity === null
    || identity.marketplaceName !== parts[0]
    || identity.pluginName !== parts[1]
    || identity.pluginVersion !== parts[2]
    || identity.marketplaceName !== payloadIdentity.marketplaceName
    || identity.pluginName !== payloadIdentity.pluginName) return null
  for (const required of [
    join(root, '.codex-plugin', 'plugin.json'),
    join(root, '.agents', 'plugins', 'marketplace.json'),
    join(root, 'hooks', 'codex-skill-receipt.sh'),
    join(root, 'packages', 'cli', 'dist', 'tenon.mjs'),
    join(root, 'skills', 'tenon', 'SKILL.md'),
  ]) {
    if (!await normalFile(required)) return null
  }
  if (!await normalDirectory(join(root, 'skills'))) return null
  return root
}

// The managed payload and the native Codex cache are separate trust identities. A host can already
// be reading a newer immutable cache while the stable runtime still executes an older verified
// release. Preserve that exact cache only after independently validating its ordinary cache layout,
// manifests, and required assets; otherwise use a separately validated payload-derived cache.
async function codexPluginCacheRoot(payload) {
  const payloadIdentity = await codexPluginIdentity(payload)
  if (payloadIdentity === null) return null
  const inherited = await verifiedCodexPluginCacheRoot(process.env.TENON_CODEX_PLUGIN_ROOT, payloadIdentity)
  if (inherited !== null) return inherited
  const codexHome = safeRoot(process.env.CODEX_HOME) ?? join(homedir(), '.codex')
  return await verifiedCodexPluginCacheRoot(join(
    codexHome,
    'plugins',
    'cache',
    payloadIdentity.marketplaceName,
    payloadIdentity.pluginName,
    payloadIdentity.pluginVersion,
  ), payloadIdentity)
}

function runtimePaths() {
  let contract
  try {
    contract = JSON.parse(process.env.TENON_RUNTIME_ROOTS ?? '')
  } catch {
    throw new Error('TENON_RUNTIME_ROOTS is missing or invalid; reinstall the Tenon stable launcher')
  }
  const dataRoot = isRecord(contract) && contract.version === 1 ? safeRoot(contract.dataRoot) : null
  const stateRoot = isRecord(contract) && contract.version === 1 ? safeRoot(contract.stateRoot) : null
  const configRoot = isRecord(contract) && contract.version === 1 ? safeRoot(contract.configRoot) : null
  if (dataRoot === null || stateRoot === null || configRoot === null) {
    throw new Error('TENON_RUNTIME_ROOTS does not contain absolute version-1 roots')
  }
  return {
    dataRoot,
    stateRoot,
    configRoot,
    releasesRoot: join(dataRoot, 'releases'),
    bootstrapRoot: join(dataRoot, 'bootstrap'),
    selectionPath: join(stateRoot, 'selection.json'),
    auditPath: join(stateRoot, 'audit.jsonl'),
    managedTransactionRoot: join(stateRoot, 'managed-release-transaction'),
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSelection(value) {
  if (!isRecord(value) || value.version !== 1 || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (value.activeRelease !== null && !RELEASE_ID.test(value.activeRelease))
    || (value.previousRelease !== null && !RELEASE_ID.test(value.previousRelease))
    || typeof value.updatedAt !== 'string' || value.updatedAt === '') return null
  return value
}

async function readSelection(paths) {
  try {
    const parsed = parseSelection(JSON.parse(await readFile(paths.selectionPath, 'utf8')))
    return parsed === null ? null : parsed
  } catch {
    return null
  }
}

async function normalFile(path) {
  try {
    const item = await lstat(path)
    return item.isFile() && !item.isSymbolicLink()
  } catch {
    return false
  }
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function releaseSource(value) {
  if (!isRecord(value) || !exactKeys(value, ['host', 'pluginVersion'])
    || !RELEASE_HOSTS.has(value.host)
    || typeof value.pluginVersion !== 'string' || value.pluginVersion.trim() === '') return null
  return { host: value.host, pluginVersion: value.pluginVersion }
}

function stableReleaseTarget(value) {
  if (!isRecord(value) || !exactKeys(value, ['commit', 'tag', 'version'])
    || typeof value.version !== 'string' || !STABLE_VERSION.test(value.version)
    || value.tag !== `v${value.version}`
    || typeof value.commit !== 'string' || !GIT_COMMIT.test(value.commit)) return null
  return { version: value.version, tag: value.tag, commit: value.commit }
}

function hashFrame(hash, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  hash.update(`${bytes.byteLength}:`, 'utf8')
  hash.update(bytes)
}

function runtimeReleaseIdV2(payloadDigest, source, stableTarget) {
  const hash = createHash('sha256')
  for (const field of [
    'tenon-runtime-release-v2',
    payloadDigest,
    source.host,
    source.pluginVersion,
    stableTarget === undefined ? 'no-stable-target' : 'stable-target',
    stableTarget?.version ?? '',
    stableTarget?.tag ?? '',
    stableTarget?.commit ?? '',
  ]) hashFrame(hash, field)
  return `sha256-${hash.digest('hex')}`
}

function releaseManifest(value, releaseId) {
  if (!isRecord(value) || value.releaseId !== releaseId || !RELEASE_ID.test(releaseId)
    || typeof value.payloadDigest !== 'string' || !PAYLOAD_DIGEST.test(value.payloadDigest)
    || typeof value.createdAt !== 'string' || value.createdAt.trim() === '') return null
  const source = releaseSource(value.source)
  if (source === null) return null
  if (value.version === 1) {
    if (!exactKeys(value, ['version', 'releaseId', 'payloadDigest', 'createdAt', 'source'])
      || releaseId !== `sha256-${value.payloadDigest}`) return null
    return { version: 1, releaseId, payloadDigest: value.payloadDigest, source }
  }
  if (value.version !== 2) return null
  const expectedKeys = value.stableTarget === undefined
    ? ['version', 'releaseId', 'payloadDigest', 'createdAt', 'source']
    : ['version', 'releaseId', 'payloadDigest', 'createdAt', 'source', 'stableTarget']
  if (!exactKeys(value, expectedKeys)) return null
  const stableTarget = value.stableTarget === undefined ? undefined : stableReleaseTarget(value.stableTarget)
  if (stableTarget === null
    || (stableTarget !== undefined && stableTarget.version !== source.pluginVersion)
    || releaseId !== runtimeReleaseIdV2(value.payloadDigest, source, stableTarget)) return null
  return {
    version: 2,
    releaseId,
    payloadDigest: value.payloadDigest,
    source,
    ...(stableTarget === undefined ? {} : { stableTarget }),
  }
}

async function releasePayload(paths, releaseId) {
  if (!RELEASE_ID.test(releaseId)) return null
  const releaseRoot = join(paths.releasesRoot, releaseId)
  const manifestPath = join(releaseRoot, 'release.json')
  try {
    const manifest = releaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), releaseId)
    if (manifest === null) return null
    const payload = join(releaseRoot, 'payload')
    const cli = join(payload, 'packages', 'cli', 'dist', 'tenon.mjs')
    const bootstrap = join(payload, 'runtime', 'tenon-bootstrap.mjs')
    if (!await normalFile(cli) || !await normalFile(bootstrap)) return null
    // Selection and manifest shape are not integrity proof. Re-prove the immutable tree before every
    // execution boundary so a locally forged active payload enters recovery-only mode.
    if (!await payloadMatchesDigest(paths, releaseId, payload, manifest.version, manifest.payloadDigest)) return null
    return { releaseRoot, payload, ...manifest, host: manifest.source.host }
  } catch {
    return null
  }
}

function compareUtf8Names(left, right) {
  return Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8'))
}

async function hashLegacyPayload(root) {
  const hash = createHash('sha256')
  async function visit(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const child = join(dir, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const item = await lstat(child)
      if (item.isSymbolicLink()) throw new Error(`payload contains symbolic link: ${childRel}`)
      if (item.isDirectory()) {
        hash.update(`D\u0000${childRel}\u0000`)
        await visit(child, childRel)
      } else if (item.isFile()) {
        hash.update(`F\u0000${childRel}\u0000${(item.mode & 0o777).toString(8)}\u0000`)
        hash.update(await readFile(child))
      } else {
        throw new Error(`payload contains unsupported entry: ${childRel}`)
      }
    }
  }
  await visit(root, '')
  return hash.digest('hex')
}

async function hashPayloadV2(root) {
  const hash = createHash('sha256')
  hashFrame(hash, 'tenon-release-payload-v2')
  async function visit(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort(compareUtf8Names)
    for (const entry of entries) {
      const child = join(dir, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const item = await lstat(child)
      if (item.isSymbolicLink()) throw new Error(`payload contains symbolic link: ${childRel}`)
      if (item.isDirectory()) {
        hashFrame(hash, 'directory')
        hashFrame(hash, childRel)
        hashFrame(hash, (item.mode & 0o777).toString(8))
        await visit(child, childRel)
      } else if (item.isFile()) {
        hashFrame(hash, 'file')
        hashFrame(hash, childRel)
        hashFrame(hash, (item.mode & 0o777).toString(8))
        hashFrame(hash, await readFile(child))
      } else {
        throw new Error(`payload contains unsupported entry: ${childRel}`)
      }
    }
  }
  await visit(root, '')
  return hash.digest('hex')
}

async function hashPayload(root, manifestVersion) {
  return manifestVersion === 1 ? hashLegacyPayload(root) : hashPayloadV2(root)
}

// Stat fingerprint of the same payload tree, without reading file bytes. ctime and inode are part of the
// key, and ordinary writers cannot preserve them, so any content or mode change forces a full re-hash.
async function payloadStatFingerprint(root) {
  const hash = createHash('sha256')
  hashFrame(hash, 'tenon-payload-stat-v1')
  async function visit(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort(compareUtf8Names)
    for (const entry of entries) {
      const child = join(dir, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const item = await lstat(child, { bigint: true })
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) {
        throw new Error(`payload contains unsupported entry: ${childRel}`)
      }
      for (const field of [
        item.isDirectory() ? 'directory' : 'file', childRel, item.mode, item.size, item.mtimeNs, item.ctimeNs, item.ino, item.dev,
      ]) hashFrame(hash, String(field))
      if (item.isDirectory()) await visit(child, childRel)
    }
  }
  await visit(root, '')
  return hash.digest('hex')
}

const DIGEST_CACHE_VERSION = 1

function digestCachePath(paths) {
  return join(paths.stateRoot, 'payload-digest-cache.json')
}

async function readDigestCache(paths) {
  try {
    const value = JSON.parse(await readFile(digestCachePath(paths), 'utf8'))
    return isRecord(value) && value.version === DIGEST_CACHE_VERSION && isRecord(value.releases) ? value.releases : {}
  } catch {
    return {}
  }
}

/*
 * Every dispatch must prove the payload still matches its manifest digest. Re-hashing the full payload
 * (tens of MB with upstream skills) on each hook is the slow path, so a verified digest is remembered in
 * stateRoot next to selection.json, keyed by the stat fingerprint. Whoever can rewrite this cache can
 * already repoint the active release, so it adds no new trust boundary. The fingerprint is taken before
 * hashing: content changed during hashing either fails now or misses the cache next time.
 */
async function payloadMatchesDigest(paths, releaseId, payload, manifestVersion, expectedDigest) {
  const fingerprint = await payloadStatFingerprint(payload)
  const releases = await readDigestCache(paths)
  const cached = releases[releaseId]
  if (isRecord(cached) && cached.fingerprint === fingerprint
    && cached.payloadDigest === expectedDigest && cached.manifestVersion === manifestVersion) return true
  if (await hashPayload(payload, manifestVersion) !== expectedDigest) return false
  try {
    const others = Object.entries(releases).filter(([id]) => id !== releaseId && RELEASE_ID.test(id)).slice(-3)
    await mkdir(paths.stateRoot, { recursive: true })
    await atomicWrite(digestCachePath(paths), `${JSON.stringify({
      version: DIGEST_CACHE_VERSION,
      releases: { ...Object.fromEntries(others), [releaseId]: { manifestVersion, payloadDigest: expectedDigest, fingerprint } },
    })}\n`)
  } catch {
    // The cache only saves time; the full hash above already proved this payload.
  }
  return true
}

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

async function appendAudit(paths, entry) {
  await mkdir(dirname(paths.auditPath), { recursive: true })
  const failOnce = process.env.TENON_TEST_FAIL_ROLLBACK_TERMINAL_AUDIT_ONCE
  if (entry.kind === 'rolled-back' && typeof failOnce === 'string' && failOnce !== '') {
    try {
      await writeFile(failOnce, 'failed\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      throw new Error('injected rollback terminal audit failure')
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'EEXIST')) throw error
    }
  }
  await appendFile(paths.auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

function validAudit(value) {
  if (!isRecord(value) || value.version !== 1 || typeof value.at !== 'string' || value.at.trim() === ''
    || typeof value.detail !== 'string' || value.detail.trim() === '') return null
  const kinds = new Set([
    'activation-prepared', 'activated', 'activation-rejected',
    'rollback-prepared', 'rolled-back', 'rollback-rejected',
    'update-rejected', 'pruned',
  ])
  if (!kinds.has(value.kind)) return null
  if (value.releaseId !== undefined && (typeof value.releaseId !== 'string' || !RELEASE_ID.test(value.releaseId))) return null
  if (value.previousRelease !== undefined && value.previousRelease !== null
    && (typeof value.previousRelease !== 'string' || !RELEASE_ID.test(value.previousRelease))) return null
  return value
}

async function readAuditState(paths) {
  try {
    const raw = await readFile(paths.auditPath, 'utf8')
    if (raw === '') return { lastAudit: null, auditCorrupt: false }
    if (!raw.endsWith('\n')) return { lastAudit: null, auditCorrupt: true }
    let latest = null
    for (const line of raw.slice(0, -1).split(/\r?\n/)) {
      if (line === '') return { lastAudit: null, auditCorrupt: true }
      let parsed
      try { parsed = validAudit(JSON.parse(line)) } catch { parsed = null }
      if (parsed === null) return { lastAudit: null, auditCorrupt: true }
      latest = parsed
    }
    return { lastAudit: latest, auditCorrupt: false }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { lastAudit: null, auditCorrupt: false }
    }
    return { lastAudit: null, auditCorrupt: true }
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function processStartIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
      const close = raw.lastIndexOf(')')
      if (close < 0) return null
      const fields = raw.slice(close + 2).trim().split(/\s+/u)
      const start = fields[19]
      return start !== undefined && /^[0-9]+$/u.test(start) ? `linux:${start}` : null
    }
    const ps = process.platform === 'darwin' ? '/bin/ps' : '/usr/bin/ps'
    const result = spawnSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const start = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : ''
    return start === '' ? null : `${process.platform}:${start}`
  } catch {
    return null
  }
}

/**
 * Use the same state-root `.pipeline.lock` convention as the managed release store.  Recovery
 * lives in the bootstrap precisely because the active CLI may be broken, so it cannot import the
 * normal lock implementation; this small compatible adapter keeps activation and rollback from
 * publishing competing selections.
 */
async function withStateLock(paths, operation) {
  await mkdir(paths.stateRoot, { recursive: true })
  const lock = join(paths.stateRoot, '.pipeline.lock')
  const owner = join(lock, 'owner')
  const token = `${process.pid}.${randomBytes(8).toString('hex')}.${Date.now()}`
  const claim = `${lock}.claim.${token}`
  const testTimeout = process.env.TENON_TEST_STATE_LOCK_TIMEOUT_MS
  const timeoutMs = testTimeout !== undefined && /^[1-9][0-9]{0,4}$/u.test(testTimeout)
    ? Number(testTimeout)
    : 10_000
  const deadline = Date.now() + timeoutMs
  let acquired = false
  let heartbeat = null
  try {
    await mkdir(claim, { mode: 0o700 })
    const pidStart = await processStartIdentity(process.pid)
    if (pidStart === null) throw new Error('runtime recovery cannot prove its process start identity')
    await writeFile(
      join(claim, 'owner'),
      `${JSON.stringify({ version: 1, token, pid: process.pid, pidStart, createdAt: Date.now() })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    while (!acquired) {
      try {
        // Publish a fully populated private claim. No contender can observe a lock directory
        // without its immutable owner record.
        await rename(claim, lock)
        acquired = true
        heartbeat = setInterval(() => {
          const now = new Date()
          void utimes(owner, now, now).catch(() => {})
        }, 20_000)
        if (typeof heartbeat.unref === 'function') heartbeat.unref()
      } catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        let age = null
        let ownerKey = null
        let ownerPid = null
        let ownerPidStart = null
        try {
          const ownerStat = await stat(owner)
          const value = JSON.parse(await readFile(owner, 'utf8'))
          if (!isRecord(value)
            || value.version !== 1
            || typeof value.token !== 'string'
            || !/^[0-9]+\.[a-f0-9]+\.[0-9]+$/u.test(value.token)
            || !Number.isSafeInteger(value.pid)
            || value.pid <= 0
            || (value.pidStart !== undefined
              && (typeof value.pidStart !== 'string' || value.pidStart === ''))) throw new Error('invalid owner')
          age = Date.now() - ownerStat.mtimeMs
          ownerKey = value.token
          ownerPid = value.pid
          ownerPidStart = value.pidStart ?? null
        } catch {
          // Compatibility for a pre-v1.0.2 lock whose owner was a plain token, including the
          // mkdir-before-owner crash shape. Preserve its owner-file heartbeat when present; for
          // the crash shape derive one stable tombstone key from the directory inode so two
          // reclaimers cannot rename a newly published successor lock.
          try {
            const ownerStat = await stat(owner)
            const legacyToken = (await readFile(owner, 'utf8')).trim()
            if (!/^[0-9]+\.[a-f0-9]+\.[0-9]+$/u.test(legacyToken)) throw new Error('invalid legacy owner')
            age = Date.now() - ownerStat.mtimeMs
            ownerKey = `legacy-${legacyToken}`
            const legacyPid = Number(legacyToken.split('.')[0])
            ownerPid = Number.isSafeInteger(legacyPid) && legacyPid > 0 ? legacyPid : null
          } catch {
            try {
              const lockStat = await stat(lock)
              age = Date.now() - lockStat.mtimeMs
              ownerKey = `legacy-${lockStat.dev}-${lockStat.ino}-${Math.trunc(lockStat.birthtimeMs)}`
            } catch {
              age = null
            }
          }
        }
        let ownerAlive = false
        let ownerReused = false
        if (ownerPid !== null) {
          try {
            process.kill(ownerPid, 0)
            ownerAlive = true
            if (ownerPidStart !== null) {
              const observedStart = await processStartIdentity(ownerPid)
              if (observedStart !== null && observedStart !== ownerPidStart) {
                ownerAlive = false
                ownerReused = true
              }
            }
          } catch (ownerError) {
            if (!(ownerError && typeof ownerError === 'object' && ownerError.code === 'ESRCH')) {
              ownerAlive = true
            }
          }
        }
        if (ownerKey !== null && age !== null && (!ownerAlive || ownerReused)) {
          const grave = `${lock}.stale.${ownerKey}`
          try {
            await rename(lock, grave)
          } catch (reclaimError) {
            const reclaimCode = reclaimError && typeof reclaimError === 'object'
              ? reclaimError.code
              : undefined
            if (reclaimCode !== 'ENOENT'
              && reclaimCode !== 'EEXIST'
              && reclaimCode !== 'ENOTEMPTY') throw reclaimError
          }
          continue
        }
        if (Date.now() >= deadline) throw new Error(`runtime recovery lock acquisition timed out after ${timeoutMs}ms`)
        await delay(25)
      }
    }
    return await operation()
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat)
    if (acquired) {
      let own = false
      try {
        const current = JSON.parse(await readFile(owner, 'utf8'))
        own = isRecord(current) && current.version === 1 && current.token === token
      } catch { own = false }
      if (own) await rm(lock, { recursive: true, force: true }).catch(() => {})
    } else {
      await rm(claim, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function launcherStatValue(proof, includeSize) {
  const mode = process.platform === 'darwin' ? proof.mode.toString(8) : proof.mode.toString(16)
  return [proof.dev, proof.ino, mode, proof.uid, ...(includeSize ? [proof.size] : [])].join(':')
}

async function currentNodeProof() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`stable launcher cannot persist ${process.platform} Node identity`)
  }
  const executableInfo = await lstat(process.execPath)
  if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) {
    throw new Error('current Node executable is not an ordinary file')
  }
  const entry = (path, info) => ({
    path,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    size: info.size,
  })
  const parents = []
  let cursor = dirname(process.execPath)
  while (true) {
    const info = await lstat(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`current Node parent is not an ordinary directory: ${cursor}`)
    }
    parents.push(entry(cursor, info))
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return {
    version: 1,
    platform: process.platform,
    requestedPath: process.execPath,
    executable: entry(process.execPath, executableInfo),
    parents,
    sha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
  }
}

function launcherNodeGuard(proof) {
  if (proof === undefined) return ''
  const statArgs = process.platform === 'darwin' ? "-f '%d:%i:%p:%u:%z'" : "-c '%d:%i:%f:%u:%s'"
  const dirStatArgs = process.platform === 'darwin' ? "-f '%d:%i:%p:%u'" : "-c '%d:%i:%f:%u'"
  const followArgs = process.platform === 'darwin' ? "-L -f '%d:%i'" : "-L -c '%d:%i'"
  const hash = process.platform === 'darwin'
    ? `/usr/bin/shasum -a 256 ${shellQuote(proof.executable.path)}`
    : `/usr/bin/sha256sum ${shellQuote(proof.executable.path)}`
  const parentChecks = proof.parents.map((parent) => `
[ ! -L ${shellQuote(parent.path)} ] || tenon_node_identity_changed
[ "$(/usr/bin/stat ${dirStatArgs} ${shellQuote(parent.path)} 2>/dev/null)" = ${shellQuote(launcherStatValue(parent, false))} ] || tenon_node_identity_changed`).join('')
  return `
tenon_node_identity_changed() {
  printf 'tenon runtime Node identity changed; rerun tenon setup --codex or tenon setup --claude\\n' >&2
  exit 126
}
[ ! -L ${shellQuote(proof.executable.path)} ] || tenon_node_identity_changed
[ "$(/usr/bin/stat ${statArgs} ${shellQuote(proof.executable.path)} 2>/dev/null)" = ${shellQuote(launcherStatValue(proof.executable, true))} ] || tenon_node_identity_changed
[ "$(/usr/bin/stat ${followArgs} ${shellQuote(proof.requestedPath)} 2>/dev/null)" = ${shellQuote(`${proof.executable.dev}:${proof.executable.ino}`)} ] || tenon_node_identity_changed${parentChecks}
tenon_node_digest_output="$(${hash} 2>/dev/null)" || tenon_node_identity_changed
tenon_node_digest="${'${tenon_node_digest_output%% *}'}"
[ "$tenon_node_digest" = ${shellQuote(proof.sha256)} ] || tenon_node_identity_changed
`
}

function productRootContract(paths) {
  return JSON.stringify({
    version: 1,
    dataRoot: paths.dataRoot,
    stateRoot: paths.stateRoot,
    configRoot: paths.configRoot,
  })
}

function stableLauncherText(paths, mode, legacy = false, nodeProof) {
  const bootstrap = join(paths.bootstrapRoot, 'active.mjs')
  const missing = mode === 'hook'
    ? 'exit 0'
    : 'printf "tenon runtime bootstrap unavailable; run tenon setup --codex or tenon setup --claude\\n" >&2\n  exit 1'
  return `${legacy ? '#!/usr/bin/env bash' : '#!/bin/sh'}
set -eu
export TENON_RUNTIME_ROOTS=${shellQuote(productRootContract(paths))}
# N-1 bootstrap ABI: previous verified releases read these exact roots during rollback.
export TENON_RUNTIME_DATA_ROOT=${shellQuote(paths.dataRoot)}
export TENON_RUNTIME_STATE_ROOT=${shellQuote(paths.stateRoot)}
export TENON_RUNTIME_CONFIG_ROOT=${shellQuote(paths.configRoot)}
[ -f ${shellQuote(bootstrap)} ] || { ${missing}; }
${launcherNodeGuard(nodeProof)}
exec ${legacy ? 'node' : shellQuote(process.execPath)} ${shellQuote(bootstrap)} ${mode} "$@"
`
}

function expectedStableLaunchers(paths, legacy = false, nodeProof) {
  const bin = join(homedir(), '.local', 'bin')
  return {
    tenon: {
      path: join(bin, 'tenon'),
      state: { kind: 'file', content: stableLauncherText(paths, 'cli', legacy, nodeProof), mode: 0o755 },
    },
    hook: {
      path: join(bin, 'tenon-hook'),
      state: { kind: 'file', content: stableLauncherText(paths, 'hook', legacy, nodeProof), mode: 0o755 },
    },
  }
}

async function captureLauncher(path) {
  try {
    const item = await lstat(path)
    if (!item.isFile() || item.isSymbolicLink()) throw new Error(`stable launcher is not an ordinary file: ${path}`)
    return { path, state: { kind: 'file', content: await readFile(path, 'utf8'), mode: item.mode & 0o777 } }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { path, state: { kind: 'missing' } }
    throw error
  }
}

async function captureStableLaunchers(paths) {
  const expected = expectedStableLaunchers(paths)
  const [tenon, hook] = await Promise.all([
    captureLauncher(expected.tenon.path),
    captureLauncher(expected.hook.path),
  ])
  return { tenon, hook }
}

function sameLauncherState(left, right) {
  if (left.kind !== right.kind) return false
  return left.kind === 'missing'
    || (left.content === right.content && left.mode === right.mode)
}

function validLauncherSnapshot(value) {
  if (!isRecord(value) || !exactKeys(value, ['tenon', 'hook'])) return false
  return ['tenon', 'hook'].every((name) => {
    const file = value[name]
    if (!isRecord(file) || !exactKeys(file, ['path', 'state']) || typeof file.path !== 'string') return false
    const state = file.state
    return isRecord(state) && (state.kind === 'missing'
      ? exactKeys(state, ['kind'])
      : state.kind === 'file' && exactKeys(state, ['kind', 'content', 'mode'])
        && typeof state.content === 'string' && Number.isSafeInteger(state.mode)
        && state.mode >= 0 && state.mode <= 0o777)
  })
}

function validRollbackJournal(value) {
  if (!isRecord(value) || !exactKeys(value, [
    'version', 'transactionId', 'beforeSelection', 'target', 'launchers',
  ]) || value.version !== 1 || typeof value.transactionId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(value.transactionId)
    || parseSelection(value.beforeSelection) === null || !validLauncherSnapshot(value.launchers)
    || !isRecord(value.target) || !exactKeys(value.target, ['revision', 'activeRelease', 'previousRelease'])
    || !Number.isSafeInteger(value.target.revision)
    || value.target.revision !== value.beforeSelection.revision + 1
    || value.target.activeRelease !== value.beforeSelection.previousRelease
    || value.target.previousRelease !== value.beforeSelection.activeRelease
    || !RELEASE_ID.test(value.target.activeRelease)) return null
  return value
}

async function readRollbackJournal(paths) {
  try {
    return validRollbackJournal(JSON.parse(await readFile(join(
      paths.managedTransactionRoot,
      'runtime-rollback.json',
    ), 'utf8')))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw new Error('runtime rollback journal is malformed')
  }
}

function selectionMatchesRollbackTarget(selection, target) {
  return selection !== null
    && selection.revision === target.revision
    && selection.activeRelease === target.activeRelease
    && selection.previousRelease === target.previousRelease
}

async function convergeRollbackLauncher(name, expected, legacy, checkpoint, transactionId) {
  if (expected.path !== checkpoint.path) throw new Error(`rollback launcher checkpoint path drifted: ${name}`)
  const privatePrevious = `${expected.path}.tenon-rollback-${transactionId}.previous`
  let current = await captureLauncher(expected.path)
  let previous = await captureLauncher(privatePrevious)
  if (sameLauncherState(current.state, expected.state)) {
    if (previous.state.kind !== 'missing') {
      if (!sameLauncherState(previous.state, checkpoint.state)) {
        throw new Error(`rollback launcher private checkpoint drifted: ${name}`)
      }
      await rm(privatePrevious)
    }
    return
  }
  const checkpointAllowed = checkpoint.state.kind === 'missing'
    || sameLauncherState(checkpoint.state, legacy.state)
    || sameLauncherState(checkpoint.state, expected.state)
  if (!checkpointAllowed) throw new Error(`rollback refuses a third-party launcher checkpoint: ${name}`)
  if (previous.state.kind === 'missing' && sameLauncherState(current.state, checkpoint.state)
    && current.state.kind === 'file') {
    await rename(expected.path, privatePrevious)
    previous = await captureLauncher(privatePrevious)
    current = await captureLauncher(expected.path)
  }
  if (previous.state.kind !== 'missing' && !sameLauncherState(previous.state, checkpoint.state)) {
    throw new Error(`rollback launcher private previous is not the journal checkpoint: ${name}`)
  }
  if (current.state.kind !== 'missing') {
    throw new Error(`rollback launcher changed after its checkpoint: ${name}`)
  }
  await mkdir(dirname(expected.path), { recursive: true })
  await writeFile(expected.path, expected.state.content, { flag: 'wx', mode: expected.state.mode })
  await chmod(expected.path, expected.state.mode)
  current = await captureLauncher(expected.path)
  if (!sameLauncherState(current.state, expected.state)) {
    throw new Error(`rollback launcher publication did not converge: ${name}`)
  }
  if (previous.state.kind !== 'missing') await rm(privatePrevious)
}

async function convergeRollbackLaunchers(paths, journal) {
  const expected = expectedStableLaunchers(paths, false, await currentNodeProof())
  const legacy = expectedStableLaunchers(paths, true)
  await convergeRollbackLauncher('tenon', expected.tenon, legacy.tenon, journal.launchers.tenon, journal.transactionId)
  await convergeRollbackLauncher('hook', expected.hook, legacy.hook, journal.launchers.hook, journal.transactionId)
  const current = await captureStableLaunchers(paths)
  if (!sameLauncherState(current.tenon.state, expected.tenon.state)
    || !sameLauncherState(current.hook.state, expected.hook.state)) {
    throw new Error('rollback stable launcher pair did not converge')
  }
}

async function recoverCommittedRollbackAudit(paths, selection) {
  const audit = await readAuditState(paths)
  if (audit.auditCorrupt) throw new Error('rollback audit is incomplete or malformed')
  const prepared = audit.lastAudit
  if (prepared?.kind !== 'rollback-prepared') return
  if (prepared.releaseId !== selection.activeRelease
    || (prepared.previousRelease ?? null) !== selection.previousRelease) {
    throw new Error('rollback prepared audit does not match the committed selection')
  }
  await appendAudit(paths, {
    version: 1,
    at: now(),
    kind: 'rolled-back',
    releaseId: selection.activeRelease,
    previousRelease: selection.previousRelease,
    detail: 'recovered terminal audit for committed bootstrap rollback',
  })
}

async function rollback(paths) {
  return withStateLock({ stateRoot: paths.managedTransactionRoot }, () => withStateLock(paths, async () => {
    await mkdir(paths.managedTransactionRoot, { recursive: true })
    const journalPath = join(paths.managedTransactionRoot, 'runtime-rollback.json')
    let journal = await readRollbackJournal(paths)
    if (journal === null) {
      const selection = await readSelection(paths)
      if (selection === null || selection.previousRelease === null) {
        throw new Error('no verified previous release is available; run tenon setup --codex or tenon setup --claude')
      }
      const previous = await releasePayload(paths, selection.previousRelease)
      if (previous === null) throw new Error('previous release integrity check failed; reinstall the selected host package')
      journal = {
        version: 1,
        transactionId: randomBytes(18).toString('hex').replace(
          /^(........)(....)(....)(....)(............).*$/,
          '$1-$2-$3-$4-$5',
        ),
        beforeSelection: selection,
        target: {
          revision: selection.revision + 1,
          activeRelease: selection.previousRelease,
          previousRelease: selection.activeRelease,
        },
        launchers: await captureStableLaunchers(paths),
      }
      await atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
    }

    let selection = await readSelection(paths)
    if (JSON.stringify(selection) === JSON.stringify(journal.beforeSelection)) {
      const previous = await releasePayload(paths, journal.target.activeRelease)
      if (previous === null) throw new Error('rollback target integrity check failed; reinstall the selected host package')
      const next = {
        version: 1,
        revision: journal.target.revision,
        activeRelease: journal.target.activeRelease,
        previousRelease: journal.target.previousRelease,
        updatedAt: now(),
      }
      let selectionCommitted = false
      try {
        // Keep this current hardened dual-reader bootstrap active; only the frozen selection and
        // stable launcher pair move under the durable rollback journal.
        await appendAudit(paths, {
          version: 1,
          at: now(),
          kind: 'rollback-prepared',
          releaseId: next.activeRelease,
          previousRelease: next.previousRelease,
          detail: 'verified bootstrap rollback prepared; durable target journal already committed',
        })
        await atomicWrite(paths.selectionPath, `${JSON.stringify(next, null, 2)}\n`)
        selectionCommitted = true
        selection = next
        await appendAudit(paths, {
          version: 1,
          at: now(),
          kind: 'rolled-back',
          releaseId: next.activeRelease,
          previousRelease: next.previousRelease,
          detail: 'verified bootstrap rollback selection committed',
        })
      } catch (error) {
        if (!selectionCommitted) {
          await appendAudit(paths, {
            version: 1,
            at: now(),
            kind: 'rollback-rejected',
            releaseId: next.activeRelease,
            previousRelease: next.previousRelease,
            detail: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
        }
        throw error
      }
    }
    if (!selectionMatchesRollbackTarget(selection, journal.target)
      || await releasePayload(paths, journal.target.activeRelease) === null) {
      throw new Error('rollback journal does not match the current selection; refusing a second swap')
    }
    await recoverCommittedRollbackAudit(paths, selection)
    await convergeRollbackLaunchers(paths, journal)
    const persisted = await readRollbackJournal(paths)
    if (persisted === null || persisted.transactionId !== journal.transactionId) {
      throw new Error('rollback journal owner changed before commit')
    }
    await rm(journalPath)
    return selection
  })
  )
}

function recoveryCommand(input) {
  let parsed
  try { parsed = JSON.parse(input) } catch { return false }
  if (!isRecord(parsed) || (parsed.tool_name !== 'Bash' && parsed.tool_name !== 'command_execution')
    || typeof parsed.command !== 'string') return false
  // The gate authorizes the stable PATH command identity only. A matching basename at an
  // attacker-controlled absolute path is not the managed launcher and must remain denied.
  return parsed.command.trim() === 'tenon runtime repair --rollback'
}

async function childEnv(release, paths) {
  const { payload } = release
  const env = {
    ...process.env,
    PLUGIN_ROOT: payload,
    CLAUDE_PLUGIN_ROOT: payload,
    TENON_RUNTIME_ROOTS: JSON.stringify({
      version: 1,
      dataRoot: paths.dataRoot,
      stateRoot: paths.stateRoot,
      configRoot: paths.configRoot,
    }),
    // Read-only projections for shell hooks and the N-1 bootstrap ABI. They are derived from the
    // versioned root contract above; current runtime path resolution never treats them as inputs.
    TENON_RUNTIME_DATA_ROOT: paths.dataRoot,
    TENON_RUNTIME_STATE_ROOT: paths.stateRoot,
    TENON_RUNTIME_CONFIG_ROOT: paths.configRoot,
    // `payload` has just passed releasePayload()'s full content digest verification. Propagate
    // that exact immutable execution identity so Codex Skill provenance can accept the active
    // managed release without trusting an arbitrary PLUGIN_ROOT supplied by the caller.
    TENON_ACTIVE_RELEASE_ROOT: payload,
    TENON_ACTIVE_RELEASE_ID: release.releaseId,
    TENON_RUNTIME_HOST: release.host,
  }
  if (HOST_PLUGIN_ROOT === null) delete env.TENON_HOST_PLUGIN_ROOT
  else env.TENON_HOST_PLUGIN_ROOT = HOST_PLUGIN_ROOT
  const codexCacheRoot = await codexPluginCacheRoot(payload)
  if (codexCacheRoot === null) delete env.TENON_CODEX_PLUGIN_ROOT
  else env.TENON_CODEX_PLUGIN_ROOT = codexCacheRoot
  return env
}

function exitFor(result) {
  if (typeof result.status === 'number') return result.status
  return result.error === undefined ? 0 : 1
}

async function emitBootstrapStatus(paths, asJson) {
  const selection = await readSelection(paths)
  const active = selection?.activeRelease === null || selection === null ? null : await releasePayload(paths, selection.activeRelease)
  const previous = selection?.previousRelease === null || selection === null ? null : await releasePayload(paths, selection.previousRelease)
  const audit = await readAuditState(paths)
  const identity = (release) => release === null ? null : ({
    version: release.version,
    releaseId: release.releaseId,
    payloadDigest: release.payloadDigest,
    source: release.source,
    ...(release.stableTarget === undefined ? {} : { stableTarget: release.stableTarget }),
  })
  const payload = {
    selection,
    active: identity(active),
    previous: identity(previous),
    activeValid: active !== null,
    previousValid: previous !== null,
    bootstrap: join(paths.bootstrapRoot, 'active.mjs'),
    lastAudit: audit.lastAudit,
    auditCorrupt: audit.auditCorrupt,
  }
  if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`)
  else {
    process.stdout.write(`[runtime] active=${selection?.activeRelease ?? 'none'} valid=${active === null ? 'no' : 'yes'}\n`)
    process.stdout.write(`[runtime] previous=${selection?.previousRelease ?? 'none'} valid=${previous === null ? 'no' : 'yes'} revision=${selection?.revision ?? 'unknown'}\n`)
    if (active !== null) process.stdout.write(`[runtime] version=${active.source.pluginVersion} release=${active.releaseId}\n`)
    if (audit.auditCorrupt) process.stdout.write('[runtime] WARNING: audit.jsonl is incomplete or malformed.\n')
    if (active === null) process.stdout.write('[runtime] 修复：tenon runtime repair --rollback；或 tenon setup --codex / --claude。\n')
  }
  return 0
}

async function runCli(paths, args) {
  if (args.length >= 2 && args[0] === 'runtime' && args[1] === 'repair' && args.length === 3 && args[2] === '--rollback') {
    try {
      const selection = await rollback(paths)
      process.stdout.write(`${JSON.stringify({ ok: true, selection })}\n`)
      return 0
    } catch (error) {
      process.stderr.write(`tenon runtime repair: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  if (args.length >= 2 && args[0] === 'runtime' && args[1] === 'bootstrap-status') {
    const selection = await readSelection(paths)
    process.stdout.write(`${JSON.stringify({ selection, bootstrap: join(paths.bootstrapRoot, 'active.mjs') })}\n`)
    return selection === null ? 1 : 0
  }
  if (args.length >= 2 && args[0] === 'runtime' && args[1] === 'status'
    && (args.length === 2 || (args.length === 3 && args[2] === '--json'))) {
    return emitBootstrapStatus(paths, args[2] === '--json')
  }
  const selection = await readSelection(paths)
  const active = selection?.activeRelease === null || selection === null ? null : await releasePayload(paths, selection.activeRelease)
  if (active === null) {
    process.stderr.write('tenon runtime is unavailable; run tenon runtime repair --rollback or tenon setup --<host>\n')
    return 1
  }
  const result = spawnSync(process.execPath, [join(active.payload, 'packages', 'cli', 'dist', 'tenon.mjs'), ...args], {
    cwd: process.cwd(),
    env: await childEnv(active, paths),
    stdio: 'inherit',
  })
  return exitFor(result)
}

async function runHook(paths, hookId) {
  const input = await new Promise((resolveInput) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { text += chunk })
    process.stdin.on('end', () => resolveInput(text))
    process.stdin.on('error', () => resolveInput(text))
  })
  if (!/^[a-z0-9-]+$/.test(hookId)) return 0
  if (hookId === 'gate' && recoveryCommand(input)) return 0
  const selection = await readSelection(paths)
  const active = selection?.activeRelease === null || selection === null ? null : await releasePayload(paths, selection.activeRelease)
  if (active === null) {
    process.stderr.write('[tenon] managed runtime unavailable; normal project mutation is disabled until rollback or setup succeeds.\n')
    return hookId === 'gate' ? 2 : 0
  }
  const hook = join(active.payload, 'hooks', `${hookId}.sh`)
  if (!await normalFile(hook)) {
    process.stderr.write(`[tenon] active runtime hook is missing: ${hookId}\n`)
    return hookId === 'gate' ? 2 : 0
  }
  const result = spawnSync('/bin/bash', [hook], {
    cwd: process.cwd(),
    env: await childEnv(active, paths),
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return exitFor(result)
}

async function main() {
  const [mode, ...args] = process.argv.slice(2)
  const paths = runtimePaths()
  if (mode === 'cli') process.exitCode = await runCli(paths, args)
  else if (mode === 'hook' && args.length === 1) process.exitCode = await runHook(paths, args[0])
  else {
    process.stderr.write('tenon bootstrap usage: cli <args...> | hook <hook-id>\n')
    process.exitCode = 2
  }
}

void main()
