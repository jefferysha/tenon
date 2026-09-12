import { readFile, writeFile } from 'node:fs/promises'
import { openArtifactService } from '../../../packages/automation/src/artifacts/service.js'
const evidencePath = '.trellis/tasks/09-12-fix-artifact-runtime-followups/production-runtime-e2e.json'
const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as { root: string; catalog: { entries: Array<{ artifactId: string; version: string }> }; events: unknown[]; followupAssertions: Record<string, unknown> }
const service = await openArtifactService({ rootDir: evidence.root, scopeId: 'runtime-artifacts' })
for (const entry of evidence.catalog.entries) await service.runChecks(entry.artifactId, entry.version)
evidence.events = await service.events(0, 1000)
evidence.followupAssertions.qualityChecks = evidence.events.filter((event) => (event as { type?: string }).type === 'artifact.checked').length
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ qualityChecks: evidence.followupAssertions.qualityChecks }))
