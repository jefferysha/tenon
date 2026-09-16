import type { ProductPathInput } from '@tenon/kernel'
import type { CodexAuthStatus } from '../codexAuth.js'
import type {
  LegacyProjectRegistryMigrationInput,
  LegacyProjectRegistryMigrationResult,
} from '../migration/legacy-project-registry.js'
import type { NativeHostCommandEnvironment } from './native-host-command-binding.js'
import type { CandidatePayloadIdentity } from '../runtime/release-store.js'
import type { UpstreamSkillInstallInput, UpstreamSkillInstallResult } from '../upstream-skills/install.js'

export interface SetupEnv extends NativeHostCommandEnvironment {
  homeDir(): string
  runtimeEnv(): NonNullable<ProductPathInput['env']>
  /** Browser policy only; absence preserves compatibility for injected test/adapter environments. */
  isInteractive?(): boolean
  pluginRoot(): string | null
  selfPath(): string
  pathExists(path: string): boolean
  readText(path: string): string | undefined
  readTextState(path: string):
    | { readonly state: 'ok'; readonly text: string }
    | { readonly state: 'missing' }
    | { readonly state: 'error'; readonly detail: string }
  mkdirp(dir: string): void
  /** Generic PATH discovery preserves project-local tool directories. */
  commandExists(name: string): boolean
  codexAuthStatus(
    codexExecutable?: string,
    commandBinding?: import('./native-host-command-binding.js').NativeHostCommandBinding,
  ): Promise<CodexAuthStatus>
  listDir(dir: string): string[]
  writeText(path: string, text: string): void
  writeTextAtomic(path: string, text: string): void
  /** Test/adapter seam; production leaves this absent and uses the trusted Bash payload verifier. */
  inspectCandidatePayload?(root: string): Promise<CandidatePayloadIdentity>
  /** Test seam; production leaves this absent and fetches upstream skills with git. */
  installUpstreamSkills?(input: UpstreamSkillInstallInput): Promise<UpstreamSkillInstallResult>
  migrateProjectRegistry?(
    input: LegacyProjectRegistryMigrationInput,
  ): Promise<LegacyProjectRegistryMigrationResult>
  confirm(question: string): boolean
}
