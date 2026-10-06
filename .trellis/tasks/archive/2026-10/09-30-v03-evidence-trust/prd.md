# 测试证据可信根
依据：../09-30-v03-production/product-audit.md §2.3（13 种绕过、catalog command 伪造、known 自助白名单、指纹忽略目录、无密钥链）与验收 F8（评审者重跑刷结果）。
## 需求
- R1 改动 .tenon/tests/catalog.yaml、baselines/、known-failures.yaml、.pipeline/workflows/*.yaml 在本任务 diff 中出现时产生阻塞，需人确认（纳入评审请求，确认方式同豁免批准）。
- R2 运行记录的报告文件必须在本次运行开始之后生成、位于本次运行的产物目录副本内；报告与退出码交叉校验保留。
- R3 已知失败必须指向具体用例（file › name），过期上限 30 天，新增需人确认。
- R4 gate.sh 拦截 13 种已知写法（python3 -c、node -e、curl -o、tar -x、git checkout -- <protected>、git apply、变量路径、脚本文件、xargs sh -c 等），无法静态拦截的在 transition 时通过受保护文件摘要比对检出（记录链外的受保护文件改动 → 阻塞）。
- R5 评审者裁决防刷：同一候选代码上评审者的多次运行全部保留，裁决取最严（或要求说明为何重跑并记录）；Dashboard 显示重跑次数。
- R6 克隆仓库首次执行其目录中的测试命令/服务前需要用户确认信任（记录在用户本地），CI 环境可显式信任。
- R7 指纹不再整体忽略任意层级的 coverage/test-results 目录，只忽略目录声明的产物路径。
## 验收
13 种写法逐一有测试；伪造报告、刷评审、改基线场景各有集成测试。
