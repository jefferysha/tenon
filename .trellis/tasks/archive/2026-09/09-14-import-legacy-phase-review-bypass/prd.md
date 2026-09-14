# 关闭 import-legacy phase/review 旁路

`store.importLegacyProjection` 不得把 `.pipeline.yaml` 中的 phase、review_gate_*（含 review_acknowledged_via）或 transition 保护字段发布成新的 canonical revision。采用 fail-closed 拒绝或保留 canonical 的方案并写明理由；覆盖 `tenon state import-legacy` 与 server POST operations，验证修改 yaml phase 后 phase 不变或请求被拒绝。另记录 hooks 是否拦截直接编辑 yaml。
