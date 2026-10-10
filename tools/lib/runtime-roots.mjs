/**
 * The runtime roots a child process must not inherit from the machine's Tenon launcher.
 *
 * Kept free of imports and of `import.meta.url` on purpose: tools/vitest.isolate-runtime-home.mjs loads it as a setup file in
 * every vitest environment, including the dashboard-app jsdom one, where a heavier module (tools/lib/isolated-tenon.mjs) cannot
 * be loaded; tools/verify-action-selftest.mjs loads it from a runner-shaped checkout that carries only the files it needs.
 * Callers that already use tools/lib/isolated-tenon.mjs import both names from there.
 */

/**
 * The runtime roots the stable launcher / bootstrap export (packages/cli/src/runtime/launchers.ts, runtime/tenon-bootstrap.mjs).
 * resolveProductPaths gives `TENON_RUNTIME_ROOTS` priority over `TENON_RUNTIME_HOME`, and the hooks read the three per-root
 * variables directly, so a child that inherits any of them reads and writes the machine's real Tenon state no matter what
 * `TENON_RUNTIME_HOME` says.
 */
export const INHERITED_RUNTIME_ROOT_VARS = Object.freeze([
  'TENON_RUNTIME_ROOTS',
  'TENON_RUNTIME_DATA_ROOT',
  'TENON_RUNTIME_STATE_ROOT',
  'TENON_RUNTIME_CONFIG_ROOT',
])

/**
 * A copy of `env` without the inherited runtime roots, so that a `TENON_RUNTIME_HOME` set on it decides every Tenon path.
 * Every place that builds a child environment meant to be isolated (`{ ...process.env, TENON_RUNTIME_HOME }`) goes through it;
 * the launcher exports the real roots to anything run under `tenon test run`, so those children would otherwise write the real state
 * (2026-10-08: the bench fixture registered its temporary projects in the user's real projects.json). The input is not modified.
 */
export function withoutInheritedRuntimeRoots(env) {
  const clean = { ...env }
  for (const name of INHERITED_RUNTIME_ROOT_VARS) delete clean[name]
  return clean
}
