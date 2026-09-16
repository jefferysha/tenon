import { lstat, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { stateStorageSourcePathSync, TENON_PROJECT_DIR, TERMINAL_ACTIVITY_FILE } from '@tenon/kernel'
import { dedupeRoots } from './projectRoots.js'
import { repositoryTopologyFingerprint } from './repositoryFingerprint.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

type ActivityReader = (
  changeDir: string,
  changeName: string,
  nowMs: number,
) => Promise<unknown | undefined>

type ChangesDirectoryReader = (changesRoot: string) => Promise<Dirent[]>

async function userSlugs(readRoot: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(readRoot, TENON_PROJECT_DIR, 'users'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Build the SSE input fingerprint while retaining the same registered-root anchor as snapshots. */
export async function computeSnapshotFingerprint(
  roots: string[],
  nowMs: number,
  rootAnchor: ((root: string) => WorkflowRootAnchor | undefined) | undefined,
  readTerminalActivity: ActivityReader,
  readChangesDirectory?: ChangesDirectoryReader,
): Promise<string> {
  const parts: string[] = []
  for (const root of dedupeRoots(roots)) {
    parts.push(`registry:${root}`)
    let anchor: WorkflowRootAnchor | undefined
    let ownsAnchor = false
    try {
      if (rootAnchor !== undefined) {
        anchor = rootAnchor(root)
        if (anchor === undefined) throw new Error('registered root 没有可信目录锚')
      } else {
        anchor = captureWorkflowRootAnchor(root)
        ownsAnchor = true
      }
      assertWorkflowRootAnchor(anchor)
      const readRoot = anchor.fdPath ?? anchor.realPath
      parts.push(`root:${root}:${anchor.dev}:${anchor.ino}`)
      parts.push(...await repositoryTopologyFingerprint(readRoot))
      const changesRoot = join(readRoot, 'openspec', 'changes')
      let entries: Dirent[]
      try {
        entries = readChangesDirectory === undefined
          ? await readdir(changesRoot, { withFileTypes: true })
          : await readChangesDirectory(changesRoot)
      } catch (error) {
        assertWorkflowRootAnchor(anchor)
        if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') throw error
        entries = []
      }
      assertWorkflowRootAnchor(anchor)
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'archive') continue
        const changeDir = join(changesRoot, entry.name)
        const source = stateStorageSourcePathSync(changeDir)
        if (source === undefined) continue
        try {
          const stat = await lstat(source, { bigint: true })
          parts.push(`${source}:${stat.size}:${stat.mtimeNs}`)
        } catch {
          // A selected source can disappear between selection and lstat; the next poll recalculates.
        }
        for (const name of ['tasks.md', '.pipeline-documents.json'] as const) {
          const target = join(changeDir, name)
          try {
            const stat = await lstat(target, { bigint: true })
            parts.push(`${target}:${stat.size}:${stat.mtimeNs}`)
          } catch {
            // Missing optional snapshot input is represented by its absence from the fingerprint.
          }
        }
        // 新的测试记录与运行中标记必须推一次 SSE，否则工作台的测试页签只在别的输入变化时才刷新。
        for (const slug of await userSlugs(readRoot)) {
          for (const dir of [
            join(readRoot, TENON_PROJECT_DIR, 'users', slug, 'tests', entry.name),
            join(readRoot, TENON_PROJECT_DIR, 'users', slug, 'local', 'running', entry.name),
          ]) {
            try {
              const stat = await lstat(dir, { bigint: true })
              parts.push(`${dir}:${stat.size}:${stat.mtimeNs}`)
            } catch {
              // 没跑过测试就没有目录，用它的缺席表达。
            }
          }
        }
        const activity = join(changeDir, TERMINAL_ACTIVITY_FILE)
        try {
          const stat = await lstat(activity, { bigint: true })
          const live = await readTerminalActivity(changeDir, entry.name, nowMs)
          parts.push(`${activity}:${stat.size}:${stat.mtimeNs}:${live === undefined ? 'stale' : 'live'}`)
        } catch {
          // No sidecar is the normal idle state.
        }
      }
      assertWorkflowRootAnchor(anchor)
    } catch {
      parts.push(`unreadable:${root}`)
    } finally {
      if (ownsAnchor && anchor !== undefined) closeWorkflowRootAnchor(anchor)
    }
  }
  parts.sort()
  return parts.join('|')
}
