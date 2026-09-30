# 测试证据可信根：设计

依据：prd.md（R1-R7）、product-audit.md §2.3、acceptance F8。威胁模型不变：同 UID 的 agent 不是密码学对手，hook + 摘要台账 + 人工确认是防线；本任务把「agent 想过关」从无成本变成必须绕开多层、且留痕。

## 0. 三层防线

1. **静态拦截（gate.sh）**：写入命令的目标路径匹配，覆盖 13 种已知写法（§3）。尽力而为、线性、bash 3.2。
2. **转换时检出（kernel evaluate）**：受保护文件摘要与 CLI 写入台账比对，记录链头与台账比对；台账外的改动 = 阻塞。
3. **人工确认（review）**：目录、基线、已知失败、工作流在任务 diff 中出现 = 阻塞，确认走豁免批准的同一条路径。

## 1. 本机封存文件 `<user-dir>/local/test-seal.json`

按用户、gitignored、0600。内容用 HMAC-SHA256（密钥 `local/env.key`，缺则首次创建）封存，整份一个 mac：

```
{ schema: tenon-test-seal/v1,
  heads:    { <change>: <v2 记录链头 digest> },                  // appendTestRunRecordV2 在链锁内更新
  writes:   { <repo 相对路径>: { digest, at } },                  // known add|rm、baseline --suite 写共享受保护文件后更新
  approvals:[ { change, path, digest, by, at } ],                 // 人工 review acknowledge 批准的受保护改动
  trusted:  [ { digest, by, at } ],                               // R6：用户信任过的目录可执行摘要
  mac }
```

mac 不符、文件损坏 = 空封存（失败关闭：无信任、无批准、无链头 → 相应阻塞），不抛错。写入统一经 `sealUpdate`（同目录锁 + 原子替换）。gate.sh 拒绝对 `test-seal.json`、`env.key` 的写入。这不是对同 UID 恶意者的防御（能读 env.key 就能重算），是把「误改」与「顺手改」变成必须刻意做。

## 2. R1 + R3：受保护改动需人确认

- 受保护集（`isApprovalProtectedPath`）：`.tenon/tests/catalog.yaml`、`.tenon/tests/baselines/**`、`.tenon/tests/known-failures.yaml`、`.pipeline/workflows/*.yaml`。
- 本任务 diff：`git diff --name-only --no-renames start -- <这几个 pathspec>`（含删除）+ 未跟踪；start 与 changed-files 同口径。读不出 → `files-diff-unavailable`（失败关闭）。
- 每项 `{path, digest|null}`。批准 = 封存 `approvals` 里有同 change + path + digest。之后文件再变 → 摘要不同 → 重新阻塞。
- 阻塞码 `protected-file-unapproved`；仅在 review 门步骤（`gate: review`）上判定，build 这类无门步骤不判（否则无人可批）。修复命令 = `tenon review request <c> --event <e>`。
- `tenon review request` 在 Change 锁内把「未批准的受保护改动」与待批准豁免一起冻结进 `.pipeline-review-waivers.json`（新增可选 `protected` 键），并逐条列给用户：文件、状态（新增/修改/删除）、摘要、来源（Tenon 命令写的 / 台账外改动）。目录与已知失败附语义摘要（新增/改动的套件命令、新增的已知失败条目）。
- 人工 `acknowledge`（非 `--delegated`）：在提交 approved receipt 的同一把锁内，对冻结清单里「当前摘要仍等于冻结摘要」的项写入封存 approvals；Dashboard 确认走同一函数（`approveFrozenWaivers` 扩展，输出多一个 `protectedApproved`）。`--delegated` 在有待批准受保护改动时整体拒绝（与豁免一致）。
- R3 已知失败：`test` 必须是 `<文件> › <用例名>`（文件-only 拒绝，解码期报错）；`expires` 距今不得超过 30 天（`known add` 拒绝；手写超长的条目在判定时不被承认，按普通失败 + `known-failure-too-long` 提示）；新增本身是 known-failures.yaml 的改动，走上面的人工确认。

## 3. R4：13 种写法与转换时检出

gate.sh 在既有「只看写入目标」框架上补齐（详见 tools/test-hooks.sh 的逐条用例）：

| # | 写法 | 处理 |
|---|---|---|
| 1 | `python3 -c` / `python -c` 内联写 | 命令文本含受保护路径 + 解释器内联 → 拒 |
| 2 | `node -e` / `perl -e` / `ruby -e` | 同上 |
| 3 | `curl -o/--output`、`wget -O` | 输出目标路径匹配 |
| 4 | `tar -x/-C`、`unzip -d` | 解到受保护目录（-C/-d 或成员路径）拒 |
| 5 | `git checkout/restore [rev] -- <受保护>` | 拒（含无 rev 形式：内容来源不可控） |
| 6 | `git apply` / `patch` | 补丁文件（可读）或 heredoc 正文含受保护路径头 → 拒 |
| 7 | 变量路径 | 同一命令内 `NAME=值` 赋值后展开 `$NAME` / `${NAME}`；含受保护字样但目标无法展开 → 拒 |
| 8 | 脚本文件 | `bash|sh|zsh|python*|node|ruby|perl <file>`、`./file`：文件含受保护路径且未被 git 跟踪或已修改 → 拒 |
| 9 | `xargs sh -c` 等 | 命令含受保护字样时，xargs/parallel 后接非只读命令 → 拒；`find` 带 `-exec/-execdir/-delete/-fprint` 拒 |
| 10 | cp/mv/install/rsync/ln 变体 | `-t`、`--target-directory`、目录目的地、源在受保护路径的 mv |
| 11 | tee 变体 | `tee -a`、`sudo tee`、`>(tee f)`（进程替换按新命令段扫描） |
| 12 | 重定向变体 | `>|`、`&>`、`1>`、`: >`、`exec 3>`、`{ …; } >`、`<<<` 与命令替换内的重定向 |
| 13 | 就地编辑器 | `sed -i`、`perl -pi`、`ruby -i`、`awk -i inplace`、`truncate`、`dd of=`、`rm` |

