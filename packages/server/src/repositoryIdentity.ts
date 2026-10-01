import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { ProjectRepositoryIdentity } from './types.js'

const REPOSITORY_IDENTITY_TIMEOUT_MS = 1_500
const REPOSITORY_IDENTITY_MAX_OUTPUT_BYTES = 4_096
const REPOSITORY_IDENTITY_ARGS = [
  'rev-parse',
  '--path-format=absolute',
  '--git-common-dir',
  '--show-toplevel',
  '--git-dir',
] as const

function runGitRepositoryIdentity(
  root: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile('git', [...args], {
      cwd: root,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: REPOSITORY_IDENTITY_MAX_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolveOutput(stdout)
    })
  })
}

export interface RepositoryIdentityProbeDeps {
  runGit?: (root: string, args: readonly string[], timeoutMs: number) => Promise<string>
}

export async function readRepositoryIdentity(
  root: string,
  probe: (root: string) => Promise<ProjectRepositoryIdentity | undefined> = probeRepositoryIdentity,
): Promise<ProjectRepositoryIdentity | undefined> {
  try {
    return await probe(root)
  } catch {
    return undefined
  }
}

export function normalizeRepositoryLabels<P extends { readonly root: string; readonly repository?: ProjectRepositoryIdentity }>(projects: readonly P[]): P[] {
  const labels = new Map<string, { label: string; primary: boolean; root: string }>()
  for (const project of projects) {
    const repository = project.repository
    if (repository === undefined) continue
    const candidate = {
      label: repository.label,
      primary: repository.workspace_kind === 'primary',
      root: project.root,
    }
    const current = labels.get(repository.id)
    if (current === undefined
      || (candidate.primary && !current.primary)
      || (candidate.primary === current.primary
        && `${candidate.label}\0${candidate.root}` < `${current.label}\0${current.root}`)) {
      labels.set(repository.id, candidate)
    }
  }
  return projects.map((project): P => {
    const repository = project.repository
    if (repository === undefined) return project
    const label = labels.get(repository.id)?.label ?? repository.label
    return label === repository.label
      ? project
      : { ...project, repository: { ...repository, label } }
  })
}

export async function probeRepositoryIdentity(
  root: string,
  deps: RepositoryIdentityProbeDeps = {},
): Promise<ProjectRepositoryIdentity | undefined> {
  let output: string
  try {
    output = await (deps.runGit ?? runGitRepositoryIdentity)(
      root,
      REPOSITORY_IDENTITY_ARGS,
      REPOSITORY_IDENTITY_TIMEOUT_MS,
    )
  } catch {
    return undefined
  }
  const lines = output.trim().split(/\r?\n/)
  if (lines.length !== 3) return undefined
  const [commonDirectoryRaw, topLevelRaw, gitDirectoryRaw] = lines
  if (!commonDirectoryRaw || !topLevelRaw || !gitDirectoryRaw
    || !isAbsolute(commonDirectoryRaw) || !isAbsolute(topLevelRaw)
    || !isAbsolute(gitDirectoryRaw)) return undefined
  const commonDirectory = normalize(resolve(commonDirectoryRaw))
  const topLevel = normalize(resolve(topLevelRaw))
  const gitDirectory = normalize(resolve(gitDirectoryRaw))
  const commonName = basename(commonDirectory)
  const conventionalDotGit = commonName === '.git'
    && (commonDirectory === normalize(resolve(join(topLevel, '.git')))
      || gitDirectory !== commonDirectory)
  const label = conventionalDotGit
    ? basename(dirname(commonDirectory))
    : commonName.endsWith('.git') && commonName.length > '.git'.length
      ? commonName.slice(0, -'.git'.length)
      : basename(topLevel)
  if (!label) return undefined
  return {
    id: createHash('sha256').update(commonDirectory).digest('hex'),
    label,
    workspace_kind: gitDirectory === commonDirectory ? 'primary' : 'worktree',
  }
}
