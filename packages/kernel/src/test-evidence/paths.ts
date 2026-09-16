/**
 * 测试证据的按用户路径，全部从 `userProjectPaths`（多用户子任务的单一真相源）派生。
 * 追踪进 git：`tests/<change>/<run-id>.json`、`baselines/<test-id>.json`。
 * 只留本机（`.tenon/.gitignore` 忽略每个用户的 local 目录）：运行中标记、env 密钥、日志与产物副本。
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureUserLocalDir, userProjectPaths } from '../users/user-paths.js'

export interface TestEvidencePaths {
  readonly runsDir: string
  readonly baselinesDir: string
  readonly runningDir: string
  readonly envKey: string
  readonly artifactsDir: string
}

/** 一个用户在一个任务上的测试证据目录。change 名由调用方用 `isValidChangeName` 校验。 */
export function testEvidencePaths(repoRoot: string, slug: string, change: string): TestEvidencePaths {
  const paths = userProjectPaths(repoRoot, slug)
  return {
    runsDir: join(paths.testsDir, change),
    baselinesDir: paths.baselinesDir,
    runningDir: join(paths.runningDir, change),
    envKey: paths.envKey,
    artifactsDir: join(paths.artifactsDir, change),
  }
}

export function testRunRecordPath(repoRoot: string, slug: string, change: string, runId: string): string {
  return join(testEvidencePaths(repoRoot, slug, change).runsDir, `${runId}.json`)
}

export function testBaselinePath(repoRoot: string, slug: string, testId: string): string {
  return join(userProjectPaths(repoRoot, slug).baselinesDir, `${testId}.json`)
}

export function testRunningMarkerPath(repoRoot: string, slug: string, change: string, testId: string): string {
  return join(testEvidencePaths(repoRoot, slug, change).runningDir, `${testId}.json`)
}

export function testRunArtifactsDir(repoRoot: string, slug: string, change: string, runId: string): string {
  return join(testEvidencePaths(repoRoot, slug, change).artifactsDir, runId)
}

/** 建齐一次运行需要的目录（含 `.tenon/.gitignore` 与 `local/` 0700）。 */
export async function ensureTestEvidenceDirs(
  repoRoot: string,
  slug: string,
  change: string,
  runId: string,
): Promise<TestEvidencePaths> {
  await ensureUserLocalDir(repoRoot, slug)
  const paths = testEvidencePaths(repoRoot, slug, change)
  for (const dir of [paths.runsDir, paths.baselinesDir, paths.runningDir, join(paths.artifactsDir, runId)]) {
    await mkdir(dir, { recursive: true })
  }
  return paths
}
