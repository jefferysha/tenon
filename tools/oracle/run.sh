#!/usr/bin/env bash
# tools/oracle/run.sh — T6 golden-oracle 双跑 harness
#
# 对同一 fixture 项目分别跑老内核 bash 状态机（oracle）与新 TS CLI，对
# init / get / set / transition / check 逐命令比三面：stdout、exit code、
# 落盘 openspec/changes/<name>/.pipeline.yaml（逐字 diff）。
#
# 白名单（只放宽以下兼容差异，其余逐字）：
#   · 时间戳字段值：`*_at` 字段只比 key 存在性（值统一归一为 <WHITELISTED>）
#   · 老内核历史区块：tools_history / prompts_history / transitions_history 的
#     key 行 + `  - ` 项行两侧剥除后再 diff（老内核 transition 会往 yaml 追加历史项，
#     lite 契约写 .pipeline-history.jsonl）。fixture 预置的历史尾块另做 PRESERVE
#     校验：全程跑完后新侧 yaml 必须逐字保留基线块（CONTRACT §1「读时跳过、写回原样」）。
#   · check 的 stdout 是人读 guard 报告（CONTRACT §3），stdout 面记 SKIP、exit 面照比。
#   · G1 canonical cutover 的 `pipeline_state_revision/_id/_digest` 是 YAML adapter 指向唯一
#     current 的投影元数据；老内核没有 canonical store，三行整行剥除后再比业务投影。
#   · `tenon-internal-transition-head-v1` 是当前运行时写入 YAML opaque tail 的 canonical head
#     digest anchor；老内核没有该完整性元数据，整行剥除后仍严格比较全部业务投影。
#   · 早期开发快照曾把 `pipeline_document_profile` 等治理身份写入 YAML；当前正式实现把它们
#     移到回滚兼容 sidecar。Oracle 仍剥除这些历史字段，以验证旧 fixture 的迁移读路径。
#   · `.pipeline-document-locale.json` 固定新 Change 的人读文档语言；老内核没有文档呈现层。
#     中文默认、显式英文和回滚兼容由模板、init 和 bundle 测试独立验证，不修改严格 YAML 投影。
#   · build_sha 的 Build revision token（packages/kernel/src/workflow/build-revision.ts）：当前运行时
#     写 `build:v1:git:<revision>:<repository>:<worktree>`，老内核写裸 Git SHA。仅当 token 的 revision
#     段能由老侧 SHA 按同一 domain 重新算出（同一 commit）时，YAML 面与 `get build_sha` 的 stdout 面
#     记 KNOWN；repository/worktree 段绑定各自 checkout，双跑两侧天然不同。验证不过一律逐字比。
#
# 用法:
#   bash tools/oracle/run.sh [fixture ...]      # 缺省跑基础兼容 fixtures；npm run oracle 跑全量
#
# 环境变量:
#   ORACLE_OLD_SCRIPT     oracle 脚本路径（默认老仓 pipeline-state.sh）
#   ORACLE_NEW_CLI        新 CLI 命令串（默认 node <repo>/packages/cli/dist/main.js；
#                         设置后跳过构建产物存在性检查——测试注入 stub 用）
#   ORACLE_DOCUMENT_BOOTSTRAP
#                         0/1。真实 CLI 双跑时默认 1：为 new 侧建立真实的文档 ledger
#                         证据，使历史 oracle 的状态 guard 仍可与新 OpenSpec 契约逐面比较。
#                         注入 ORACLE_NEW_CLI（harness stub）时默认 0；需要时可显式置 1。
#   ORACLE_REVIEW_BOOTSTRAP
#                         0/1。真实 CLI 双跑时默认 1：在老 oracle 成功离开 review phase 后，
#                         new 侧以 request → acknowledge 写入同 event 的人工 receipt，再比较原
#                         transition。注入 stub 时默认 0，避免把产品协议强加给 harness stub。
#   ORACLE_REPO_ROOT      仓库根覆盖（默认本脚本上两级）
#   ORACLE_WORKDIR        工作目录（默认 mktemp；保留现场，报告在 <workdir>/report.txt）
#   ORACLE_FORCE_DEGRADED 置 1 强制降级（契约测试）模式
#
# 退出码:
#   0 = 双跑全一致，或降级模式（降级恒 0，报告标明 DEGRADED——LOOP.md kill criteria 第 3 条语义）
#   1 = 双跑存在不一致
#   2 = 新 CLI 构建产物缺失（先 npm run build）
set -uo pipefail

ORACLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${ORACLE_REPO_ROOT:-$(cd "$ORACLE_DIR/../.." && pwd)}"
OLD_SCRIPT="${ORACLE_OLD_SCRIPT:-/Users/a1234/Documents/code-manager/projects/workflow-plugin/skills/pipeline/scripts/pipeline-state.sh}"
NEW_CLI_DEFAULT="$REPO_ROOT/packages/cli/dist/main.js"

if [ -n "${ORACLE_NEW_CLI:-}" ]; then
  # 测试注入口：整串按空白切词（路径含空格不支持）
  read -r -a NEW_CMD <<<"$ORACLE_NEW_CLI"
else
  if [ ! -f "$NEW_CLI_DEFAULT" ]; then
    echo "先 npm run build（缺新 CLI 构建产物: ${NEW_CLI_DEFAULT}）" >&2
    exit 2
  fi
  NEW_CMD=(node "$NEW_CLI_DEFAULT")
fi

# 新 default workflow 的文档契约是有意新增的产品行为；T6 oracle 的职责仍是比较原有状态机
# guard/effect。因此真实 bundle 双跑会在 new 侧用真实 `document` 命令、真实 PostToolUse tracker
# 构造可审计的 fixture 证据，而不是把产品契约关掉。stub 只是比较 harness 本身，未实现 document
# 子命令，故显式注入 ORACLE_NEW_CLI 时默认关闭；需要测试该路径的调用方可置 1。
if [ -z "${ORACLE_DOCUMENT_BOOTSTRAP:-}" ]; then
  if [ -n "${ORACLE_NEW_CLI:-}" ]; then
    DOCUMENT_CONTRACT_BOOTSTRAP=0
  else
    DOCUMENT_CONTRACT_BOOTSTRAP=1
  fi
else
  DOCUMENT_CONTRACT_BOOTSTRAP="$ORACLE_DOCUMENT_BOOTSTRAP"
fi
case "$DOCUMENT_CONTRACT_BOOTSTRAP" in
  0|1) ;;
  *) echo "ORACLE_DOCUMENT_BOOTSTRAP 仅允许 0 或 1（当前 '$DOCUMENT_CONTRACT_BOOTSTRAP'）" >&2; exit 2 ;;
esac

if [ -z "${ORACLE_REVIEW_BOOTSTRAP:-}" ]; then
  if [ -n "${ORACLE_NEW_CLI:-}" ]; then
    REVIEW_RECEIPT_BOOTSTRAP=0
  else
    REVIEW_RECEIPT_BOOTSTRAP=1
  fi
else
  REVIEW_RECEIPT_BOOTSTRAP="$ORACLE_REVIEW_BOOTSTRAP"
fi
case "$REVIEW_RECEIPT_BOOTSTRAP" in
  0|1) ;;
  *) echo "ORACLE_REVIEW_BOOTSTRAP 仅允许 0 或 1（当前 '$REVIEW_RECEIPT_BOOTSTRAP'）" >&2; exit 2 ;;
esac

WORKDIR="${ORACLE_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/pipeline-oracle.XXXXXX")}"
mkdir -p "$WORKDIR"
MACHINE_HOME="$WORKDIR/.tenon-dashboard-home"
REPORT="$WORKDIR/report.txt"
ROWS="$WORKDIR/rows.tsv"
: > "$REPORT"
: > "$ROWS"

say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
# 行 = FIXTURE STEP COMMAND STDOUT EXIT YAML STDERR（四面：新增 STDERR，仅 transition 拒绝路径逐字比）
row() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" >> "$ROWS"; }

# 剥 ANSI 颜色转义（老内核 red()/green() 用 \033[..m 包裹错误行；新 CLI 明文）——stderr 逐字比前先归一。
strip_ansi() { awk '{ gsub(/\033\[[0-9;]*m/, ""); print }' "$1"; }

