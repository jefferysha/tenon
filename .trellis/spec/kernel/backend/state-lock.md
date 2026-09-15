# State Lock Owner Identity (`state/lock.ts`)

## 1. Scope / Trigger

- `withLock(changeDir, fn)` guards every canonical Change write (`tenon init`, transitions, document records).
- Trigger: the owner record must stay usable when the current process start identity cannot be read. Codex's
  `workspace-write` sandbox denies executing `/bin/ps`
  (`sandbox-exec: execvp() of '/bin/ps' failed: Operation not permitted`); v1.1.0 failed every locked write
  there with `withLock: current process start identity is unavailable`, so `tenon init` could not run in Codex.

## 2. Signatures

```ts
export async function withLock<T>(changeDir: string, fn: () => Promise<T>): Promise<T>

// internal
processStartIdentity(pid: number): Promise<string | null>
//   linux: start time from /proc/<pid>/stat → `linux:<ticks>`; darwin: `/bin/ps -o lstart= -p <pid>` → `darwin:<lstart>`
processState(pid: number, expectedStart?: string): Promise<'alive' | 'dead' | 'unknown'>
```

## 3. Contracts

- Lock directory `<changeDir>/.pipeline.lock/`, owner file `owner.json`:
  `{ "version": 1, "owner": "<uuid>", "pid": <int>, "pidStart"?: "<identity>", "createdAt": <ms> }`.
  `pidStart` is written only when the identity is readable. A record without it is valid and has the same
  shape as records written before start identities existed.
- `processState(pid, expectedStart)`:
  - `kill(pid, 0)` throws `ESRCH` → `dead`; any other error (for example `EPERM` inside a sandbox) → `unknown`.
  - `kill` succeeds and `expectedStart` is absent → `alive`.
  - `kill` succeeds, identity unreadable → `alive`; readable and equal → `alive`; readable and different → `dead`.
- Reclaim an existing lock only when `processState === 'dead'`, or when
  `ageMs > STALE_LOCK_MS (60_000)` and `processState !== 'alive'`. The holder's heartbeat refreshes the owner
  file mtime, so a live owner never ages past the threshold.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Own start identity unreadable (sandbox denies `ps`, restricted `/proc`) | Acquire succeeds; `owner.json` has `pid`, no `pidStart` |
| Owner pid no longer exists | `dead` → reclaimed immediately |
| Owner pid exists, record without `pidStart` | Kept (a reused pid keeps it until that process exits: fail closed) |
| Sandboxed observer gets `EPERM` probing another pid | `unknown` → reclaimed only after the owner heartbeat is stale |
| Waiting longer than `ACQUIRE_TIMEOUT_MS` | Throw `withLock: acquire timeout after …` |

## 5. Good / Base / Bad Cases

- Good: a host process that can run `ps` records `pidStart`, so a recycled pid is detected as `dead`.
- Base: inside Codex the record omits `pidStart`; concurrent holders still serialize and the lock is released normally.
- Bad: throwing when the identity is unreadable — every write in Codex fails before any work (v1.1.0).

## 6. Tests Required

- `state/lock.sandbox.test.ts` (mocks `spawnSync` for `ps` and `readFile` for `/proc/` to fail):
  `withLock` returns the callback value, `owner.json` contains `version: 1` and `pid` and no `pidStart`,
  the lock directory is gone afterwards, and two concurrent holders never interleave.
- `state/lock.test.ts`: stale reclaim, immediate reclaim of an exited owner, a live owner is never reclaimed,
  release removes only the holder's own owner token.

## 7. Wrong vs Correct

### Wrong

```ts
const processStart = await processStartIdentity(process.pid)
if (processStart === null) throw new Error('withLock: current process start identity is unavailable')
```

### Correct

```ts
const processStart = await processStartIdentity(process.pid)
const record: LockOwnerRecord = {
  version: 1,
  owner,
  pid: process.pid,
  ...(processStart === null ? {} : { pidStart: processStart }),
  createdAt: Date.now(),
}
```
