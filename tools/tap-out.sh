#!/usr/bin/env bash
# tap-out.sh — 给 bash 验收脚本（test-hooks / test-adapters / test-bundle）一条可选的 TAP 输出通道。
#
# 被 source 后提供两个函数；未设置 TENON_TAP_OUT 时它们什么都不做，脚本的人读输出与退出码不变。
# 设置 TENON_TAP_OUT=<路径> 时，每条 ok / bad 同时追加一段 TAP：
#     ok - <描述>
#       ---
#       location: '<脚本相对路径>:1:1'
#       ...
# location 是 TAP 解析器把用例归到文件的唯一来源：没有它，登记给这个套件的脚本文件会因为
# 「报告里找不到对应用例」被判 registered-test-not-executed。
#
# 用法（在脚本里、定义 ok / bad 之前）：
#   source "$(dirname "${BASH_SOURCE[0]}")/tap-out.sh"; tap_init tools/test-hooks.sh
# 然后在 ok() 里调 tap_result ok "$1"，在 bad() 里调 tap_result "not ok" "$1"。

TAP_FILE_LABEL=""

tap_init() {
  TAP_FILE_LABEL="$1"
  [ -n "${TENON_TAP_OUT:-}" ] || return 0
  mkdir -p "$(dirname "$TENON_TAP_OUT")"
  printf 'TAP version 13\n' > "$TENON_TAP_OUT"
}

tap_result() { # $1 = ok | "not ok"，$2 = 描述
  [ -n "${TENON_TAP_OUT:-}" ] || return 0
  local name="${2//$'\n'/ }"
  printf '%s - %s\n  ---\n  location: '"'"'%s:1:1'"'"'\n  ...\n' "$1" "$name" "$TAP_FILE_LABEL" >> "$TENON_TAP_OUT"
}
