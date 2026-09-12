import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SkillRunV2 } from '@tenon/kernel'
import { resultIdentity, stable, type RuntimeObservationV2 } from './runtime-v2-boundary.js'

export async function persistRuntimeOutputV2(
  changeDir: string,
  run: SkillRunV2,
  observation: RuntimeObservationV2,
): Promise<{ readonly ref: string; readonly digest: `sha256:${string}`; readonly byte_length: number }> {
  const resultId = resultIdentity(run.run_id)
  const directory = path.join(path.resolve(changeDir), '.tenon-artifacts', resultId)
  await mkdir(directory, { recursive: true })
  const output = stable(observation.output)
  const temporary = path.join(directory, `output.json.tmp-${randomUUID()}`)
  const target = path.join(directory, 'output.json')
  await writeFile(temporary, output, 'utf8')
  await rename(temporary, target)
  return { ref: `artifact://${resultId}/output.json`, digest: observation.output_digest, byte_length: observation.output_bytes }
}
