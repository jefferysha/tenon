import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearReviewMarkerFor, clearReviewMarkerOfChange, formatReviewMarker, REVIEW_MARKER_FILE } from './markers.js'

describe('clearReviewMarkerFor', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tenon-marker-clear-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const write = (change: string, event: string) => writeFile(join(root, REVIEW_MARKER_FILE),
    formatReviewMarker({ phase: 'verify', event, changeName: change, requestedAt: '2026-09-14T00:00:00Z' }), 'utf8')

  it('removes the marker of the acknowledged Change and event, and tolerates a missing marker', async () => {
    await write('demo', 'verify-pass')
    await clearReviewMarkerFor(root, 'demo', 'verify-pass')
    await expect(readFile(join(root, REVIEW_MARKER_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(clearReviewMarkerFor(root, 'demo', 'verify-pass')).resolves.toBeUndefined()
  })

  it('leaves markers of other Changes or events untouched', async () => {
    await write('other', 'verify-pass')
    await clearReviewMarkerFor(root, 'demo', 'verify-pass')
    await expect(readFile(join(root, REVIEW_MARKER_FILE), 'utf8')).resolves.toContain('change=other')
    await write('demo', 'verify-fail')
    await clearReviewMarkerFor(root, 'demo', 'verify-pass')
    await expect(readFile(join(root, REVIEW_MARKER_FILE), 'utf8')).resolves.toContain('event=verify-fail')
  })

  it('propagates a non-ENOENT failure so callers can report marker-warning', async () => {
    await mkdir(join(root, REVIEW_MARKER_FILE))
    await expect(clearReviewMarkerFor(root, 'demo', 'verify-pass')).rejects.toBeDefined()
  })
})

describe('clearReviewMarkerOfChange', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tenon-marker-change-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const write = (change: string) => writeFile(join(root, REVIEW_MARKER_FILE),
    formatReviewMarker({ phase: 'verify', event: 'verify-pass', changeName: change, requestedAt: '2026-09-14T00:00:00Z' }), 'utf8')

  it('removes the marker of the deleted Change whatever event it projects', async () => {
    await write('demo')
    expect(await clearReviewMarkerOfChange(root, 'demo')).toBe(true)
    await expect(readFile(join(root, REVIEW_MARKER_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await clearReviewMarkerOfChange(root, 'demo')).toBe(false)
  })

  it('leaves another Change and an unparsable marker alone', async () => {
    await write('other')
    expect(await clearReviewMarkerOfChange(root, 'demo')).toBe(false)
    await expect(readFile(join(root, REVIEW_MARKER_FILE), 'utf8')).resolves.toContain('change=other')
    await writeFile(join(root, REVIEW_MARKER_FILE), 'garbage\n', 'utf8')
    expect(await clearReviewMarkerOfChange(root, 'demo')).toBe(false)
    await expect(readFile(join(root, REVIEW_MARKER_FILE), 'utf8')).resolves.toBe('garbage\n')
  })
})
