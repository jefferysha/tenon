# Host Install and Inventory

Contracts between Tenon's installer / doctor and the two native hosts (Claude Code, Codex). All three were
found by installing the published release and running real tasks, not by unit tests.

## Scenario: Stable release proof survives a dropped GitHub connection

### 1. Scope / Trigger

- `install.sh` → `tenon setup` proves the published tag before activating a runtime.
- Trigger: on a slow proxy the proof failed once with `spawnSync /usr/bin/git ETIMEDOUT` and once with
  `LibreSSL SSL_connect: SSL_ERROR_SYSCALL`, aborting the whole Codex install although the network recovered.

### 2. Signatures

```ts
// packages/cli/src/commands/stable-release.ts
resolveStableTagTarget(env: SetupEnv, version: string): StableReleaseTarget
resolveStableReleaseTarget(env: SetupEnv, http?: StableReleaseHttp): Promise<StableReleaseTarget>
// remote calls, each through runRemoteGit(env, args)
git ls-remote https://github.com/jefferysha/tenon.git refs/tags/v<ver> refs/tags/v<ver>^{}
git -C <proofRoot> fetch --no-tags --depth=1 https://github.com/jefferysha/tenon.git refs/tags/v<ver>
```

### 3. Contracts

- Each remote call: timeout `STABLE_RELEASE_GIT_REMOTE_TIMEOUT_MS = 60_000`, at most
  `STABLE_RELEASE_REMOTE_ATTEMPTS = 3` attempts, pause `500 ms × attempt` between attempts.
- Retry only when the exit is non-zero and stderr matches the transport pattern (case-insensitive, `/iu`):
  `ETIMEDOUT | timed out | SSL_ERROR | SSL_connect | unable to access | Could not resolve host |
  Connection (reset|refused|timed out) | Failed to connect | early EOF | RPC failed | remote end hung up`.
- After a successful attempt the result is validated exactly as before: advertised refs parsed, fetched object is a
  commit, commit equals the advertised peeled commit. Local calls (`init`, `rev-parse`, `cat-file`) keep
  `10_000` ms and never retry.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Transient failure, then success | Target resolved; one extra call per failed attempt |
| Transient failure on all 3 attempts | Throw `stable Release tag proof failed after 3 attempts: <stderr>` (or `object proof`) |
| Non-transient failure (`couldn't find remote ref`, ambiguous refs) | Throw on the first attempt, no retry |
| Fetched object is not a commit / differs from advertised | Throw (`does not resolve to a commit object` / `does not match its advertised peeled commit`) |

### 5. Good / Base / Bad Cases

- Good: one TLS reset during the fetch → retried → install completes.
- Base: healthy network → exactly `ls-remote, init, fetch, rev-parse, cat-file`.
- Bad: retrying a missing tag — hides a real release error and delays the failure.

### 6. Tests Required

- `commands/stable-release.test.ts`: a transient fetch failure then success resolves the commit with command
  sequence `ls-remote, init, fetch, fetch, rev-parse, cat-file`; a persistent `ETIMEDOUT` on `ls-remote` throws
  `after 3 attempts` with 3 calls; `couldn't find remote ref` on fetch throws with a single fetch; the success path
  keeps the 60 000 / 10 000 ms budgets.

### 7. Wrong vs Correct

#### Wrong

```ts
const fetched = env.runCommand('git', fetchArgs, { timeoutMs: STABLE_RELEASE_GIT_REMOTE_TIMEOUT_MS })
if (fetched.code !== 0) throw new Error(`stable Release object proof failed: ${fetched.stderr}`)
```

#### Correct

```ts
const fetched = runRemoteGit(env, fetchArgs)
if (fetched.result.code !== 0) throw remoteFailure('stable Release object proof', fetched)
```

## Scenario: Claude plugin manifest must not declare the standard hooks file

### 1. Scope / Trigger

- Claude Code 2.1 loads `hooks/hooks.json` automatically. A manifest that also references it fails the whole plugin:
  `Hook load failed: Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file …` — no skills,
  no hooks (v1.1.0 in Claude Code 2.1.270).

### 2. Signatures