# types.ts::FIELD_ORDER 的当前 46 字段、N-1 wire 保留非空 review receipt 的 45 字段、
# 空 review receipt 但含逻辑 pre-Verify 字段的 41 字段、当前空 receipt N-1 wire 的 40 字段，
# 以及 G1 canonical 首次写入前仍可读的旧版 37 字段。
# 降级模式只接受其中一套精确完整顺序；不接受任意缺字段、混排或部分 review receipt。
FIELD_ORDER_STR="track preset created_by assignee phase phase_status design_doc plan verification_report build_mode isolation build_sha agent_review_result codex_review_result verify_result branch_status direct_override prd_path pr_url automation automation_queued_at automation_sandbox automation_worktree automation_attempts automation_last_error automation_preserved_path branch base_branch scope related_files spec_scope depends_on created_at updated_at verified_at archived_at archived workflow automation_current_phase automation_cause review_gate_phase review_gate_status review_gate_event review_requested_at review_acknowledged_at pre_verify_review_result"
WIRE_WITH_RECEIPT_FIELD_ORDER_STR="track preset created_by assignee phase phase_status design_doc plan verification_report build_mode isolation build_sha agent_review_result codex_review_result verify_result branch_status direct_override prd_path pr_url automation automation_queued_at automation_sandbox automation_worktree automation_attempts automation_last_error automation_preserved_path branch base_branch scope related_files spec_scope depends_on created_at updated_at verified_at archived_at archived workflow automation_current_phase automation_cause review_gate_phase review_gate_status review_gate_event review_requested_at review_acknowledged_at"
PROJECTED_FIELD_ORDER_STR="track preset created_by assignee phase phase_status design_doc plan verification_report build_mode isolation build_sha agent_review_result codex_review_result verify_result branch_status direct_override prd_path pr_url automation automation_queued_at automation_sandbox automation_worktree automation_attempts automation_last_error automation_preserved_path branch base_branch scope related_files spec_scope depends_on created_at updated_at verified_at archived_at archived workflow automation_current_phase automation_cause pre_verify_review_result"
PRE_VERIFY_FIELD_ORDER_STR="track preset created_by assignee phase phase_status design_doc plan verification_report build_mode isolation build_sha agent_review_result codex_review_result verify_result branch_status direct_override prd_path pr_url automation automation_queued_at automation_sandbox automation_worktree automation_attempts automation_last_error automation_preserved_path branch base_branch scope related_files spec_scope depends_on created_at updated_at verified_at archived_at archived workflow automation_current_phase automation_cause"
LEGACY_FIELD_ORDER_STR="track preset created_by assignee phase phase_status design_doc plan verification_report build_mode isolation build_sha agent_review_result codex_review_result verify_result branch_status direct_override prd_path pr_url automation automation_queued_at automation_sandbox automation_worktree automation_attempts automation_last_error automation_preserved_path branch base_branch scope related_files spec_scope depends_on created_at updated_at verified_at archived_at archived"

FAILS=0
DEGRADED_REASON=""
MODE=dual

count_fail() { [ "$1" = FAIL ] && FAILS=$((FAILS + 1)); return 0; }

is_ts_field() { case "${1:-}" in *_at) return 0 ;; *) return 1 ;; esac; }

# 三面白名单归一：剥历史区块 + *_at 值归一 + 新 CLI 专属字段整行剥除
# （下列字段是新 CLI 专属——老脚本 oracle 只读、永远不会产出，逐字 diff 会永久不一致，同 history
#  区块一样整行不计入比较，而非只归一值）：
#   · workflow                     —— 工作流定制引擎新增（BACKLOG）。
#   · pipeline_run_id/_transition_* —— G1 WorkflowRun 身份三行块（run_id 还是非确定 UUID，
#                                     即使想比也比不了）。
#   · pipeline_state_revision/_id/_digest —— G1 canonical current 的 YAML adapter 指针；
#                                            业务字段仍须与 oracle 逐字一致。
#   · pipeline_document_* / pipeline_workflow_plan_fingerprint
#       —— 仅兼容早期开发快照；新 Change 的不可变绑定在独立 sidecar。
#   · pipeline_document_locale —— 仅为兼容曾短暂产出该字段的开发快照；正式实现使用独立 sidecar。
#   · automation_current_phase/_cause —— 分叉后 automation 子系统新增字段。
#   · review_gate_* / pre_verify_review_result —— 新 Tenon 精确出口收据与 Build 收敛门；
#                                                  老脚本 oracle 不产出。
#   · tenon-internal-pre-verify-review-v1 comment —— companion 内容的 N-1 rollback anchor；
#                                                    业务值由真实 N-1 双向 bundle 门验证。
#   · tenon-internal-transition-head-v1 comment —— canonical head digest anchor；完整性与 N-1
#                                                   兼容由 kernel 对抗测试和 bundle 门验证。
#   · 已声明的状态演进（目前仅 pm-history 的 `spec-complete` 自动 AFK 入队）：harness 先逐字
#     验证 old=`off`、new=`queued` 和 new 的入队时间戳，再仅从该单步的 YAML 比较中剥除这两个字段。
#     这不是泛化豁免；没有 fixture sidecar 的任何 automation 差异仍会失败。
normalize_yaml() {
  local omit_declared_automation="${2:-0}" build_sha_value="${3:-}"
  local strip_transition_head=0 anchor_validation_rc=0
  node "$ORACLE_DIR/validate-transition-head-anchor.mjs" "$1" >/dev/null 2>&1 \
    || anchor_validation_rc=$?
  case "$anchor_validation_rc" in
    0) strip_transition_head=1 ;;
    2|3) ;;
    *) return 2 ;;
  esac
  awk -v omit_declared_automation="$omit_declared_automation" \
      -v build_sha_value="$build_sha_value" \
      -v strip_transition_head="$strip_transition_head" '
    /^(tools_history|prompts_history|transitions_history):/ { inhist = 1; next }
    {
      if (inhist) {
        if ($0 ~ /^[[:space:]]+- /) next
        inhist = 0
      }
      if ($0 ~ /^# tenon-internal-pre-verify-review-v1: [A-Za-z0-9_-]+$/) next
      if (strip_transition_head == "1" && $0 ~ /^# tenon-internal-transition-head-v1: [A-Za-z0-9_-]+$/) next
      if ($0 ~ /^(workflow|pipeline_document_profile|pipeline_document_locale|pipeline_document_governance_fingerprint|pipeline_workflow_plan_fingerprint|pipeline_run_id|pipeline_transition_sequence|pipeline_transition_head|pipeline_state_revision|pipeline_state_revision_id|pipeline_state_digest|automation_current_phase|automation_cause|review_gate_phase|review_gate_status|review_gate_event|review_requested_at|review_acknowledged_at|review_acknowledged_via|pre_verify_review_result):/) next
      if (omit_declared_automation == "1" && $0 ~ /^(automation|automation_queued_at):/) next
      if (build_sha_value != "" && $0 ~ /^build_sha:/) { print "build_sha: " build_sha_value; next }
      if ($0 ~ /^[a-z_]+_at:/) { sub(/:.*$/, ": <WHITELISTED>"); print; next }
      if ($0 ~ /^(created_by|assignee):/) { sub(/:.*$/, ": <WHITELISTED>"); print; next }
      print
    }
  ' "$1"
}

yaml_scalar() {
  local file="$1" field="$2"
  awk -v field="$field" '
    index($0, field ":") == 1 {
      value = substr($0, length(field) + 2)
      sub(/^[[:space:]]+/, "", value)
      if (value ~ /^".*"$/) value = substr(value, 2, length(value) - 2)
      print value
      exit
    }
  ' "$file"
}

# Build → Verify revision token（packages/kernel/src/workflow/build-revision.ts）。当前运行时写
# `build:v1:git:<revisionHash>:<repositoryHash>:<worktreeHash>`，老内核写裸 Git SHA。只有 revisionHash
# 恰好等于按内核同一 domain 对老侧 SHA 重新计算的结果时，才判定两侧冻结的是同一 commit；
# repository/worktree 两段绑定各自物理 checkout，不参与比较。返回 0=已验证等价，1=不等价或格式不符。
build_revision_token_matches_sha() {
  node -e '
    const [sha, token] = process.argv.slice(1)
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) process.exit(1)
    const match = /^build:v1:git:([a-f0-9]{64}):[a-f0-9]{64}:[a-f0-9]{64}$/.exec(token)
    if (match === null) process.exit(1)
    const expected = require("node:crypto").createHash("sha256")
      .update(`tenon/build-revision/revision/git/v1\0${sha.toLowerCase()}`).digest("hex")
    process.exit(match[1] === expected ? 0 : 1)
  ' "$1" "$2"
}

# 仅允许 fixture 明确声明的一条产品演进跨越老 oracle 的状态投影。该 helper 在归一前
# 先验证新行为本身，确保“KNOWN”绝不会把错误的自动化状态或时间戳悄悄吞掉。
# sidecar 行格式：<生效起始 step>\tpm-spec-complete-auto-enqueue\t<change>\t<old automation>\t<new automation>
# 返回：0=已验证的声明差异，1=本步无声明，2=声明存在但产品行为不符。声明从起始 step 起持续
# 生效，且每个后续步骤都会重新验证该状态仍然成立，防止一次通过后状态被悄悄改坏。
declared_state_extension_for_step() {
  local base="$1" idx="$2" change="$3" old_yaml="$4" new_yaml="$5"
  local sidecar="$base/new/.oracle-state-extensions"
  [ -f "$sidecar" ] || return 1

  local step kind declared_change expected_old expected_new
  while IFS=$'\t' read -r step kind declared_change expected_old expected_new; do
    case "$step" in ''|'#'*) continue ;; esac
    case "$step" in *[!0-9]*)
      printf 'state extension step 非法：%s' "$step"
      return 2
      ;;
    esac
    [ "$idx" -ge "$step" ] || continue
    if [ "$kind" != "pm-spec-complete-auto-enqueue" ]; then
      printf '未知 state extension kind=%s（step=%s）' "$kind" "$idx"
      return 2
    fi
    if [ "$declared_change" != "$change" ]; then
      printf 'state extension change 不匹配：声明=%s，实际=%s' "$declared_change" "$change"
      return 2
    fi

    local old_automation new_automation new_queued_at
    old_automation="$(yaml_scalar "$old_yaml" automation)"
    new_automation="$(yaml_scalar "$new_yaml" automation)"
    new_queued_at="$(yaml_scalar "$new_yaml" automation_queued_at)"
    if [ "$old_automation" = "$expected_old" ] \
      && [ "$new_automation" = "$expected_new" ] \
      && [ -n "$new_queued_at" ] \
      && [ "$new_queued_at" != "null" ]; then
      printf 'PM spec-complete 自动入队已验证：old automation=%s，new automation=%s，queued_at 已写入' \
        "$old_automation" "$new_automation"
      return 0
    fi
    printf 'PM spec-complete 自动入队断言失败：old automation=%s（期望 %s），new automation=%s（期望 %s），new queued_at=%s' \
      "${old_automation:-<missing>}" "$expected_old" "${new_automation:-<missing>}" "$expected_new" \
      "${new_queued_at:-<missing>}"
    return 2
  done < "$sidecar"

  return 1
}

