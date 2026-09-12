import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArtifactService } from '../../../packages/automation/dist/artifacts/service.js'
import { StageArtifactRuntime } from '../../../packages/automation/dist/artifact-runtime/stage-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'tenon-subject-e2e-'))
const evidence = { workflow: 'identity-projection-e2e', stages: [], assertions: [] }
try {
  await mkdir(join(root, 'docs'), { recursive: true })
  const service = await openArtifactService({ rootDir: root, scopeId: 'e2e' })
  const build = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'run-e2e', stageId: 'build', stageAttemptId: 'build-1' })
  await writeFile(join(root, 'docs', 'design.md'), '# design\n')
  const declared = await build.submit('docs/design.md', 'deliverable', 'design-document')
  await writeFile(join(root, 'tmp-debug.log'), 'host noise\n')
  await build.end('completed')
  evidence.stages.push({ stage: 'build', declared: { artifactId: declared.artifactId, subjectId: declared.subjectRef?.subject_id, projection: declared.subjectRef?.projection, disposition: declared.disposition, declarationStatus: declared.declarationStatus } })

  const verify = await service.beginAttempt({ workflowRunId: 'run-e2e', stageId: 'verify', stageAttemptId: 'verify-1', dependencyStages: ['build'] })
  const beforeRename = await service.catalog('verify-1')
  const renamed = await service.rename('verify-1', declared.artifactId, 'docs/architecture.md')
  const afterRename = await service.inspect(declared.artifactId, declared.version)
  const withCandidates = await service.catalog('verify-1', { includeCandidates: true, includeHistory: true })
  evidence.stages.push({ stage: 'verify', attemptStatus: verify.status, defaultCatalog: beforeRename.entries.map(entry => ({ artifactId: entry.artifactId, path: entry.source?.path, disposition: entry.disposition })), withCandidates: withCandidates.entries.map(entry => ({ path: entry.source?.path, disposition: entry.disposition, declarationStatus: entry.declarationStatus })) })
  evidence.assertions.push(
    ['stable-subject', renamed?.subjectRef?.subject_id === declared.subjectRef?.subject_id],
    ['rename-keeps-digest', renamed?.contentDigest === declared.contentDigest],
    ['legacy-free-new-id', !declared.artifactId.startsWith('artifact:')],
    ['reconcile-intermediate', withCandidates.entries.some(entry => entry.source?.path === 'tmp-debug.log' && entry.disposition === 'intermediate')],
    ['default-excludes-reconcile', !beforeRename.entries.some(entry => entry.source?.path === 'tmp-debug.log')],
    ['restart-readable', (await (await openArtifactService({ rootDir: root, scopeId: 'e2e' })).inspect(declared.artifactId, declared.version)).version.subjectRef?.subject_id === declared.subjectRef?.subject_id],
  )
  if (evidence.assertions.some(([, ok]) => !ok)) throw new Error(JSON.stringify(evidence))
  await service.endAttempt('verify-1', 'completed')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
