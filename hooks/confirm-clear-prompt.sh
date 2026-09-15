#!/usr/bin/env bash
# confirm-clear-prompt.sh — actual user-confirmation unlock for UserPromptSubmit.
#
# `confirm-clear.sh` is retained for hosts which expose AskUserQuestion responses.  Codex desktop's
# normal conversation path does not expose that tool, however, so clearing only on PostToolUse made a
# review marker self-lock every subsequent tool call.  This hook receives the user's next prompt and
# turns an explicit approval phrase into the canonical `tenon review acknowledge` receipt before
# the next PreToolUse gate runs.  It never deletes a v2 review marker by itself.
#
# It intentionally recognises a narrow, auditable set of affirmative phrases.  Questions such as
# "为什么" or "看看状态" do not clear review evidence.  Fail-open: malformed hook input merely leaves
# the marker in place; it never blocks the user's prompt itself.
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

PROMPT="$(json_get prompt || true)"
[ -n "$PROMPT" ] || exit 0

# A one-turn confirmation and durable, Change-bound continuous-execution authority are different
# intents.  The latter must contain a deliberately strong phrase; a bare “继续执行” still clears
# only the current short-lived marker.  Revocation is also explicit and never falls through to
# marker-clearing, so a user can safely restore step-by-step questions.
INTENT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/prompt-intent.sh"
[ -r "$INTENT_HELPER" ] || exit 0
# shellcheck source=prompt-intent.sh
. "$INTENT_HELPER"
INTENT="$(pipeline_prompt_approval_intent "$PROMPT" || true)"

# A reply that is not an approval never unlocks anything, but it must not be silent either: while an
# interaction/confirm marker is pending, tell the agent this reply was not taken as approval and which
# reply unlocks it, so the user is never left guessing the phrase.
pending_unlock_hint_and_exit() {
  local hint_cwd hint_root hint_helper
  hint_cwd="$(json_get cwd || true)"
  [ -n "$hint_cwd" ] || hint_cwd="$PWD"
  hint_helper="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
  [ -d "$hint_cwd" ] && [ -r "$hint_helper" ] || exit 0
  # shellcheck source=project-root.sh
  . "$hint_helper"
  hint_root="$(pipeline_project_root "$hint_cwd" bootstrap changes || true)"
  [ -n "$hint_root" ] || exit 0
  [ -f "$hint_root/.pipeline-pending-interaction" ] || [ -f "$hint_root/.pipeline-pending-confirm" ] || exit 0
  printf '<tenon-pending-confirmation>\n本条回复未被识别为确认，待确认的交互保持锁定。用户回复「确认继续」即解封；带条件的回复请先说明条件并重新提问。\n</tenon-pending-confirmation>\n'
  exit 0
}
[ -n "$INTENT" ] || pending_unlock_hint_and_exit

# 拒绝或带约束的混合表达不是一次无条件 unlock。当前 v1 marker 还不能持久化细粒度
# constraints，因此安全行为是保留 exact pending target，让调用方展示约束后的下一动作；
# 绝不能因为文本里同时出现“继续/可以”就清掉整道门。
case "$INTENT" in
  reject|modify) pending_unlock_hint_and_exit ;;
esac

CWD="$(json_get cwd || true)"
[ -n "$CWD" ] || CWD="$PWD"
[ -d "$CWD" ] || exit 0
HOST_SESSION_ID="$(json_get session_id || true)"
case "$HOST_SESSION_ID" in ''|*[!A-Za-z0-9_-]*) HOST_SESSION_ID='' ;; esac
[ "${#HOST_SESSION_ID}" -le 128 ] || HOST_SESSION_ID=''

ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
[ -r "$ROOT_HELPER" ] || exit 0
# shellcheck source=project-root.sh
. "$ROOT_HELPER"
ROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
[ -n "$ROOT" ] || exit 0

# A bare “继续” is both a resume phrase and, in an exact pending context, the user's natural
# approval.  It must not become a repository-wide unlock: without a pending marker in this exact
# project it remains resume-only and this hook exits without mutation.
if [ "$INTENT" = 'contextual-confirm' ]; then
  if [ ! -f "$ROOT/.pipeline-pending-confirm" ] \
    && [ ! -f "$ROOT/.pipeline-pending-interaction" ] \
    && [ ! -f "$ROOT/.pipeline-pending-review" ]; then
    exit 0
  fi
  INTENT='confirm'
fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