# 契约 §1：当前逻辑 46、N-1 wire 45/40、逻辑空 receipt 41 或旧版 37 字段
# 按各自 FIELD_ORDER 全量在序
# （未知行/历史区不计）
keyorder_ok() {
  local got
  got=$(awk -v current="$FIELD_ORDER_STR" -v wire_receipt="$WIRE_WITH_RECEIPT_FIELD_ORDER_STR" \
    -v projected="$PROJECTED_FIELD_ORDER_STR" \
    -v preverify="$PRE_VERIFY_FIELD_ORDER_STR" -v legacy="$LEGACY_FIELD_ORDER_STR" '
    BEGIN {
      n = split(current, a, " "); for (i = 1; i <= n; i++) known[a[i]] = 1
      n = split(wire_receipt, a, " "); for (i = 1; i <= n; i++) known[a[i]] = 1
      n = split(projected, a, " "); for (i = 1; i <= n; i++) known[a[i]] = 1
      n = split(preverify, a, " "); for (i = 1; i <= n; i++) known[a[i]] = 1
      n = split(legacy, a, " "); for (i = 1; i <= n; i++) known[a[i]] = 1
    }
    match($0, /^[a-z_]+:/) {
      k = substr($0, 1, RLENGTH - 1)
      if (k in known) { printf "%s%s", sep, k; sep = " " }
    }
  ' "$1")
  [ "$got" = "$FIELD_ORDER_STR" ] \
    || [ "$got" = "$WIRE_WITH_RECEIPT_FIELD_ORDER_STR" ] \
    || [ "$got" = "$PROJECTED_FIELD_ORDER_STR" ] \
    || [ "$got" = "$PRE_VERIFY_FIELD_ORDER_STR" ] \
    || [ "$got" = "$LEGACY_FIELD_ORDER_STR" ]
}

# 老/新两侧参数映射（老: init <name> <track> <preset> / check <name> <phase>；
#  新: init <name> --track --preset / check <name>——CONTRACT §3；操作人走声明身份，无 --user）
build_args() {
  local cmd="$1"; shift
  case "$cmd" in
    init)
      OLD_ARGS=(init "$1" "$2" "$3" --user oracle)
      NEW_ARGS=(init "$1" --track "$2" --preset "$3")
      ;;
    check)
      OLD_ARGS=(check "$1" "$2")
      NEW_ARGS=(check "$1")
      ;;
    *)
      OLD_ARGS=("$cmd" "$@")
      NEW_ARGS=("$cmd" "$@")
      ;;
  esac
}

# ---------- oracle 可用性探针 ----------
probe_oracle() {
  local pd="$WORKDIR/.probe" out phase
  rm -rf "$pd"
  mkdir -p "$pd/openspec/changes"
  if ! out=$(cd "$pd" && TENON_ASSUME_YES=1 bash "$OLD_SCRIPT" init oracle-probe backend full --user oracle 2>&1); then
    DEGRADED_REASON="老脚本 init 探针失败: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    return 1
  fi
  phase=$(cd "$pd" && TENON_ASSUME_YES=1 bash "$OLD_SCRIPT" get oracle-probe phase 2>/dev/null)
  if [ "$phase" != "open" ]; then
    DEGRADED_REASON="老脚本 get 探针异常（phase='$phase'，期望 open）"
    return 1
  fi
  return 0
}

if [ "${ORACLE_FORCE_DEGRADED:-0}" = "1" ]; then
  MODE=degraded
  DEGRADED_REASON="ORACLE_FORCE_DEGRADED=1（人工强制降级）"
elif [ ! -f "$OLD_SCRIPT" ]; then
  MODE=degraded
  DEGRADED_REASON="老脚本不存在: $OLD_SCRIPT"
elif ! probe_oracle; then
  MODE=degraded
fi

say "golden-oracle 双跑 harness (T6)"
say "  oracle : $OLD_SCRIPT"
say "  new CLI: ${NEW_CMD[*]}"
say "  workdir: $WORKDIR"
if [ "$MODE" = degraded ]; then
  say ""
  say "DEGRADED: 契约测试模式 — 老脚本(oracle)不可独立运行，本次不做双跑。"
  say "  原因: $DEGRADED_REASON"
  say "  仅校验新 CLI 输出是否符合 docs/CONTRACT.md §3 契约表 + §1 字段序；"
  say "  本次恒 exit 0（LOOP.md kill criteria 第 3 条语义），报告已标明降级。"
else
  say "  模式  : DUAL（双跑逐字对比；oracle 探针通过）"
fi
if [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ]; then
  say "  文档账本: new 侧使用真实 CLI + hook 建立 fixture 证据"
else
  say "  文档账本: bootstrap 已关闭（stub/显式配置）"
fi
if [ "$REVIEW_RECEIPT_BOOTSTRAP" = 1 ]; then
  say "  review receipt: new 侧对 legacy 成功出口写入同 event 的 request → acknowledge"
else
  say "  review receipt: bootstrap 已关闭（stub/显式配置）"
fi
say ""

# ---------- new 侧 OpenSpec 文档契约 fixture ----------
#
# Oracle fixtures 起源于文档账本出现之前，重点是历史状态机 guard/effect；现在真实 default workflow
# 会在每次 transition 前验证 document ledger。这里不绕过该验证：它在 new 侧逐个执行产品的
# `tenon document init|record|read` 命令，并通过同包 PostToolUse tracker 写入所需的 Skill audit。
#
# 对 pm-history 这类“升级前已在 spec”的 fixture，前序已有文档用 `--backfill` 显式登记。该选项也在
# 产品 CLI 中受到约束：只能补当前 phase 之前的文档，仍需要真实 skill evidence + path/digest 校验，
# 不能登记未来 phase。这样 oracle 同时覆盖升级兼容入口，而不是把旧 Change 悄悄豁免出治理。

# 新 CLI 的操作人来自声明身份（env → config → git），没有 per-command 的 --user 冒名开关；
# oracle 注入固定测试身份，机器上有没有 git 身份都不影响双跑。
ORACLE_TENON_USER="oracle@tenon.test"
ORACLE_TENON_USER_NAME="oracle"

run_new_cli() {
  local dir="$1"; shift
  (cd "$dir" && TENON_RUNTIME_HOME="$MACHINE_HOME" \
    TENON_USER="$ORACLE_TENON_USER" TENON_USER_NAME="$ORACLE_TENON_USER_NAME" \
    "${NEW_CMD[@]}" "$@")
}

install_post_init_fixture() {
  local dir="$1" change="$2" source target
  source="$dir/.oracle-post-init/$change"
  target="$dir/openspec/changes/$change"
  [ -d "$source" ] || return 0
  [ -d "$target" ] || return 1
  cp -R "$source/." "$target/"
}

phase_rank() {
  case "$1" in
    open) echo 0 ;;
    explore) echo 1 ;;
    spec) echo 2 ;;
    build) echo 3 ;;
    verify) echo 4 ;;
    ship) echo 5 ;;
    archive) echo 6 ;;
    *) echo -1 ;;
  esac
}

ensure_oracle_document() {
  local dir="$1" rel="$2" kind="$3" target
  target="$dir/$rel"
  if [ -f "$target" ]; then return 0; fi
  mkdir -p "$(dirname "$target")" || return 1
  printf '# Oracle document-contract fixture\n\nkind: %s\n' "$kind" > "$target"
}

track_oracle_skill() {
  local dir="$1" skill="$2"
  # Exercise the same host-neutral native PostToolUse boundary as Claude. Session/tool identity is
  # required to seal the invocation against the canonical current StepVisit; a bare history row is
  # deliberately insufficient and would make this fixture fail closed at `document record`.
  # The hook resolves the Change through the *caller's* `.tenon/users/<slug>/local/active-change`,
  # so it needs the same declared identity as run_new_cli: without it the slug differs, the hook
  # finds no active Change and silently records nothing.
  printf '{"cwd":"%s","tool_name":"Skill","skill":"%s","session_id":"oracle-document-bootstrap","tool_use_id":"oracle-%s"}' \
    "$dir" "$skill" "$skill" \
    | CLAUDE_PLUGIN_ROOT="$REPO_ROOT" TENON_RUNTIME_HOME="$MACHINE_HOME" \
      TENON_USER="$ORACLE_TENON_USER" TENON_USER_NAME="$ORACLE_TENON_USER_NAME" \
      bash "$REPO_ROOT/hooks/skill-tracker.sh" >/dev/null
}

