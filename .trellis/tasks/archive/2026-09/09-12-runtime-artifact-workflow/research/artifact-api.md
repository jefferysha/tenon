# Runtime artifact public API (v1)

`@tenon/kernel` owns serializable records; `@tenon/automation` owns filesystem
and persistence. All methods are additive and do not replace governed document
receipts.

```ts
import type { ArtifactService, ArtifactServiceOptions } from '@tenon/automation'
const artifacts = await openArtifactService({ rootDir, scopeId })
const attempt = await artifacts.beginAttempt({ workflowRunId, stageId, stageAttemptId, dependencyStages })
await artifacts.observe(attempt.stageAttemptId, { source: { path: 'result.md' }, content: bytes, mediaType: 'text/markdown' })
const version = await artifacts.publish(attempt.stageAttemptId, { artifactId, path: 'result.md', disposition: 'deliverable' })
const catalog = await artifacts.catalog(attempt.stageAttemptId, policy)
const preview = await artifacts.inspect(catalog.entries[0].artifactId, catalog.entries[0].version, { representation: 'structure' })
const body = await artifacts.read(attempt.stageAttemptId, id, version, { representation: 'content', consumer: 'execution' })
await artifacts.endAttempt(attempt.stageAttemptId, 'completed')
```

The service persists immutable bytes and metadata, emits ordered idempotent
events, and retains old versions. UI reads use `consumer: 'ui'` and never create
consumption receipts. `read` with `consumer: 'execution'` records the exact
artifact version. Catalogs are scoped by stage dependencies and are bounded by
policy. A candidate is not a deliverable and publication is not stage success.
