/**
 * Untracked test evidence files (internal to the workspace fingerprint; not exported from the package).
 *
 * A test run writes logs, reports and screenshots into `test-results/`, `playwright-report/` and `coverage/`.
 * They are verification output, not implementation, so a fingerprint that counted them would be invalidated by
 * the very run that attests it, unless every catalog declares every file.  This module is the general rule that
 * saves the declaration: below one of those directories (any depth), a file is left out of the fingerprint when
 *
 *   · git does not track it (neither committed nor staged), and
 *   · its extension (lower-cased) is an evidence format (`EVIDENCE_EXTENSIONS`).
 *
 * Everything else stays in the candidate, so the conventional directory names cannot hide source: tracked files,
 * script and source extensions (`coverage/hook.js`, even spelled `.JS`), files without an extension, symbolic
 * links and directories all count as before.  So do the formats code or a browser can load or unpack straight
 * from these directories (`json`, `html`, `htm`, `zip`, `gz`, `har`): a `test-results/x.html` can carry script
 * and a `coverage/x.json` can be read back by the code under test, so a suite that really produces them
 * declares them as outputs.  Only regular files are ever judged (the caller checks the type).
 *
 * Git is asked about tracking only for these directories, once per outermost one (`git ls-files -z -- <dir>`,
 * the same environment scrubbing, timeout and `.git` pinning as the host-local query).  When git cannot answer
 * (missing, timed out, not a repository, corrupt index) the scope is inactive and every file below counts:
 * unknown must never widen what the fingerprint leaves out.
 */
import { extname } from 'node:path'
import { foldAsciiCase, lsCachedFiles } from './host-local.js'

/**
 * The directory names a declared test output must live under.  A declaration can only hide files
 * inside such a directory, never source: the catalog and workflow validators enforce this, so a
 * suite cannot exclude `src/` from the candidate by "declaring" it as an artifact.  They are also the
 * directories the general evidence rule applies to.
 */
export const TEST_OUTPUT_DIR_SEGMENTS = ['test-results', 'playwright-report', 'coverage'] as const

/** Extensions of files a test run produces as evidence: inert text and media that nothing loads or executes. */
const EVIDENCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'log', 'txt', 'xml', 'md', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'webm', 'mp4',
  'lcov', 'info',
])

/** What is known below one outermost test-output directory. */
export interface EvidenceScope {
  /**
   * The tracked paths below the directory, as `trackedKey` spells them; `undefined` when git could not answer
   * (the scope is then inactive and nothing below counts as evidence).
   */
  readonly tracked: ReadonlySet<string> | undefined
}

/** Whether the scope can leave anything out: git answered. */
export function evidenceScopeActive(scope: EvidenceScope | undefined): boolean {
  return scope?.tracked !== undefined
}

/**
 * How a path is compared with git's index.  The disk and the index may spell the same file differently: ASCII case
 * on a case-insensitive file system, and composed / decomposed Unicode on macOS.  Folding both sides can only make
 * more paths look tracked, which only ever makes the fingerprint count more.
 */
function trackedKey(path: string): string {
  return foldAsciiCase(path.normalize('NFC'))
}

/**
 * The tracked files below `dir` (a root-relative path, forward slashes), or `undefined` when git cannot say.
 * The directory is a literal pathspec (`:(literal,icase)`): a name with glob characters matches only itself, and
 * an index that spells the directory in another case is still found.
 */
async function trackedUnder(root: string, dir: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const paths = await lsCachedFiles(root, [`:(literal,icase)${dir}`])
    return new Set(paths.map(trackedKey))
  } catch {
    return undefined
  }
}

/**
 * The scope that applies below `relativePath`: the current one when already inside a test-output directory
 * (nested ones, such as `coverage/test-results/`, are covered by the outermost query), a fresh one when this
 * directory is itself named like one, otherwise none.
 */
export async function enterEvidenceScope(
  root: string,
  relativePath: string,
  current: EvidenceScope | undefined,
): Promise<EvidenceScope | undefined> {
  if (current !== undefined) return current
  const name = relativePath.split('/').at(-1) ?? ''
  if (!(TEST_OUTPUT_DIR_SEGMENTS as readonly string[]).includes(name)) return undefined
  return { tracked: await trackedUnder(root, relativePath) }
}

/**
 * Whether a regular file at `relativePath` is untracked test evidence.  The caller passes only regular files:
 * directories named `x.json` and symbolic links named `x.log` must still count.
 */
export function isUntrackedEvidence(relativePath: string, scope: EvidenceScope | undefined): boolean {
  if (scope?.tracked === undefined) return false
  if (!EVIDENCE_EXTENSIONS.has(extname(relativePath).slice(1).toLowerCase())) return false
  return !scope.tracked.has(trackedKey(relativePath))
}