# Default transitions now enforce every mandatory Skill on the current phase visit. Oracle fixtures
# compare the legacy state machine rather than agent execution, so derive the exact slots the gate
# checks and record them through the real hook:
#   · the frozen workflow step's declared skills (`requiredSkillIds`), read from the public
#     `tenon workflow plan --json` projection;
#   · the manifest Track overlay (`M` slots of the production router projection).
# This is evidence construction, not a transition bypass: stale previous-visit rows still cannot
# satisfy a later visit because the product gate reads history after the latest transition record.
bootstrap_new_phase_skills() {
  local dir="$1" change="$2" phase track phase_hex track_hex cache plan_json plan_skills skill_hex skill
  local tracked=$'\n'
  phase="$(run_new_cli "$dir" get "$change" phase)" || return 1
  track="$(run_new_cli "$dir" get "$change" track)" || return 1
  phase="$(printf '%s' "$phase" | tr -d '[:space:]')"
  track="$(printf '%s' "$track" | tr -d '[:space:]')"
  plan_json="$dir/.oracle-workflow-plan.json"
  plan_skills="$dir/.oracle-plan-step-skills"
  run_new_cli "$dir" workflow plan "$change" --json > "$plan_json" || return 1
  node -e '
    const [file] = process.argv.slice(1)
    const projection = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
    const step = projection.plan?.capabilities?.skills?.steps?.find(
      (candidate) => candidate.stepId === projection.current_step)
    if (step === undefined) {
      console.error(`workflow plan 缺少当前 step 的 skill 声明: ${projection.current_step}`)
      process.exit(1)
    }
    for (const id of step.requiredSkillIds) console.log(id)
  ' "$plan_json" > "$plan_skills" || return 1
  while IFS= read -r skill; do
    [ -n "$skill" ] || continue
    case "$tracked" in *$'\n'"$skill"$'\n'*) continue ;; esac
    track_oracle_skill "$dir" "$skill" || return 1
    tracked="$tracked$skill"$'\n'
  done < "$plan_skills"
  phase_hex="$(printf '%s' "$phase" | xxd -p -c 999)"
  track_hex="$(printf '%s' "$track" | xxd -p -c 999)"
  cache="$dir/.oracle-router-data"
  run_new_cli "$dir" _gen-router-sh "$REPO_ROOT/templates/manifest.yaml" "$dir" > "$cache" || return 1
  while IFS= read -r skill_hex; do
    [ -n "$skill_hex" ] || continue
    skill="$(printf '%s' "$skill_hex" | xxd -r -p)" || return 1
    case "$tracked" in *$'\n'"$skill"$'\n'*) continue ;; esac
    track_oracle_skill "$dir" "$skill" || return 1
    tracked="$tracked$skill"$'\n'
  done < <(
    awk -F '|' -v phase="$phase_hex" -v track="$track_hex" \
      '$1 == "S" && $2 == phase && $3 == track && $4 == "M" { print $6 }' "$cache"
  )
}

# Bootstrap runs before every oracle transition/check against the same evolving fixture.  A
# historical document needs `--backfill` only once; attempting it again is correctly rejected by
# the product ledger because a backfill must never overwrite an established record.  This harness
# only creates immutable fixture documents, so a kind it has already recorded is exactly the
# idempotent case.
#
# Idempotency is keyed on this harness's own successful `document record`, never on the mere
# presence of a ledger row: only an explicit `document record` binds the document application
# (artifact-binding-intent/artifact-bound) that `evaluateDocumentEvidence` demands.  A row this
# harness did not bind would fail `check` and `open-complete` with “producer invocation/artifact
# 尚未原子完成” before the legacy guard the fixture compares was reached.
oracle_document_receipts() {
  printf '%s/.oracle-document-records/%s' "$1" "$2"
}

oracle_document_recorded() {
  local receipts
  receipts="$(oracle_document_receipts "$1" "$2")"
  [ -f "$receipts" ] && grep -Fxq "$3" "$receipts"
}

record_oracle_document() {
  local dir="$1" change="$2" current="$3" owner="$4" kind="$5" rel="$6" producer="$7"
  local current_rank owner_rank
  current_rank="$(phase_rank "$current")"
  owner_rank="$(phase_rank "$owner")"
  [ "$current_rank" -ge 0 ] && [ "$owner_rank" -ge 0 ] || return 0
  [ "$owner_rank" -le "$current_rank" ] || return 0
  oracle_document_recorded "$dir" "$change" "$kind" && return 0
  ensure_oracle_document "$dir" "$rel" "$kind" || return 1
  track_oracle_skill "$dir" "$producer" || return 1
  if [ "$owner_rank" -lt "$current_rank" ]; then
    run_new_cli "$dir" document record "$change" "$kind" "$rel" --producer "$producer" --backfill || return 1
  else
    run_new_cli "$dir" document record "$change" "$kind" "$rel" --producer "$producer" || return 1
  fi
  mkdir -p "$dir/.oracle-document-records" || return 1
  printf '%s\n' "$kind" >> "$(oracle_document_receipts "$dir" "$change")"
}

bootstrap_new_document_contract() {
  local dir="$1" change="$2" phase change_dir
  phase="$(run_new_cli "$dir" get "$change" phase)" || return 1
  phase="$(printf '%s' "$phase" | tr -d '[:space:]')"
  [ "$(phase_rank "$phase")" -ge 0 ] || return 0
  change_dir="openspec/changes/$change"

  run_new_cli "$dir" document init "$change" || return 1
  # Hooks no longer infer the newest Change.  Mirror the normal pipeline entry sequence before
  # producing fixture Skill evidence, so dual-run document setup cannot accidentally bind a
  # concurrently present old fixture.
  run_new_cli "$dir" session activate "$change" || return 1
  # Document recording is owner-gated, and legacy `assignee` values (bare name / unknown / null)
  # project as unowned——a real behaviour change, not a harness artifact.  A real user takes the task
  # over before producing documents; do the same once per Change so history gains one row, not one
  # per bootstrap call.
  if [ ! -f "$dir/.oracle-owner-taken-$change" ]; then
    run_new_cli "$dir" owner take "$change" || return 1
    : > "$dir/.oracle-owner-taken-$change" || return 1
  fi

  record_oracle_document "$dir" "$change" "$phase" open proposal "$change_dir/proposal.md" openspec-propose || return 1
  record_oracle_document "$dir" "$change" "$phase" open openspec-design "$change_dir/design.md" openspec-propose || return 1
  record_oracle_document "$dir" "$change" "$phase" open tasks "$change_dir/tasks.md" openspec-propose || return 1
  record_oracle_document "$dir" "$change" "$phase" explore superpower-design "docs/oracle-document-contract/$change/superpower-design.md" brainstorming || return 1
  record_oracle_document "$dir" "$change" "$phase" explore adr "docs/oracle-document-contract/$change/adr.md" brainstorming || return 1
  record_oracle_document "$dir" "$change" "$phase" spec delta-spec "$change_dir/specs/oracle/spec.md" openspec-propose || return 1
  record_oracle_document "$dir" "$change" "$phase" spec superpower-plan "docs/oracle-document-contract/$change/superpower-plan.md" writing-plans || return 1
  record_oracle_document "$dir" "$change" "$phase" spec plan "docs/oracle-document-contract/$change/plan.md" writing-plans || return 1
  record_oracle_document "$dir" "$change" "$phase" verify verification-report "docs/oracle-document-contract/$change/verification-report.md" verification-before-completion || return 1
  record_oracle_document "$dir" "$change" "$phase" ship applied-spec "$change_dir/specs/oracle/applied-spec.md" openspec-apply-change || return 1

  # open has no read inputs. Every later phase consumes the complete hash-bound input set required
  # by its own contract row; retries simply replace the same-phase receipt and remain idempotent.
  if [ "$phase" != open ]; then
    run_new_cli "$dir" document read "$change" all || return 1
  fi
}

# Legacy oracle predates exit-time human review.  Its successful transition is still the expected
# business effect, so after the old side has proved that an exit succeeds, reproduce the real new
# protocol only on the new side.  The helper deliberately never runs before a legacy rejection:
# a failing guard must remain a guard comparison, not become an artificial review request.
bootstrap_new_review_receipt() {
  local dir="$1" change="$2" event="$3" phase
  phase="$(run_new_cli "$dir" get "$change" phase)" || return 1
  phase="$(printf '%s' "$phase" | tr -d '[:space:]')"
  case "$phase" in
    explore|spec|verify) ;;
    *) return 0 ;;
  esac
  run_new_cli "$dir" review request "$change" --event "$event" || return 1
  run_new_cli "$dir" review acknowledge "$change"
}