# Resolve an exact selected live Change before issuing or revoking authority.  No active Change,
# malformed canonical state, or a missing helper is fail-closed: normal confirmation remains
# available but no broad repo/session authority is ever created.
if [ "$INTENT" = 'authorize' ] || [ "$INTENT" = 'revoke' ]; then
  AUTHORITY_HELPER="$HOOK_DIR/interaction-authority.sh"
  STATE_HELPER="$HOOK_DIR/canonical-state.sh"
  ACTIVE_HELPER="$HOOK_DIR/active-change.sh"
  if [ -r "$AUTHORITY_HELPER" ] && [ -r "$STATE_HELPER" ] && [ -r "$ACTIVE_HELPER" ]; then
    # shellcheck source=interaction-authority.sh
    . "$AUTHORITY_HELPER"
    # shellcheck source=canonical-state.sh
    . "$STATE_HELPER"
    # shellcheck source=active-change.sh
    . "$ACTIVE_HELPER"
    ACTIVE_DIR="$(pipeline_active_change_dir "$ROOT" || true)"
    ACTIVE_NAME="${ACTIVE_DIR##*/}"
    if [ -n "$ACTIVE_DIR" ] && [ -n "$HOST_SESSION_ID" ]; then
      if [ "$INTENT" = 'authorize' ]; then
        pipeline_write_interaction_authority "$ROOT" "$ACTIVE_NAME" "$HOST_SESSION_ID" \
          && pipeline_record_interaction_authority_event "$ROOT" "$ACTIVE_NAME" enabled "$HOST_SESSION_ID" || true
      else
        pipeline_revoke_interaction_authority "$ROOT" "$ACTIVE_NAME" "$HOST_SESSION_ID" \
          && pipeline_record_interaction_authority_event "$ROOT" "$ACTIVE_NAME" revoked "$HOST_SESSION_ID" || true
      fi
    fi
  fi
fi

# A revocation only changes the persistent authority projection.  It must not accidentally clear
# a fresh interaction/review safety marker while the user is asking to return to explicit prompts.
[ "$INTENT" = 'revoke' ] && exit 0

# Confirm/interaction markers do not carry a canonical review receipt and retain their original
# idempotent clear-on-explicit-approval semantics.  The review marker is intentionally excluded:
# the CLI owns both its removal and the durable approval state, preventing a hook-only deletion
# from bypassing the exit gate.
# Remember which interactive skill the user just approved in this step visit, so reading the same
# skill again (Codex re-reads a producer skill to record its document) does not ask again.
if [ -f "$ROOT/.pipeline-pending-interaction" ] \
  && [ -r "$HOOK_DIR/canonical-state.sh" ] && [ -r "$HOOK_DIR/active-change.sh" ]; then
  # shellcheck source=canonical-state.sh
  . "$HOOK_DIR/canonical-state.sh"
  # shellcheck source=active-change.sh
  . "$HOOK_DIR/active-change.sh"
  CONFIRMED_DIR="$(pipeline_active_change_dir "$ROOT" || true)"
  if [ -n "$CONFIRMED_DIR" ]; then
    CONFIRMED_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
    CONFIRMED_SKILLS="$(<"$ROOT/.pipeline-pending-interaction")"
    CONFIRMED_SKILLS="${CONFIRMED_SKILLS//、/$'\n'}"
    while IFS= read -r CONFIRMED_SKILL; do
      case "$CONFIRMED_SKILL" in ''|*[!A-Za-z0-9_:-]*) continue ;; esac
      printf '{"ts":"%s","kind":"tool","raw":"%s"}\n' "$CONFIRMED_TS" \
        "$(pipeline_json_escape "InteractionConfirmed: $CONFIRMED_SKILL")" \
        >> "$CONFIRMED_DIR/.pipeline-history.jsonl" 2>/dev/null || true
    done <<< "$CONFIRMED_SKILLS"
  fi
fi

RELEASED_LOCK=0
if [ -f "$ROOT/.pipeline-pending-interaction" ] || [ -f "$ROOT/.pipeline-pending-confirm" ]; then RELEASED_LOCK=1; fi
rm -f "$ROOT/.pipeline-pending-confirm" \
      "$ROOT/.pipeline-pending-interaction" 2>/dev/null || true
# Announce a released lock: an agent that was blocked earlier otherwise assumes the gate still holds
# and stops without retrying the blocked action.
if [ "$RELEASED_LOCK" -eq 1 ]; then
  printf '<tenon-interaction-confirmed>\n用户已确认，待确认的交互已解封；请重试刚才被拦截的操作。\n</tenon-interaction-confirmed>\n'
fi

REVIEW_HELPER="$HOOK_DIR/review-ack.sh"
if [ -r "$REVIEW_HELPER" ]; then
  # shellcheck source=review-ack.sh
  . "$REVIEW_HELPER"
  if [ "$INTENT" = 'authorize' ]; then
    pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" delegated "$HOST_SESSION_ID" || true
  else
    pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" manual || true
  fi
fi

exit 0
