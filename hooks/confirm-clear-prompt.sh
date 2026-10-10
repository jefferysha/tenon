#!/usr/bin/env bash
# confirm-clear-prompt.sh — actual user-confirmation unlock for UserPromptSubmit.
#
# `confirm-clear.sh` is retained for hosts which expose AskUserQuestion responses.  Codex desktop's
# normal conversation path does not expose that tool, however, so clearing only on PostToolUse made a
# review marker self-lock every subsequent tool call.  This hook receives the user's next prompt and
# turns an explicit approval phrase into the canonical `tenon review acknowledge` receipt before
# the next PreToolUse gate runs.  It never deletes a v2 review marker by itself.
#
# It intentionally recognises a narrow, auditable set of affirmative phrases, and only when the WHOLE reply is
# one of them (prompt-intent.sh pipeline_text_is_approval_phrase): a phrase inside a longer text, a quotation or a
# paste is not consent.  Questions such as "为什么" or "看看状态" do not clear review evidence.  Fail-open:
# malformed hook input merely leaves the marker in place; it never blocks the user's prompt itself.
#
# Session scoping: parallel conversations share one project root.  Everything this hook mutates — the interaction
# marker it releases, the review it acknowledges, the InteractionConfirmed row, the continuous-execution authority —
# belongs to THIS conversation (host session id → pipeline_session_change_dir), never to the Change the
# per-user shared pointer happens to name.
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

# A pasted multi-MB log must not push this hook past the host timeout: keep only the prompt's first
# and last 8 KiB before any parsing (pipeline_prompt_bound_input, prompt-intent.sh).
INTENT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/prompt-intent.sh"
[ -r "$INTENT_HELPER" ] || exit 0
# shellcheck source=prompt-intent.sh
. "$INTENT_HELPER"
INPUT="$(pipeline_prompt_bound_input "$INPUT")" || exit 0

PROMPT="$(json_get prompt || true)"
[ -n "$PROMPT" ] || exit 0

# A one-turn confirmation and durable, Change-bound continuous-execution authority are different
# intents.  The latter must contain a deliberately strong phrase; a bare “继续执行” still clears
# only the current short-lived marker.  Revocation is also explicit and never falls through to
# marker-clearing, so a user can safely restore step-by-step questions.
INTENT="$(pipeline_prompt_approval_intent "$PROMPT" || true)"

# 项目根、共享 helper 与本会话 id。任何一步缺失都返回 1：没有「本会话」就不碰标记、不确认。
CP_READY=0
ROOT='' HOOK_DIR='' HOST_SESSION_ID=''
cp_load_context() {
  local cwd root_helper helper
  [ "$CP_READY" -eq 1 ] && return 0
  cwd="$(json_get cwd || true)"
  [ -n "$cwd" ] || cwd="$PWD"
  [ -d "$cwd" ] || return 1
  root_helper="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
  [ -r "$root_helper" ] || return 1
  # shellcheck source=project-root.sh
  . "$root_helper"
  ROOT="$(pipeline_project_root "$cwd" bootstrap changes || true)"
  [ -n "$ROOT" ] || return 1
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  [ -n "$HOOK_DIR" ] || return 1
  for helper in canonical-state.sh active-change.sh pending-marker.sh review-ack.sh; do
    [ -r "$HOOK_DIR/$helper" ] || return 1
    # shellcheck source=/dev/null
    . "$HOOK_DIR/$helper"
  done
  HOST_SESSION_ID="$(pipeline_hook_session_id "$INPUT")"
  CP_READY=1
}

# 有没有归属本会话的待处理项：confirm 标记（无归属）、归属本会话的交互标记（自己的分文件，或归属它的单文件）、
# 任务是本会话任务的评审标记。别的会话的标记不让本会话的 agent 误以为自己被锁住。
cp_session_has_pending() {
  local review_change mine
  [ -f "$ROOT/.pipeline-pending-confirm" ] && return 0
  pipeline_interaction_marker_pending "$ROOT" "$HOST_SESSION_ID" && return 0
  review_change="$(pipeline_review_marker_change "$ROOT/.pipeline-pending-review" 2>/dev/null || true)"
  if [ -n "$review_change" ]; then
    mine="$(pipeline_session_change_dir "$ROOT" "$HOST_SESSION_ID" || true)"
    [ "${mine##*/}" = "$review_change" ] && return 0
  fi
  return 1
}

# A reply that is not an approval never unlocks anything, but it must not be silent either: while an
# interaction/confirm/review marker of this conversation is pending, tell the agent this reply was not taken as
# approval and which reply unlocks it, so the user is never left guessing the phrase.
pending_unlock_hint_and_exit() {
  cp_load_context || exit 0
  cp_session_has_pending || exit 0
  printf '<tenon-pending-confirmation>\n本条回复未被识别为确认，待确认的交互或评审保持锁定。用户回复「确认继续」「继续执行」「同意继续」，或简短同意「继续」「可以」「同意」「好的」「按推荐」「按你的推荐」（采纳推荐项），即确认当前待决事项（评审按已请求的事件推进）；拒绝或带条件的回复不会解封，带条件的请先说明条件并重新提问；需整条回复：放行语夹在更长的文字、引用或粘贴里不算。\n</tenon-pending-confirmation>\n'
  exit 0
}
[ -n "$INTENT" ] || pending_unlock_hint_and_exit

# 拒绝或带约束的混合表达不是一次无条件 unlock。当前 v1 marker 还不能持久化细粒度
# constraints，因此安全行为是保留 exact pending target，让调用方展示约束后的下一动作；
# 绝不能因为文本里同时出现“继续/可以”就清掉整道门。
case "$INTENT" in
  reject|modify) pending_unlock_hint_and_exit ;;