# Legacy oracle predates both the current-phase task exit and the global Build convergence gate.
# Once the legacy side has proved that a build-complete exit succeeds, finish the fixture tasks and
# bind their changed digest through the real Build Skill/document commands, then model the completed
# full-diff review. As with review receipts, this never runs for a legacy rejection, so it cannot
# mask the guard failure that a fixture intends to compare.
bootstrap_new_pre_verify_review() {
  local dir="$1" change="$2" event="$3" tasks tmp
  [ "$event" = build-complete ] || return 0
  tasks="$dir/openspec/changes/$change/tasks.md"
  if [ -f "$tasks" ] && grep -Eq '^- \[ \]' "$tasks"; then
    tmp="$tasks.oracle-complete.tmp"
    awk '{ sub(/^- \[ \]/, "- [x]"); print }' "$tasks" > "$tmp" || return 1
    mv "$tmp" "$tasks" || return 1
    track_oracle_skill "$dir" tenon || return 1
    run_new_cli "$dir" document record "$change" tasks "openspec/changes/$change/tasks.md" \
      --producer tenon || return 1
    run_new_cli "$dir" document read "$change" all || return 1
  fi
  run_new_cli "$dir" set "$change" pre_verify_review_result pass
}

# 老 oracle 早于「项目设计体系」：default 的前端轨道首步声明 design-md `role: require`，没有就绪的
# 根 DESIGN.md 就建不了前端任务。真实用户先跑一次设计体系任务（hue 产出 DESIGN.md + design/），
# 之后这个项目的每个前端任务都直接开工。harness 跑不了 hue，就按同样的产物把项目备好——
# 判定仍由产品的 checkDesignSystem 做，前置条件一行都没改。
# 契约（章节表、预览清单、frontmatter）只有一份定义：直接调 kernel 的夹具助手，不在这里抄一遍。
# 只对声明了前端工作的 fixture 生效（`.oracle-design-system` 标记），因此别的 fixture 的工作区指纹不受影响。
DESIGN_SYSTEM_FIXTURE="$REPO_ROOT/packages/kernel/dist/design-system/test-support.js"

bootstrap_new_design_system() {
  local dir="$1"
  [ -f "$dir/.oracle-design-system" ] || return 0
  [ -f "$dir/DESIGN.md" ] && return 0
  if [ ! -f "$DESIGN_SYSTEM_FIXTURE" ]; then
    printf '缺少设计体系夹具助手: %s（先 npm run build）\n' "$DESIGN_SYSTEM_FIXTURE" >&2
    return 1
  fi
  ORACLE_DESIGN_ROOT="$dir" ORACLE_DESIGN_FIXTURE="$DESIGN_SYSTEM_FIXTURE" node --input-type=module -e '
    const { writeReadyDesignSystem } = await import(`file://${process.env.ORACLE_DESIGN_FIXTURE}`)
    writeReadyDesignSystem(process.env.ORACLE_DESIGN_ROOT)
  ' || return 1
}

# Legacy oracle predates per-step test evidence. default 的 frontend/backend 轨在 build/verify 声明了
# 必需测试，而声明过的测试只认 `tenon test run` 落下的记录——自跑同一条命令不算。所以在老侧已经证明
# 该出口成功之后，于新侧照真实用户的做法补齐：项目声明自己的 npm 脚本，读一遍状态，逐项真跑。
# 这不是给 oracle 开后门：跑的是工作流声明的那条命令，落的是真记录，门禁本身分毫未动。
oracle_fixture_package_json() { # $1=项目目录 —— 真实项目自带的脚本声明；夹具项目声明等价的空脚本
  local dir="$1"
  [ -f "$dir/package.json" ] && return 0
  cat > "$dir/package.json" <<'PKG'
{
  "name": "tenon-oracle-fixture",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "test": "exit 0",
    "typecheck": "exit 0",
    "test:integration": "exit 0",
    "bench": "exit 0"
  }
}
PKG
}

bootstrap_new_test_evidence() {
  local dir="$1" change="$2" phase ids id
  phase="$(run_new_cli "$dir" get "$change" phase)" || return 1
  phase="$(printf '%s' "$phase" | tr -d '[:space:]')"
  [ -n "$phase" ] || return 0
  # 该步没有声明测试（pm/chat/free 各步，以及 build/verify 之外的步）→ items 为空，天然无操作。
  ids="$(run_new_cli "$dir" test status "$change" --step "$phase" --json 2>/dev/null \
    | grep -o '"id": "[A-Za-z0-9_-]*"' | sed 's/.*"id": "//; s/"$//')" || true
  [ -n "$ids" ] || return 0
  oracle_fixture_package_json "$dir" || return 1
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    run_new_cli "$dir" test run "$change" "$id" || return 1
  done <<< "$ids"
}

# 老 oracle 早于「步骤 agent」：默认工作流的 frontend/backend verify 步骤现在声明必需评审者。
# 与其它 bootstrap 同一条口径——只在老侧已证明该出口成功之后补，绝不在老侧拒绝时跑。报告内容
# 由 harness 写成「无发现」，评审结论仍由 Tenon 从阻断级别算。
oracle_json_field() {
  node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(Array.isArray(v)?v.join("\n"):String(v??""))}catch{}})' "$1"
}

bootstrap_new_step_agents() {
  local dir="$1" change="$2" round agents agent started run_id report role
  for round in 1 2 3 4; do
    agents="$(run_new_cli "$dir" agent next "$change" --json 2>/dev/null | oracle_json_field wave)" || return 0
    [ -n "$agents" ] || return 0
    while IFS= read -r agent; do
      [ -n "$agent" ] || continue
      started="$(run_new_cli "$dir" agent prompt "$change" "$agent" --json)" || return 1
      run_id="$(printf '%s' "$started" | oracle_json_field run_id)"
      report="$(printf '%s' "$started" | oracle_json_field report_path)"
      role="$(printf '%s' "$started" | oracle_json_field role)"
      [ -n "$run_id" ] && [ -n "$report" ] || return 1
      mkdir -p "$dir/$(dirname "$report")" || return 1
      {
        printf '# %s\n\n' "$agent"
        printf '```tenon-result\n'
        if [ "$role" = executor ]; then
          printf '{"result":"done","findings":[]}\n'
        else
          printf '{"findings":[]}\n'
        fi
        printf '```\n'
      } > "$dir/$report" || return 1
      run_new_cli "$dir" agent record "$change" "$run_id" || return 1
    done <<< "$agents"
  done
}

# ---------- 双跑单步 ----------
stderr_divergence_reason() {
  local base="$1" idx="$2" file
  file="$base/new/.oracle-stderr-divergences"
  [ -f "$file" ] || return 1
  awk -F '\t' -v wanted="$idx" '
    $1 == wanted {
      print substr($0, length(wanted) + 2)
      exit
    }
  ' "$file"
}

# 与 stderr 同一条口径，但用于**双侧都拒绝、但拒绝理由不同**的一步：老 oracle 要求两个已删除的
# 手填评审字段，新 CLI 要求步骤声明的评审者跑过。两侧都不放行，状态两侧仍逐字可比；只把 exit 码
# 列为已知差异。绝不用于「一侧放行一侧拒绝」——那是真回归。
exit_divergence_reason() {
  local base="$1" idx="$2" file
  file="$base/new/.oracle-exit-divergences"
  [ -f "$file" ] || return 1
  awk -F '\t' -v wanted="$idx" '
    $1 == wanted {
      print substr($0, length(wanted) + 2)
      exit
    }
  ' "$file"
}

