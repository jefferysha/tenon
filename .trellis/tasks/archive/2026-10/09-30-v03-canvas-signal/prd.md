# 画布与 Signal 动画重做
依据：../09-30-v03-production/design-audit.md §2（D1–D9）、§3（Signal 规格与组件计划）、§5；UI 规则 ../09-30-v03-production/ui-prefs.md。
## 需求
- R1 连线：--flow-line/--flow-done/--flow-comet token（明暗），getSmoothStepPath borderRadius 8，1.25–1.5px，对比度 ≥3:1；只在汇入处保留一个 5px 箭头；分叉/汇合走线离开节点与列（RAIL 12）；回流弧 --flow-line 1.25px 虚线 2 3、5px 箭头，不被裁切。
- R2 节点：40px（总览视觉 32px、热区 40px），左侧状态符号（形状+颜色），名称常规字体 Inter 500 14px、中间截断保尾（尾部 6 字符固定），类别安静图标；默认状态不写字，只有非默认状态显示；端口 6px 悬停/活动路径显示；运行节点静态强调边框 + 3px 光环 + 旋转弧形符号（替代 animate-pulse）。
- R3 阶段列：去掉边框，标题行 + 4% 色带，高度贴内容；列头可点击平滑缩放到该阶段（320ms）；空泳道只读隐藏、编辑时显示一个幽灵「+」。
- R4 总览：默认按宽度适配（最小缩放 0.6），语义缩放（<0.7 只显示符号，1 显示名称，≥1.25 显示元信息）；控件收为左下角一行 40px。
- R5 单阶段画布：左对齐 24px、上下留白 24px（含起终点标签）、节点宽 320、泳道标签为节点上方 13px 分组标题。
- R6 Signal：新增 workflow/flowSignal.ts 取代 flowPulse.ts：planSignal 纯函数（到达距离、恒速、分叉汇合同步）、useSignal(container, mode, frontier)；4 层彗星参数按规格；空闲 140px/s ×0.7、运行 300px/s 从当前节点到终点；已完成线实线强调色；评审门停住并琥珀环、自动门闪过；节点到达反馈（opacity 90ms 升、520ms 降）、起点发射环、终点到达环；单一 gsap.ticker、只写热边、缓存路径长度、IntersectionObserver + document.hidden 暂停；减少动态效果静态高亮；超过 2ms/帧 时可切 MotionPath 圆点（记录性能测量）。
- R7 阶段条：3px，完成=--text-3 暖灰、当前=--accent、未到=--border，选中=标签下 2px 墨色下划线，阻塞不呼吸；运行时当前段上滑过同一 Signal 彗星。
- R8 暗色模式与对比度：状态色可分辨（完成 vs 当前 ≥3:1），按规格改边框 token。
## 验收
- planSignal 单测（分叉、汇合、恒速、到达顺序）、组件测试、减少动态效果测试；浏览器走查（主线程）：明暗、总览/单阶段/工作台总览、运行中/空闲/阻塞三态。
- 性能：总览 8 列 50 节点下动画每帧脚本 <2ms（Performance 记录或 bench）。