esac

cp_load_context || exit 0

# A bare “继续” is both a resume phrase and, in an exact pending context, the user's natural
# approval.  It must not become a repository-wide unlock: without a pending marker of THIS conversation it
# remains resume-only and this hook exits without mutation.
if [ "$INTENT" = 'contextual-confirm' ]; then
  cp_session_has_pending || exit 0
  INTENT='confirm'
fi

# Resolve this conversation's live Change before issuing or revoking authority.  No Change of this conversation
# (for example a resumed session that has not re-activated yet), malformed canonical state, or a missing helper is
# fail-closed: normal confirmation remains available but no broad repo/session authority is ever created.
if [ "$INTENT" = 'authorize' ] || [ "$INTENT" = 'revoke' ]; then
  AUTHORITY_HELPER="$HOOK_DIR/interaction-authority.sh"
  if [ -r "$AUTHORITY_HELPER" ]; then
    # shellcheck source=interaction-authority.sh
    . "$AUTHORITY_HELPER"
    ACTIVE_DIR="$(pipeline_session_change_dir "$ROOT" "$HOST_SESSION_ID" || true)"
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
# from bypassing the exit gate.  The interaction marker is released only when it belongs to this conversation.
#
# Release is claimed with an atomic rename, not "test then rm": when the host runs this hook more than once for the
# same prompt (duplicate registrations run concurrently), every copy used to see the marker, each announced the
# release and each wrote the InteractionConfirmed rows.  Only the copy whose rename wins releases the lock, records
# the confirmation and announces it.
RELEASED_LOCK=0
INTERACTION_CLAIM="$ROOT/.pipeline-pending-interaction.claim.$$"
CONFIRM_CLAIM="$ROOT/.pipeline-pending-confirm.claim.$$"
pipeline_claim_interaction_marker "$ROOT" "$HOST_SESSION_ID" "$INTERACTION_CLAIM" && RELEASED_LOCK=1
mv "$ROOT/.pipeline-pending-confirm" "$CONFIRM_CLAIM" 2>/dev/null && RELEASED_LOCK=1

# Remember which interactive skill the user just approved in this step visit, so reading the same
# skill again (Codex re-reads a producer skill to record its document) does not ask again.  The row goes to
# THIS conversation's Change.
if [ -f "$INTERACTION_CLAIM" ]; then
  CONFIRMED_DIR="$(pipeline_session_change_dir "$ROOT" "$HOST_SESSION_ID" || true)"
  if [ -n "$CONFIRMED_DIR" ]; then
    CONFIRMED_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
    CONFIRMED_SKILLS="$(pipeline_interaction_marker_skills "$INTERACTION_CLAIM" || true)"
    CONFIRMED_SKILLS="${CONFIRMED_SKILLS//、/$'\n'}"
    while IFS= read -r CONFIRMED_SKILL; do
      case "$CONFIRMED_SKILL" in ''|*[!A-Za-z0-9_:-]*) continue ;; esac
      printf '{"ts":"%s","kind":"tool","raw":"%s"}\n' "$CONFIRMED_TS" \
        "$(pipeline_json_escape "InteractionConfirmed: $CONFIRMED_SKILL")" \
        >> "$CONFIRMED_DIR/.pipeline-history.jsonl" 2>/dev/null || true
    done <<< "$CONFIRMED_SKILLS"
  fi
fi

rm -f "$INTERACTION_CLAIM" "$CONFIRM_CLAIM" 2>/dev/null || true
# Announce a released lock: an agent that was blocked earlier otherwise assumes the gate still holds
# and stops without retrying the blocked action.
if [ "$RELEASED_LOCK" -eq 1 ]; then
  printf '<tenon-interaction-confirmed>\n用户已确认，待确认的交互已解封；请重试刚才被拦截的操作。\n</tenon-interaction-confirmed>\n'
fi

# Read the exact target before acknowledging: `tenon review acknowledge` removes the marker.
REVIEW_CHANGE="$(pipeline_review_marker_change "$ROOT/.pipeline-pending-review" 2>/dev/null || true)"
REVIEW_EVENT="$(pipeline_review_marker_event "$ROOT/.pipeline-pending-review" 2>/dev/null || true)"
REVIEW_ACKED=0
if [ "$INTENT" = 'authorize' ]; then
  pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" delegated "$HOST_SESSION_ID" && REVIEW_ACKED=1
else
  pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" manual "$HOST_SESSION_ID" && REVIEW_ACKED=1
fi
# Real session, round 4: the receipt was written and the marker removed, yet the agent — told
# nothing — answered that the gate "only accepts 确认继续" and did not move.  Say it was recorded.
if [ "$REVIEW_ACKED" -eq 1 ] && [ -n "$REVIEW_CHANGE" ]; then
  REVIEW_EVENT_NOTE=''
  [ -n "$REVIEW_EVENT" ] && REVIEW_EVENT_NOTE="（事件 ${REVIEW_EVENT}）"
  printf '<tenon-review-confirmed>\n用户本条回复已记录为对任务 %s 的评审确认%s：评审回执已写入（review.status=approved），不要再让用户说「确认继续」。现在执行 tenon status %s --json，照 next 推进（transition %s %s）。\n</tenon-review-confirmed>\n' \
    "$REVIEW_CHANGE" "$REVIEW_EVENT_NOTE" "$REVIEW_CHANGE" "$REVIEW_CHANGE" "${REVIEW_EVENT:-<event>}"
fi

exit 0