run_step_dual() {
  local fx="$1" idx="$2" cmd="$3" step_dir="$4" base="$5"
  shift 5
  local args=("$@")
  local change="${args[0]}"
  local old_rc new_rc bootstrap_rc review_bootstrap_rc convergence_bootstrap_rc test_bootstrap_rc design_bootstrap_rc agent_bootstrap_rc
  local f_out f_exit f_yaml label
  local build_sha_override=""

  bootstrap_rc=0
  # `check` shares transition's exact document-evidence predicate, so bootstrap it too.  Otherwise
  # a historical fixture's preview fails one step before the state guard it is intended to compare.
  if { [ "$cmd" = transition ] || [ "$cmd" = check ]; } && [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ]; then
    bootstrap_new_document_contract "$base/new" "$change" \
      > "$step_dir/new.document-bootstrap.out" 2> "$step_dir/new.document-bootstrap.err" || bootstrap_rc=$?
  fi
  if [ "$cmd" = transition ] && [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ] && [ "$bootstrap_rc" -eq 0 ]; then
    bootstrap_new_phase_skills "$base/new" "$change" \
      > "$step_dir/new.skill-bootstrap.out" 2> "$step_dir/new.skill-bootstrap.err" || bootstrap_rc=$?
  fi

  (cd "$base/old" && TENON_ASSUME_YES=1 bash "$OLD_SCRIPT" "${OLD_ARGS[@]}") \
    > "$step_dir/old.out" 2> "$step_dir/old.err"
  old_rc=$?
  convergence_bootstrap_rc=0
  # The convergence bootstrap drives `document record` and the product-only
  # `pre_verify_review_result` field, so it follows the document bootstrap switch: an injected stub
  # CLI implements neither and must keep comparing only the legacy state machine.
  if [ "$bootstrap_rc" -eq 0 ] && [ "$old_rc" -eq 0 ] && [ "$cmd" = transition ] \
    && [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ]; then
    bootstrap_new_pre_verify_review "$base/new" "$change" "${args[1]:-}" \
      > "$step_dir/new.convergence-bootstrap.out" 2> "$step_dir/new.convergence-bootstrap.err" \
      || convergence_bootstrap_rc=$?
  fi
  design_bootstrap_rc=0
  # 与其它 bootstrap 同一条口径：老侧先证明这一步能成，新侧才按真实项目的样子把设计体系备好。
  # 必须排在新侧 init 之前——立项前置条件在写盘之前判定。
  if [ "$cmd" = init ] && [ "$old_rc" -eq 0 ] && [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ]; then
    bootstrap_new_design_system "$base/new" \
      > "$step_dir/new.design-bootstrap.out" 2> "$step_dir/new.design-bootstrap.err" || design_bootstrap_rc=$?
  fi
  test_bootstrap_rc=0
  # 与 review receipt 同一条口径：只在老侧已证明该出口成功之后补，绝不在老侧拒绝时跑——那会把一次
  # guard 比较变成人为的测试登记。必须排在 review request 之前：`review request` 的预检就是整份
  # check（含测试证据），真实用户同样是先跑测试再请求评审。
  if [ "$bootstrap_rc" -eq 0 ] && [ "$convergence_bootstrap_rc" -eq 0 ] && [ "$old_rc" -eq 0 ] \
    && { [ "$cmd" = transition ] || [ "$cmd" = check ]; } && [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ]; then
    bootstrap_new_test_evidence "$base/new" "$change" \
      > "$step_dir/new.test-bootstrap.out" 2> "$step_dir/new.test-bootstrap.err" || test_bootstrap_rc=$?
  fi
  agent_bootstrap_rc=0
  # 必须排在 review request 之前：`review request` 的预检就是整份 check（含 agent 结论）。
  if [ "$bootstrap_rc" -eq 0 ] && [ "$convergence_bootstrap_rc" -eq 0 ] \
    && [ "$test_bootstrap_rc" -eq 0 ] && [ "$old_rc" -eq 0 ] \
    && { [ "$cmd" = transition ] || [ "$cmd" = check ]; } && [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ]; then
    bootstrap_new_step_agents "$base/new" "$change" \
      > "$step_dir/new.agent-bootstrap.out" 2> "$step_dir/new.agent-bootstrap.err" || agent_bootstrap_rc=$?
  fi
  review_bootstrap_rc=0
  if [ "$bootstrap_rc" -eq 0 ] && [ "$convergence_bootstrap_rc" -eq 0 ] \
    && [ "$test_bootstrap_rc" -eq 0 ] && [ "$agent_bootstrap_rc" -eq 0 ] && [ "$old_rc" -eq 0 ] \
    && [ "$cmd" = transition ] && [ "$REVIEW_RECEIPT_BOOTSTRAP" = 1 ]; then
    bootstrap_new_review_receipt "$base/new" "$change" "${args[1]:-}" \
      > "$step_dir/new.review-bootstrap.out" 2> "$step_dir/new.review-bootstrap.err" || review_bootstrap_rc=$?
  fi
  if [ "$bootstrap_rc" -eq 0 ] && [ "$convergence_bootstrap_rc" -eq 0 ] \
    && [ "$review_bootstrap_rc" -eq 0 ] && [ "$test_bootstrap_rc" -eq 0 ] \
    && [ "$agent_bootstrap_rc" -eq 0 ] && [ "$design_bootstrap_rc" -eq 0 ]; then
    run_new_cli "$base/new" "${NEW_ARGS[@]}" > "$step_dir/new.out" 2> "$step_dir/new.err"
    new_rc=$?
  else
    : > "$step_dir/new.out"
    {
      if [ "$bootstrap_rc" -ne 0 ]; then
        printf 'ERROR: oracle document bootstrap 失败（exit=%s）\n' "$bootstrap_rc"
        cat "$step_dir/new.document-bootstrap.err"
      elif [ "$convergence_bootstrap_rc" -ne 0 ]; then
        printf 'ERROR: oracle Build convergence bootstrap 失败（exit=%s）\n' "$convergence_bootstrap_rc"
        cat "$step_dir/new.convergence-bootstrap.err"
      elif [ "$test_bootstrap_rc" -ne 0 ]; then
        printf 'ERROR: oracle test evidence bootstrap 失败（exit=%s）\n' "$test_bootstrap_rc"
        cat "$step_dir/new.test-bootstrap.err"
      elif [ "$agent_bootstrap_rc" -ne 0 ]; then
        printf 'ERROR: oracle step agent bootstrap 失败（exit=%s）\n' "$agent_bootstrap_rc"
        cat "$step_dir/new.agent-bootstrap.err"
      elif [ "$design_bootstrap_rc" -ne 0 ]; then
        printf 'ERROR: oracle design system bootstrap 失败（exit=%s）\n' "$design_bootstrap_rc"
        cat "$step_dir/new.design-bootstrap.err"
      else
        printf 'ERROR: oracle review receipt bootstrap 失败（exit=%s）\n' "$review_bootstrap_rc"
        cat "$step_dir/new.review-bootstrap.err"
      fi
    } > "$step_dir/new.err"
    new_rc=125
  fi
  if [ "$cmd" = init ] && [ "$old_rc" -eq 0 ] && [ "$new_rc" -eq 0 ]; then
    install_post_init_fixture "$base/old" "$change"
    install_post_init_fixture "$base/new" "$change"
  fi

  # exit 面
  f_exit=PASS
  if [ "$old_rc" != "$new_rc" ]; then
    if [ "$old_rc" != 0 ] && [ "$new_rc" != 0 ] \
      && [ -n "$(exit_divergence_reason "$base" "$idx" || true)" ]; then
      f_exit=KNOWN
    else
      f_exit=FAIL
    fi
  fi

  # stdout 面
  if [ "$cmd" = check ]; then
    f_out=SKIP # 人读 guard 报告（CONTRACT §3）
  elif [ "$cmd" = get ] && is_ts_field "${args[1]:-}"; then
    local o n
    o=$(tr -d '[:space:]' < "$step_dir/old.out")
    n=$(tr -d '[:space:]' < "$step_dir/new.out")
    if { [ -n "$o" ] && [ -n "$n" ]; } || { [ -z "$o" ] && [ -z "$n" ]; }; then
      f_out=PASS # 时间戳白名单：比存在性不比值
    else
      f_out=FAIL
    fi
  elif cmp -s "$step_dir/old.out" "$step_dir/new.out"; then
    f_out=PASS
  elif [ "$cmd" = get ] && [ "${args[1]:-}" = build_sha ] \
    && build_revision_token_matches_sha "$(tr -d '[:space:]' < "$step_dir/old.out")" \
      "$(tr -d '[:space:]' < "$step_dir/new.out")"; then
    f_out=KNOWN
  else
    f_out=FAIL
  fi

  # yaml 面
  local oy="$base/old/openspec/changes/$change/.pipeline.yaml"
  local ny="$base/new/openspec/changes/$change/.pipeline.yaml"
  if [ ! -f "$oy" ] && [ ! -f "$ny" ]; then
    f_yaml=SKIP
  elif [ -f "$oy" ] && [ -f "$ny" ]; then
    local state_extension state_extension_rc omit_declared_automation
    state_extension="$(declared_state_extension_for_step "$base" "$idx" "$change" "$oy" "$ny")"
    state_extension_rc=$?
    omit_declared_automation=0
    case "$state_extension_rc" in
      0) omit_declared_automation=1 ;;
      1) ;;
      *)
        f_yaml=FAIL
        printf '已声明状态演进验证失败：%s\n' "$state_extension" > "$step_dir/yaml.diff"
        ;;
    esac
    local old_normalize_rc=0 new_normalize_rc=0 old_build_sha new_build_sha
    old_build_sha="$(yaml_scalar "$oy" build_sha)"
    new_build_sha="$(yaml_scalar "$ny" build_sha)"
    if [ "$old_build_sha" != "$new_build_sha" ] \
      && build_revision_token_matches_sha "$old_build_sha" "$new_build_sha"; then
      build_sha_override="$old_build_sha"
    fi
    normalize_yaml "$oy" "$omit_declared_automation" > "$step_dir/old.norm" \
      || old_normalize_rc=$?
    normalize_yaml "$ny" "$omit_declared_automation" "$build_sha_override" > "$step_dir/new.norm" \
      || new_normalize_rc=$?
    if [ "$old_normalize_rc" -ne 0 ] || [ "$new_normalize_rc" -ne 0 ]; then
      f_yaml=FAIL
      printf 'YAML 归一化失败: old=%s new=%s\n' \
        "$old_normalize_rc" "$new_normalize_rc" > "$step_dir/yaml.diff"
    elif [ "$state_extension_rc" -ne 2 ]; then
      if diff -u "$step_dir/old.norm" "$step_dir/new.norm" > "$step_dir/yaml.diff" 2>&1; then
        if [ "$state_extension_rc" -eq 0 ] || [ -n "$build_sha_override" ]; then f_yaml=KNOWN; else f_yaml=PASS; fi
      else
        f_yaml=FAIL
      fi
    fi
  else
    f_yaml=FAIL
    printf '单侧缺文件: old=%s new=%s\n' "$([ -f "$oy" ] && echo 有 || echo 无)" "$([ -f "$ny" ] && echo 有 || echo 无)" > "$step_dir/yaml.diff"
  fi

  # stderr 面：仅**声明 stderr 逐字口径的 fixture**（target 有 .oracle-stderr-check sidecar）的
  # transition 拒绝路径（双侧都非零退出）逐字比——老内核 red() 走 stderr（ANSI 包裹）、新 CLI 明文，
  # 剥 ANSI 后 cmp。barrier「双行逐字错误」的等价性此前无从验证（旧 harness 不比 stderr），本面补上
  # （G2 P3）。sidecar 门控原因：并非所有拒绝路径双侧 stderr 逐字一致——如 unknown-event，老内核附带
  # 打印「已声明事件」列表、新 CLI 从简只一行 ERROR（既有的、非 P3 引入的可接受差异），全量比会误红；
  # 只在为 stderr 等价而设计的 fixture（default-effects 的 barrier）上开这一面。成功路径 stderr
  # （[TRANSITION] → vs -> 等）双侧本就不同——不比（SKIP）。
  f_err=SKIP
  if [ -f "$base/new/.oracle-stderr-check" ] && [ "$cmd" = transition ] && [ "$old_rc" != 0 ] && [ "$new_rc" != 0 ]; then
    local divergence_reason
    divergence_reason="$(stderr_divergence_reason "$base" "$idx" || true)"
    if [ -n "$divergence_reason" ]; then
      # An explicit fixture allow-list is reserved for intentional, documented product extensions.
      # Exit/state/stdout are still compared; only a stale oracle's human-facing error enumeration
      # is exempted.  Never add a blanket fixture-level exemption here.
      f_err=KNOWN
    else
      strip_ansi "$step_dir/old.err" > "$step_dir/old.err.norm"
      strip_ansi "$step_dir/new.err" > "$step_dir/new.err.norm"
      if cmp -s "$step_dir/old.err.norm" "$step_dir/new.err.norm"; then f_err=PASS; else f_err=FAIL; fi
    fi
  fi

  label="$cmd ${args[*]}"
  label="${label:0:30}"
  row "$fx" "$idx" "$label" "$f_out" "$f_exit" "$f_yaml" "$f_err"
  count_fail "$f_out"; count_fail "$f_exit"; count_fail "$f_yaml"; count_fail "$f_err"

  if [ "$f_out" = FAIL ]; then
    say "  x [$fx #$idx $label] stdout 不一致："
    sed 's/^/      old| /' "$step_dir/old.out" | head -5 | tee -a "$REPORT"
    sed 's/^/      new| /' "$step_dir/new.out" | head -5 | tee -a "$REPORT"
  fi
  if [ "$f_exit" = KNOWN ]; then
    say "  i [$fx #$idx $label] exit 已知差异（old=${old_rc} new=${new_rc}）：$(exit_divergence_reason "$base" "$idx")"
  fi
  if [ "$f_exit" = FAIL ]; then
    say "  x [$fx #$idx $label] exit 不一致: old=$old_rc new=$new_rc"
    if [ "$bootstrap_rc" -ne 0 ]; then
      say "      new document bootstrap 失败（见 $step_dir/new.document-bootstrap.err）"
    elif [ "$convergence_bootstrap_rc" -ne 0 ]; then
      say "      new Build convergence bootstrap 失败（见 $step_dir/new.convergence-bootstrap.err）"
    elif [ "$review_bootstrap_rc" -ne 0 ]; then
      say "      new review receipt bootstrap 失败（见 $step_dir/new.review-bootstrap.err）"
    fi
  fi
  if [ "$f_yaml" = FAIL ]; then
    say "  x [$fx #$idx $label] .pipeline.yaml 不一致（白名单归一后）："
    head -40 "$step_dir/yaml.diff" | sed 's/^/      /' | tee -a "$REPORT"
  fi
  if [ "$f_out" = KNOWN ]; then
    say "  i [$fx #$idx $label] stdout build_sha 已验证为同一 commit 的 build:v1:git token"
  fi
  if [ "$f_yaml" = KNOWN ] && [ "$state_extension_rc" -eq 0 ]; then
    say "  i [$fx #$idx $label] YAML 已验证的产品演进: $state_extension"
  fi
  if [ "$f_yaml" = KNOWN ] && [ -n "$build_sha_override" ]; then
    say "  i [$fx #$idx $label] YAML build_sha 已验证为同一 commit 的 build:v1:git token"
  fi
  if [ "$f_err" = FAIL ]; then
    say "  x [$fx #$idx $label] stderr 不一致（剥 ANSI 后逐字）："
    sed 's/^/      old| /' "$step_dir/old.err.norm" | head -6 | tee -a "$REPORT"
    sed 's/^/      new| /' "$step_dir/new.err.norm" | head -6 | tee -a "$REPORT"
  fi
  if [ "$f_err" = KNOWN ]; then
    say "  i [$fx #$idx $label] stderr 已知产品差异: $divergence_reason"
  fi
}

