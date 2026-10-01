/**
 * migrate-workflow <name> —— Task 4 之前创建的老 change 一次性迁移工具
 * （workflow 定制引擎 Task 10）。
 *
 * 实测结论（Task 10 实现前的真实验证，见 task-10-report.md 完整命令+输出）：
 * parsePipeline() 起手于 emptyFields()，而 emptyFields() 把 workflow 缺省为 'default'
 * （Task 4）；解析器只在文件里找到某已知字段的行时才覆写骨架值，文件里完全没有
 * `workflow:` 这一行时，读出来的 fields.workflow 本来就已经是 'default'，不是 '' 也不是
 * undefined。也就是说：
 *   - "老 change，字段物理缺失"和"已迁移 / Task 4 起新建 change，字段物理写着
 *     workflow: default"，这两种情况经 store.get 读出来完全无法区分（都是 'default'）；
 *   - 唯一能观察到的信号只有"当前值是不是 default"——非 default 只可能是真实自定义
 *     workflow（Task 5-9 落地的合法产物：自定义 skill DAG / step 转换），绝不能当成
 *     "老格式待迁移"覆写掉。
 *
 * 因此本命令的判定条件是"current 解析为 default（含 undefined）→ 无条件补齐/确认落盘；
 * 否则视为真实定制、绝不触碰"——不是任务简报 Step 3 示例代码的写法（那份示例是
 * current==='default' 时跳过不写、否则覆写成 default）。验证后发现示例代码的方向是反的：
 * 给定上述读时兜底行为，示例代码的覆写分支只会在遇到真实自定义 workflow 时触发，会把用户的
 * 定制冲回 default，是破坏性 bug。
 *
 * current 已解析为 default 时无条件（重新）写一次：老文件借此真正把字段物理补齐到磁盘
 * （confirm + 落盘，为未来解析器兜底行为变化兜底——如 emptyFields() 的特判被移除，老文件
 * 不会再悄悯读成 default）；已迁移文件则是无害的同值重写。store 层不暴露"字段是否物理
 * 存在于文件"这一信号，两种子情况在 store.get 面前本就不可区分，收敛到同一个安全写入即可。
 *
 * TOCTOU 修复（task review Important finding）：上面这次"无条件写一次"原先是 store.get 读一次
 * 、判定完再 store.set 落盘——check-then-act 两步之间隔着锁获取的窄窗口，若一个真实合法的
 * 并发写手（例如某个正在执行的 `tenon set <name> workflow <custom>`）恰好落在这个窗口里，
 * 会被本命令的无条件 set 悄悄冲回 default，等价于本文件开头详述的"覆写真实定制"数据损坏
 * bug——只是触发条件从"静态已是自定义值"变成了"落盘瞬间被并发改成自定义值"，本质是同一类问题
 * 换了个时序面。修复：把落盘那一步换成 store.cas(dir,'workflow',current,'default')——expect
 * 用刚读到的 current，锁内比对+条件写原子完成。cas 返回 false 说明落盘前值已被并发改动，
 * 一律当"真实定制，不覆写"处理（不重试、不循环 —— 重试仍可能再次撞见新一轮并发写，且重试前
 * 必须重新 get 才能拿到新的 expect，那已经是另一次独立尝试而非"重试同一次决定"），只诚实上报。
 */
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { msg } from '../i18n/messages.js'

export async function cmdMigrateWorkflow(deps: CliDeps, name: string): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: ${msg(deps, 'change.nameInvalid', { name })}`)
    return 1
  }
  const dir = changeDir(deps.cwd, name)
  try {
    const current = await deps.store.get(dir, 'workflow')
    if (current !== 'default' && current !== undefined) {
      deps.io.err(`[MIGRATE] ${name}: workflow='${current}'（非 default，视为真实定制，跳过，不覆写）`)
      return 0
    }
    // current 此刻只可能是 'default' | undefined（emptyFields() 兜底下二者物理不可区分，
    // 见文件头）；cas 的 expect 就用这个刚读到的观测值——undefined 时按同一桶归一成 'default'
    // 字面量（两者本就是同一个"待补齐"信号，cas 层需要一个具体字符串去比对锁内重读的当前值）。
    const expect = current ?? 'default'
    const ok = await deps.store.cas(dir, 'workflow', expect, 'default')
    if (!ok) {
      deps.io.err(
        `[MIGRATE] ${name}: workflow 字段在读取后、落盘前被并发修改（cas 未命中），` +
          `视为出现真实并发写入，跳过本次迁移写入，不覆写`,
      )
      return 0
    }
    deps.io.err(`[MIGRATE] ${name}: workflow 字段已确认/补齐为 default（phase 等其余字段值不变）`)
    return 0
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}