- `.claude-plugin/plugin.json`: `{ name, description, version, author, license, keywords, skills: "./skills/" }`.
- `.codex-plugin/plugin.json`: keeps `"hooks": "./hooks/hooks.json"` (Codex requires it).

### 3. Contracts

- The Claude manifest has no `hooks` key. Additional hook files, if ever needed, must not be the standard file.
- `tools/verify-skills.sh` fails with `Claude plugin.json 声明了 hooks（…）` when the key is present.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Claude manifest declares `hooks` | `verify-skills` fails; in Claude Code the plugin fails to load |
| Codex manifest lacks `hooks` | Codex loads no Tenon hooks (keep the key there) |

### 5. Good / Base / Bad Cases

- Good: `claude plugin list --json` → Tenon `errors: []`, `claude plugin details tenon@tenon` → Hooks (4), Skills (70).
- Base: older Claude versions also auto-load the standard location, so omitting the key is backward compatible.
- Bad: copying the Codex manifest's `hooks` key into the Claude manifest.

### 6. Tests Required

- `tools/test-hooks.sh`: the sandbox manifest with `"hooks": "./hooks/hooks.json"` makes `verify-skills` report
  `Claude plugin.json 声明了 hooks`.

### 7. Wrong vs Correct

#### Wrong

```json
{ "name": "tenon", "skills": "./skills/", "hooks": "./hooks/hooks.json" }
```

#### Correct

```json
{ "name": "tenon", "skills": "./skills/" }
```

## Scenario: Doctor reports a host that failed to load Tenon

### 1. Scope / Trigger

- A plugin that fails to load stays `enabled` in the host inventory; only its `errors` array tells it apart. v1.1.0
  doctor was all green while Claude Code could not load Tenon.

### 2. Signatures

```ts
// packages/cli/src/commands/plugin-host.ts
parseHostPluginInventory(host: 'codex' | 'claude', stdout: string): ParsedHostPluginInventory | null
interface ParsedHostPluginInventory { enabledIds; enabledScopes; tenonRoot; tenonVersion; tenonRegistered; tenonLoadErrors: readonly string[] }
// packages/cli/src/deps.ts
HostPluginInventorySource = { kind: 'native'; host; enabledIds; tenonLoadErrors?: readonly string[] } | { kind: 'static' } | { kind: 'unavailable'; host; detail }
```

### 3. Contracts

- `tenonLoadErrors` collects the string entries of `errors` on the `tenon@tenon` entry only; other plugins' errors
  are ignored.
- Doctor check `integration:codex-project-skills` is red when `tenonLoadErrors` is non-empty:
  detail `<Claude|Codex> 报告 Tenon 插件加载失败：<errors joined by ；>`,
  hint `运行 tenon setup --<host> -y 安装当前正式版本并新开会话；…`.

### 4. Validation & Error Matrix

| Condition | Doctor |
| --- | --- |
| Inventory JSON malformed | red: inventory unavailable |
| Tenon not registered | red: no unique Tenon registration |
| Tenon registered with load errors | red: load failed, errors listed |
| Tenon registered, no errors | continue to skill-root checks |

### 5. Good / Base / Bad Cases

- Good: v1.1.0 in Claude Code 2.1 → doctor red with the duplicate-hooks message.
- Base: `errors: []` → no new finding.
- Bad: treating `enabled: true` as healthy.

### 6. Tests Required

- `commands/update.test.ts`: `parseHostPluginInventory('claude', …)` keeps Tenon's errors and ignores another
  plugin's; an entry with `errors: []` yields `[]`.
- `commands/doctor.test.ts`: a native Claude inventory with `tenon@tenon` enabled and a load error → `code 1`,
  check red, detail contains `加载失败` and the error text, hint contains `tenon setup --claude`.

### 7. Wrong vs Correct

#### Wrong

```ts
if (!hostPluginIds.has(TENON_PLUGIN_IDENTITY)) return red(…)   // enabled ⇒ healthy
```

#### Correct

```ts
const loadErrors = inventory.tenonLoadErrors ?? []
if (loadErrors.length > 0) return red('integration:codex-project-skills', `… 报告 Tenon 插件加载失败：${loadErrors.join('；')}`, …)
```