# ---------- 降级（契约测试）单步 ----------
run_step_degraded() {
  local fx="$1" idx="$2" cmd="$3" step_dir="$4" base="$5" expect="$6"
  shift 6
  local args=("$@")
  local change="${args[0]}"
  local new_rc f_out f_exit f_yaml label

  # 降级模式没有老侧可依据，fixture 计划里那一列期望退出码就是契约本身。备不出设计体系不静默吞掉：
  # 说出来，再让契约列照常判定，免得「harness 自己坏了」被读成「产品拒绝了」。
  if [ "$cmd" = init ] && [ "$DOCUMENT_CONTRACT_BOOTSTRAP" = 1 ]; then
    if ! bootstrap_new_design_system "$base/new" \
      > "$step_dir/new.design-bootstrap.out" 2> "$step_dir/new.design-bootstrap.err"; then
      say "  ! [$fx #$idx] design system bootstrap 失败，见 $step_dir/new.design-bootstrap.err"
    fi
  fi
  (cd "$base/new" && TENON_RUNTIME_HOME="$MACHINE_HOME" "${NEW_CMD[@]}" "${NEW_ARGS[@]}") \
    > "$step_dir/new.out" 2> "$step_dir/new.err"
  new_rc=$?

  # exit 面：契约表期望值（fixture 计划第 1 列）
  f_exit=PASS
  [ "$new_rc" = "$expect" ] || f_exit=FAIL

  # stdout 面：CONTRACT §3 契约
  if [ "$expect" != 0 ]; then
    # 出错路径：stdout 必须干净（报错走 stderr）
    if [ -s "$step_dir/new.out" ]; then f_out=FAIL; else f_out=PASS; fi
  else
    case "$cmd" in
      init) # 创建路径一行
        if [ "$(wc -l < "$step_dir/new.out" | tr -d ' ')" = 1 ] && [ -s "$step_dir/new.out" ]; then
          f_out=PASS
        else
          f_out=FAIL
        fi
        ;;
      get) # 裸值，无尾空格
        if grep -qE '[[:blank:]]$' "$step_dir/new.out"; then f_out=FAIL; else f_out=PASS; fi
        ;;
      set) # 无输出
        if [ -s "$step_dir/new.out" ]; then f_out=FAIL; else f_out=PASS; fi
        ;;
      transition) # `old -> new` 一行
        if grep -qE '^[a-z]+ -> [a-z]+$' "$step_dir/new.out" \
          && [ "$(wc -l < "$step_dir/new.out" | tr -d ' ')" = 1 ]; then
          f_out=PASS
        else
          f_out=FAIL
        fi
        ;;
      check) f_out=SKIP ;; # 人读 guard 报告
      *) f_out=SKIP ;;
    esac
  fi

  # yaml 面：契约 §1 字段序（当前逻辑 46、N-1 wire 45/40、逻辑空 receipt 41
  # 或旧版 37 字段全量在序）
  local ny="$base/new/openspec/changes/$change/.pipeline.yaml"
  if [ -f "$ny" ]; then
    if keyorder_ok "$ny"; then f_yaml=PASS; else f_yaml=FAIL; fi
  elif [ "$cmd" = init ] && [ "$expect" = 0 ]; then
    f_yaml=FAIL
  else
    f_yaml=SKIP
  fi

  label="$cmd ${args[*]}"
  label="${label:0:30}"
  row "$fx" "$idx" "$label" "$f_out" "$f_exit" "$f_yaml" "SKIP"
  count_fail "$f_out"; count_fail "$f_exit"; count_fail "$f_yaml"

  [ "$f_exit" = FAIL ] && say "  x [$fx #$idx $label] exit 不符契约: got=$new_rc want=$expect"
  [ "$f_out" = FAIL ] && say "  x [$fx #$idx $label] stdout 不符 CONTRACT §3 契约（cmd=${cmd}）"
  [ "$f_yaml" = FAIL ] && say "  x [$fx #$idx $label] .pipeline.yaml 不符 §1 字段序契约"
  return 0
}

