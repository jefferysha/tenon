# 修复技能门禁误报与产品身份门禁

## Goal
修复 verify-skills 对 `.claude/skills` 的错误重复判定，同时保留仓库 Claude Code 集成配置，并让身份门禁缺文件时可读失败。

## Requirements
- 发行扫描只认 canonical `skills/`，排除 `.claude/`、`.agents/`、`.pipeline/` 投影。
- `.claude/` 不整体 gitignore；如需忽略只能细粒度并有路径验证。
- 恢复 HEAD 版本 `AGENTS.md`，identity checker 对缺失/不可读/managed block 缺失输出稳定错误。
- 真正重复 Skill fixture 仍必须失败。

## Acceptance criteria
- [ ] verify-skills 与 test-hooks 通过。
- [ ] identity 正常与缺失 fixture 均有稳定结果。
- [ ] `.claude/` 配置未被删除或整体忽略。