无法静态拦截的（脚本被间接构造、变量来自别处、目标经字符串拼接）在转换时检出：

- 记录：`heads[change]` 与当前链头不等（含无封存条目）→ 阻塞 `record-unsealed`，无人工批准路径，重跑 `tenon test run` 生成带封存的记录。
- 共享受保护文件：diff 里的文件，若封存 `writes[path].digest` 存在且不等于当前摘要、又没有匹配的人工批准 → 阻塞 `protected-file-tampered`（review request 里标「台账外改动」）；人工批准该摘要后放行。

## 4. R2：报告可信

- `prepareOutputs` 已在运行前删旧报告；新增：记录运行开始时间，报告 `mtime` 早于（向下取整到秒）运行开始 → 原因 `report-untrusted`（`cp -p`/`touch -d` 回填）；报告 lstat 必须是普通文件（已有）。
- 报告与覆盖率无论是否在 `artifacts` 里，都复制进本次运行的产物目录 `artifacts/<套件>/<报告路径>` 并索引；记录里 `report.digest` 必须等于该索引项的 digest（运行期间被改写 → 不等 → `report-untrusted`）。判定层（kernel `evaluateSuiteResult`）对有 `report.path` 的套件再次校验这一致性，所以运行时与门禁重算同口径。
- 报告与退出码交叉校验（`exit-report-mismatch`）保留。

## 5. R5：评审者重跑

- 台账行新增可选 `rerun_reason`。`tenon agent prompt <c> <agent> --rerun-reason <文字>`：评审者在本次步骤访问、当前候选上已有已结束运行时，再开一次必须带原因，否则 exit 2 并说明（改代码换候选，或写明原因）。
- 判定 `evaluateStepAgents`：同一评审者在**当前候选**上的全部已结束运行都保留；结论取最严（任一运行有 ≥ block_at 的发现即不通过），**除非**最后一次运行带 `rerun_reason`（视为有说明的重跑，以它为准并留痕）。
- `AgentView` 新增 `reruns`（当前候选上的额外运行数）、`flipped`（前面有不通过、最后通过）、`rerunReason`。`tenon status`/`agent next` 与 Dashboard 智能体行显示重跑次数与是否翻转。

## 6. R6：首次信任

- 可执行摘要 `catalogExecDigest`：所有套件的 `id/cwd/command/select.files/select.grep/env` 与所有服务的 `id/start/cwd/ready/stop`，规范 JSON 后 sha256；只改标签、tags、covers 不重问。
- `tenon test run`（目录批量与旧的步骤内联两条路径）执行前校验：封存 `trusted` 含当前摘要，或环境变量 `TENON_TEST_TRUST=1`（CI 显式信任；每次运行打印一行注明信任来自环境）。否则 exit 1，打印将执行的命令清单与「在你自己的终端运行 `tenon test trust`」。
- `tenon test trust [--yes] [--json]`：列出可执行清单与摘要；交互终端上确认（y/N）；非交互必须 `--yes`。gate.sh 拒绝 agent 命令里出现 `tenon test trust`、`TENON_TEST_TRUST`、`test-seal.json`、`env.key` 的写入，所以信任只能由用户在自己的终端里给。
- 旧的步骤内联测试命令来自工作流定义，同样按「步骤测试命令摘要」信任。

## 7. R7：指纹只忽略声明的产物路径

- `fingerprintWorkspace(root, { declaredOutputs })`：任意层级 `coverage/`、`test-results/`、`playwright-report/`、`.cache` 不再默认忽略；只忽略 `node_modules`、`.pytest_cache`、`__pycache__`（依赖与解释器缓存）与 `declaredOutputs`（仓库相对文件或目录）。
- `candidateFingerprint(root)`（kernel test-system）= 目录声明的 `report.path`、`coverage.path`（含同目录 `coverage-final.json`）、`artifacts[]`（均按套件 `cwd` 解析）∪ 未归档任务冻结工作流里步骤内联测试的 `outputs[].path`。生产接线（CLI、server、build revision 捕获）全部改用它，口径唯一。
- `isWorkspaceCandidatePath`（code-size 度量的口径）保持原状，不属于证据。

## 8. 验收测试映射

- 13 种写法：tools/test-hooks.sh 每种至少一条拒绝 + 相邻放行。
- 伪造报告：suite-exec 集成（回填 mtime、运行期间改写、命令直接 `cat fake > report` 在未信任目录下拒跑、封存缺失的链头被判 `record-unsealed`）。
- 已知失败自助白名单：`known add` 文件-only / 超 30 天拒；新增条目在 review 门阻塞、人工批准后放行、批准后再改又阻塞。
- 基线改写：`baseline` 写入后 review 门阻塞；带外改写标 `protected-file-tampered`。
- 评审者重跑：无原因拒、有原因留痕、旧行无原因取最严、Dashboard 快照带 `reruns`。
- 未信任克隆：`tenon test run` 拒跑、`test trust --yes` 后可跑、目录命令改动后再次拒跑、`TENON_TEST_TRUST=1` 放行。

## 9. 残余风险

同 UID 恶意者可读 env.key 重算封存；构造性混淆（拼接字符串生成路径、二次编码）静态拦截不了，靠转换时检出与人工确认兜底；`.pipeline.yaml` 投影与 `.pipeline/workflows/*.yaml` 仅靠 review 确认，不在 hook 写入拒绝集里（Dashboard 与工作流技能会合法写它们）。
