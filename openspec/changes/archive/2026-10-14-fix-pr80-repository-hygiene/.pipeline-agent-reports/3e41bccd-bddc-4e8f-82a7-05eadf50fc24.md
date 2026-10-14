# 评审报告：fix-pr80-repository-hygiene

## 目标条目与证据对照

1. **卫生检查不再报这 9 处，且没有新增失败。**
   - 实现证据：`AUDIT_REFERENCE_DOCS` 新增 9 个路径。
   - 验证：我跑了 `node tools/check-repository-hygiene.mjs`，输出 PASS。
   - 结论：达成。
2. **豁免只覆盖这 9 个精确路径，只豁免第一个身份。名单外路径和名单内的第二、第三个身份仍报错，并有测试钉住。**
   - 实现证据：用的是 `Set` 精确匹配，没有前缀或通配。
   - 测试证据：新增测试 `allows product identity only in the exact archived hook-isolation records`。
     - 9 个路径放行。
     - 3 个名单外路径各报错一次，包括同目录的 `design.md` 和 reports 目录下的其他文件。
     - 对名单内路径写入第二、第三个身份，各报错 1 次。
   - 结论：达成。
   - 我没有在旧代码上回放这条测试。不过旧代码里这 9 个路径不在 Set 中，`checkReferenceIdentities(root, allowed)` 必然报错，所以测试会失败。
3. **只改这两个文件，不改那 9 个文档。**
   - `git diff -- tools/` 只显示这两个文件有改动。
   - 我没有看到那 9 个文档被改。工作区里其他未跟踪项都在你说明的在途任务范围内。
   - 结论:达成。
4. **测试代码里不出现三个身份的明文。**
   - 测试用 `String.fromCharCode` 拼出这三个身份，整份测试文件里没有明文。
   - 全量卫生检查 PASS，说明测试文件自身也通过了扫描。
   - 结论：达成。

测试运行：`node --test tools/check-repository-hygiene.node-test.mjs` 共 16 项，全部通过。

## 假设

- 把这 9 个路径放进已有的 `AUDIT_REFERENCE_DOCS`，与既有的固定调查记录豁免走同一条机制。我没有核对该 Set 在检查函数里是否还附带其他放宽，比如图片或其他规则。从测试结果看，名单内路径出现第二、第三个身份仍然报错，所以身份检查没有被整体放过。

## 发现清单

- **low**，`tools/check-repository-hygiene.mjs`：这个 Set 的名字叫 AUDIT，现在也装了评审台账和任务文档。可以考虑改名，但不影响功能，改动也会超出本任务范围，不建议此时处理。

无 critical、high、medium 问题。

## 未能判定的条目

无。

```tenon-result
{"findings":[{"severity":"low","location":"tools/check-repository-hygiene.mjs:97","message":"AUDIT_REFERENCE_DOCS 现在也装已归档任务的评审台账和任务文档，名字略窄；不影响功能，不建议本任务内改"}]}
```
