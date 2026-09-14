# set phase/review 旁路（已修复）

提交 `1bb3da0` 已拦截 set、set-many、cas 的 phase/review 直接写入。剩余 `import-legacy` 入口另立 P0 子任务 `09-14-import-legacy-phase-review-bypass`，完成前不得宣称旁路全部关闭。
