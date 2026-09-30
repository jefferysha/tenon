/**
 * `/proc/self/fd/<n>` and `/dev/fd/<n>` name an entry in *this* process's descriptor table. A spawned git
 * resolves such a path against its own table, where the descriptor was never opened, and fails with a
 * misleading `cannot change to …: No such file or directory`. A child process must be handed a real path,
 * so these are refused by name instead of turning into an unexplained non-zero exit.
 *
 * Its own module so a low-level reader (the workspace fingerprint) can recognize the alias without
 * importing the git probes.
 */
const PROCESS_LOCAL_FD_PATH = /^\/(?:proc\/(?:self|[0-9]+)|dev)\/fd\/[0-9]+(?:\/|$)/u

export function isProcessLocalFdPath(path: string): boolean {
  return PROCESS_LOCAL_FD_PATH.test(path)
}
