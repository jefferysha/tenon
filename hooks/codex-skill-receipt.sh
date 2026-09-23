#!/usr/bin/env bash
# codex-skill-receipt.sh — PreToolUse compatibility receipt for Codex bundled SKILL.md reads.
#
# Some Codex App/CLI execution paths invoke PreToolUse but omit the corresponding PostToolUse
# callback.  This hook records only a pending receipt pointing to the host-owned transcript.  It
# does NOT write `.pipeline-history.jsonl`; the CLI later verifies an actually completed matching
# custom_tool_call plus successful output before it appends normal CodexSkillRead evidence.
#
# The ordinary PostToolUse skill-tracker remains the primary path for hosts that deliver it.
# This narrow fallback is fail-open and intentionally spawns node only after all strict bundled
# asset checks pass.  It is not a generic command logger.
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }
json_command() { pipeline_json_get_command "$INPUT"; }

CWD="$(json_get cwd || true)"
[ -n "$CWD" ] || CWD="$PWD"
[ -d "$CWD" ] || exit 0
TOOL="$(json_get tool_name || true)"
pipeline_json_is_command_tool "$TOOL" || exit 0
# Only a command naming a SKILL.md can be a skill read; skip decoding every other (possibly huge) one.
case "$INPUT" in *SKILL.md*) ;; *) exit 0 ;; esac

EVIDENCE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/skill-evidence.sh"
[ -r "$EVIDENCE_HELPER" ] || exit 0
# shellcheck source=skill-evidence.sh
. "$EVIDENCE_HELPER"

COMMAND="$(json_command || true)"
# A single Codex exec can load several packaged skills (`sed … && sed …`).  Keep one pending
# receipt per exact cache asset; collapsing to the first path makes later document/DAG checks
# falsely report that a required skill was never called.
pipeline_codex_skill_read_paths "$COMMAND" >/dev/null 2>&1 || exit 0

# A receipt with no exact host transcript/turn/tool identity would be indistinguishable from a
# caller-created local file, so it is deliberately ignored rather than weakened into a fallback.
TRANSCRIPT_PATH="$(json_get transcript_path || true)"
SESSION_ID="$(json_get session_id || true)"
TURN_ID="$(json_get turn_id || true)"
TOOL_USE_ID="$(json_get tool_use_id || true)"
[ -n "$TRANSCRIPT_PATH" ] && [ -n "$SESSION_ID" ] && [ -n "$TURN_ID" ] && [ -n "$TOOL_USE_ID" ] || exit 0

ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
# shellcheck source=project-root.sh
. "$ROOT_HELPER"
PROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
[ -n "$PROOT" ] || exit 0

# A receipt must be tied to the exact Change selected by the pipeline entry skill.  Do not use a
# most-recent-state fallback here: that was the mechanism that let a new normal conversation
# borrow an unrelated old Change.  The phase skill instructions activate the selected Change
# before they read their own SKILL.md, so a missing pointer correctly means "no receipt yet".
STATE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/canonical-state.sh"
[ -r "$STATE_HELPER" ] || exit 0
# shellcheck source=canonical-state.sh
. "$STATE_HELPER"
ACTIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
[ -r "$ACTIVE_HELPER" ] || exit 0
# shellcheck source=active-change.sh
. "$ACTIVE_HELPER"
CHANGE_DIR="$(pipeline_active_change_dir "$PROOT" || true)"
[ -n "$CHANGE_DIR" ] || exit 0
CHANGE_NAME="${CHANGE_DIR##*/}"

# Receipt persistence is best-effort: a broken cache/runtime must not make a Codex read itself
# fail.  Later ledger/DAG checks remain fail-closed because no verified history evidence appears.
command -v node >/dev/null 2>&1 || exit 0
while IFS= read -r SKILL_PATH; do
  SKILL_ID="${SKILL_PATH%/SKILL.md}"
  SKILL_ID="${SKILL_ID##*/}"
  pipeline_safe_skill_id "$SKILL_ID" || continue
  # Bind to the same verified plugin root that supplied this exact SKILL.md path.  Do not use a
  # mutable marketplace root guessed from cwd or an arbitrary user-provided environment variable.
  PLUGIN_ROOT="${SKILL_PATH%/skills/$SKILL_ID/SKILL.md}"
  BUNDLE="$PLUGIN_ROOT/packages/cli/dist/tenon.mjs"
  [ -f "$BUNDLE" ] || continue
  (
    cd "$PROOT" || exit 0
    node "$BUNDLE" internal-codex-skill-receipt "$CHANGE_NAME" "$SKILL_ID" "$SKILL_PATH" "$TRANSCRIPT_PATH" "$SESSION_ID" "$TURN_ID" "$TOOL_USE_ID"
  ) >/dev/null 2>&1 || true
done < <(pipeline_codex_skill_read_paths "$COMMAND")

exit 0