# ---------- commit 伪命令（barrier 场景造 HEAD 位移；双侧确定性同 SHA） ----------
# .oracle-plan 里 `0|commit|<seq>` 让 harness 在双侧各打一个**确定性** git commit（固定身份 + 固定
# 日期 + 单一受控文件），使 build 冻结的 build_sha 与后续 HEAD 解耦（scenario D 重冻结 / E barrier
# 拒绝）。只 add 受控文件、不 add .pipeline.yaml——后者双侧内容不同（新 CLI 带 run_id 等新字段），
# 全量 add 会让两侧 commit tree 不同 → SHA 漂移；只提交固定内容文件则双侧 tree/parent 全同 → SHA 同。
git_commit_side() {
  local dir="$1" seq="$2" d
  d="2026-02-$(printf '%02d' "$seq")T00:00:00Z"
  (
    cd "$dir" || exit 1
    printf 'oracle barrier fixture commit %s\n' "$seq" > "barrier-src-${seq}.txt"
    export GIT_AUTHOR_NAME=oracle GIT_AUTHOR_EMAIL=oracle@pipeline.test \
           GIT_COMMITTER_NAME=oracle GIT_COMMITTER_EMAIL=oracle@pipeline.test \
           GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d"
    git add "barrier-src-${seq}.txt" && git commit -q -m "oracle fixture commit $seq"
  )
}

run_step_commit() {
  local fx="$1" idx="$2" step_dir="$3" base="$4"; shift 4
  local seq="$1"
  local sides="new"; [ "$MODE" = dual ] && sides="old new"
  local s ok=PASS
  for s in $sides; do
    git_commit_side "$base/$s" "$seq" > "$step_dir/commit.$s.log" 2>&1 || ok=FAIL
  done
  # commit 是 harness 造 HEAD 位移，不入四面比较（全 "-"）；失败则计一处 FAIL。
  row "$fx" "$idx" "commit $seq" "-" "-" "-" "-"
  count_fail "$ok"
  [ "$ok" = FAIL ] && say "  x [$fx #$idx commit $seq] git commit 失败（见 $step_dir/commit.*.log）"
}

# ---------- seed 伪命令（注入绕过 set 闸的脏字段值；测枚举纵深防线等 set 面到不了的 guard 失败） ----------
# .oracle-plan 里 `0|seed|<change>|<field>|<value>` 让 harness 在**每个活跃侧各自 init 产出的**状态文件上
# 对目标字段做**行定位替换**（`^<field>:` 整行改成 `<field>: <value>`），其余行原样。因为只改一行、且两侧
# 各改各的同名字段行，双侧内容差异面（run_id 等）不受影响；随后的 transition 拒绝步在双侧读到同一脏值 →
# 逐字比同一条 renderer 文案。用途：isolation 非法枚举（field-in）是绕过 set 闸的纵深防线，`set` 会被两侧
# validate_enum 同样拒（到不了该 guard），只能靠 seed 把脏值直接写进落盘状态再跑 transition 触发。
# G1 后新侧 YAML 是 adapter，直接编辑必须被 canonical 隔离；所以改完新侧 adapter 后立即通过公开
# `state import-legacy` 显式导入，既保留“绕过 set 闸”的测试目的，又不偷偷恢复双主读取语义。
run_step_seed() {
  local fx="$1" idx="$2" step_dir="$3" base="$4"; shift 4
  local change="$1" field="$2" value="$3"
  local sides="new"; [ "$MODE" = dual ] && sides="old new"
  local s ok=PASS sf
  for s in $sides; do
    sf="$base/$s/openspec/changes/$change/.pipeline.yaml"
    if [ -f "$sf" ] && grep -qE "^${field}:" "$sf"; then
      awk -v f="$field" -v v="$value" '
        $0 ~ "^"f":" { print f": "v; next }
        { print }
      ' "$sf" > "$sf.seed" && mv "$sf.seed" "$sf" || ok=FAIL
    else
      ok=FAIL
    fi
  done
  if [ "$ok" = PASS ]; then
    if ! (cd "$base/new" && TENON_RUNTIME_HOME="$MACHINE_HOME" "${NEW_CMD[@]}" state import-legacy "$change") \
      > "$step_dir/new.import.out" 2> "$step_dir/new.import.err"; then
      ok=FAIL
    fi
  fi
  # seed 是 harness 造脏值注入，不入四面比较（全 "-"）；写失败/字段行缺失则计一处 FAIL。
  row "$fx" "$idx" "seed $field=$value" "-" "-" "-" "-"
  count_fail "$ok"
  [ "$ok" = FAIL ] && say "  x [$fx #$idx seed $field=$value] 状态文件写入失败或字段行缺失（见 ${step_dir}）"
}

# ---------- 历史尾块 PRESERVE 校验（新侧，逐字子串） ----------
check_preserve() {
  local fx="$1" base="$2"
  local pf="$base/new/.oracle-preserve"
  [ -f "$pf" ] || return 0
  local change baseline content res
  change=$(head -n 1 "$pf")
  baseline=$(tail -n +2 "$pf")
  content=$(cat "$base/new/openspec/changes/$change/.pipeline.yaml" 2>/dev/null || printf '')
  case "$content" in
    *"$baseline"*) res=PASS ;;
    *)
      res=FAIL
      say "  x [$fx PRESERVE] 老内核 base64 历史尾块未被新侧逐字保留（CONTRACT §1）"
      ;;
  esac
  count_fail "$res"
  row "$fx" "--" "PRESERVE(history-tail)" "-" "-" "$res" "-"
}

# ---------- fixture 主循环 ----------
run_fixture() {
  local fx="$1"
  local fxsh="$ORACLE_DIR/fixtures/$fx.sh"
  if [ ! -f "$fxsh" ]; then
    say "x fixture 不存在: ${fx}（可用: $(ls "$ORACLE_DIR/fixtures" | sed 's/\.sh$//' | tr '\n' ' ')）"
    FAILS=$((FAILS + 1))
    return 0
  fi
  local base="$WORKDIR/$fx"
  rm -rf "$base"
  mkdir -p "$base"
  local sides="new"
  [ "$MODE" = dual ] && sides="old new"
  local s
  for s in $sides; do
    if ! bash "$fxsh" "$base/$s" > "$base/fixture-gen.$s.log" 2>&1; then
      say "x fixture 生成失败: $fx ($s)，见 $base/fixture-gen.$s.log"
      FAILS=$((FAILS + 1))
      return 0
    fi
  done

  say "== fixture: $fx =="
  local plan="$base/new/.oracle-plan"
  local idx=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    idx=$((idx + 1))
    local F
    IFS=$'\t' read -r -a F <<< "$line"
    local expect="${F[0]}" cmd="${F[1]}"
    local args=("${F[@]:2}")
    local step_dir
    step_dir="$base/steps/$(printf '%02d' "$idx")"
    mkdir -p "$step_dir"
    if [ "$cmd" = commit ]; then
      run_step_commit "$fx" "$idx" "$step_dir" "$base" "${args[@]}"
      continue
    fi
    if [ "$cmd" = seed ]; then
      run_step_seed "$fx" "$idx" "$step_dir" "$base" "${args[@]}"
      continue
    fi
    build_args "$cmd" "${args[@]}"
    if [ "$MODE" = dual ]; then
      run_step_dual "$fx" "$idx" "$cmd" "$step_dir" "$base" "${args[@]}"
    else
      run_step_degraded "$fx" "$idx" "$cmd" "$step_dir" "$base" "$expect" "${args[@]}"
    fi
  done < "$plan"
  check_preserve "$fx" "$base"
}

FIXTURES=("$@")
if [ ${#FIXTURES[@]} -eq 0 ]; then
  FIXTURES=(backend-full frontend-quotegate pm-history)
fi

for fx in "${FIXTURES[@]}"; do
  run_fixture "$fx"
done

# ---------- 汇总（命令 × 三面） ----------
say ""
say "=== 汇总（命令 × 三面：STDOUT / EXIT / YAML）==="
{
  printf '%-20s %-4s %-32s %-7s %-7s %-7s %-7s\n' FIXTURE STEP COMMAND STDOUT EXIT YAML STDERR
  while IFS=$'\t' read -r c1 c2 c3 c4 c5 c6 c7; do
    printf '%-20s %-4s %-32s %-7s %-7s %-7s %-7s\n' "$c1" "$c2" "$c3" "$c4" "$c5" "$c6" "$c7"
  done < "$ROWS"
} | tee -a "$REPORT"
say ""

if [ "$MODE" = degraded ]; then
  say "DEGRADED: 契约测试模式（未做双跑）。原因: $DEGRADED_REASON"
  say "结果: 契约不符 $FAILS 项（降级运行恒 exit 0，报告已标明降级）"
  say "报告: $REPORT"
  exit 0
fi

if [ "$FAILS" -eq 0 ]; then
  say "结果: 双跑全部一致（0 处不一致）"
  say "报告: $REPORT"
  exit 0
fi
say "结果: $FAILS 处不一致（明细见上方与 ${REPORT}，现场保留在 ${WORKDIR}）"
say "报告: $REPORT"
exit 1
