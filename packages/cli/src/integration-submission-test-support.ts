import {
  artifactNamespaceForChange,
  createDocumentProjectionAdapter,
  createFieldProjectionAdapter,
  openArtifactSubmissionService,
} from '@tenon/automation'
import type { StateStore } from '@tenon/kernel'
import type { CliDeps } from './deps.js'

/**
 * 与 main.ts 同款的统一提交服务装配。`document record` 必须走这条生产路径，
 * 否则 docs/ 路径越界、重登旧 digest 这类缺陷在集成测试里根本不会出现。
 */
export function harnessArtifactSubmission(cwd: string, store: StateStore): NonNullable<CliDeps['artifactSubmission']> {
  return async ({ changeDir, phase, policy }) => openArtifactSubmissionService({
    changeDir,
    namespace: artifactNamespaceForChange(changeDir),
    repoRoot: cwd,
    ...(phase !== undefined && policy !== undefined
      ? { document: createDocumentProjectionAdapter({ repoRoot: cwd, changeDir, phase, policy }) }
      : {}),
    field: createFieldProjectionAdapter({ store, changeDir, persist: false }),
  })
}
