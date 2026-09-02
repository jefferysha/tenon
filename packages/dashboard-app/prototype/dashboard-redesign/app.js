const DATA = {
  project: "Tenon",
  workflow: "product-to-production",
  track: "full-stack",
  change: "enterprise-sso-audit",
  stages: [
    { id: "plan", name: "Plan", zh: "需求与架构", status: "complete", skills: ["product-brief", "improve-architecture"], time: "已完成" },
    { id: "build", name: "Build", zh: "前后端实现", status: "current", skills: ["nestjs-patterns", "react-patterns", "tdd"], time: "进行中" },
    { id: "review", name: "Review", zh: "质量与安全", status: "pending", skills: ["code-review", "security-audit"], time: "待开始" },
    { id: "release", name: "Release", zh: "验收与发布", status: "pending", skills: ["e2e-testing", "deployment-patterns"], time: "待开始" },
  ],
  artifacts: [
    ["PRD", "product-brief.md", "已签收"],
    ["ADR", "architecture-decision.md", "刚刚"],
    ["TEST", "workflow-e2e-report.html", "草稿"],
  ],
};

const icons = {
  grid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="4" height="4" rx="1"/><rect x="10" y="2" width="4" height="4" rx="1"/><rect x="2" y="10" width="4" height="4" rx="1"/><rect x="10" y="10" width="4" height="4" rx="1"/></svg>',
  flow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.5 5.5 10.5 10.5"/><path d="M12 4v4"/><path d="M10 6h4"/></svg>',
  box: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m8 1.8 5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9L8 1.8Z"/><path d="m2.8 5 5.2 3 5.2-3M8 8v6"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3 8.3 3.2 3.1L13 4.8"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg>',
  spark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m8 1.8.9 4.3L13.2 7l-4.3.9L8 12.2l-.9-4.3L2.8 7l4.3-.9L8 1.8Z"/><path d="m12.7 10.5.4 1.9 1.9.4-1.9.4-.4 1.9-.4-1.9-1.9-.4 1.9-.4.4-1.9Z"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.8h5l3 3v9.4H4V1.8Z"/><path d="M9 1.8v3h3M6 8h4M6 10.5h4"/></svg>',
  chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m6 3 5 5-5 5"/></svg>',
};
Object.keys(icons).forEach((key) => { icons[key] = icons[key].replace("<svg ", '<svg class="icon" '); });

const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const stageStatus = (status) => status === "complete" ? "ok" : status === "current" ? "warn" : "idle";
const statusLabel = (status) => status === "complete" ? "已完成" : status === "current" ? "执行中" : "待开始";

function switcher(active) {
  const labels = { a: "A · Task Command", b: "B · Flow Canvas", c: "C · Guided Build" };
  return `<div class="variant-switcher" role="group" aria-label="Prototype variants">
    <button class="switcher-button" data-switch="prev" aria-label="上一版">←</button>
    <span class="switcher-label">${labels[active]} <span class="switcher-key">· ← →</span></span>
    <button class="switcher-button" data-switch="next" aria-label="下一版">→</button>
  </div>`;
}

function variantA() {
  const rows = DATA.stages.map((stage, index) => `<div class="stage-row ${stage.status === "current" ? "selected" : ""}" data-stage="${stage.id}" tabindex="0">
    <span class="stage-number">${String(index + 1).padStart(2, "0")}</span>
    <span class="stage-name">${esc(stage.name)}<small>${esc(stage.zh)}</small></span>
    <span class="skill-run">${stage.skills.map((skill) => `<span class="skill-chip">${esc(skill)}</span>`).join("")}</span>
    <span class="stage-time"><span class="status ${stageStatus(stage.status)}">${statusLabel(stage.status)}</span><br>${esc(stage.time)}</span>
  </div>`).join("");
  const activity = [
    ["架构评审已签收", "improve-architecture 输出 ADR，并交由 Build stage 使用。", "2 min"],
    ["后端 TDD 正在运行", "nestjs-patterns → tdd，12 / 18 个验收断言通过。", "6 min"],
    ["等待一个决策", "SSO 回调域名需要你确认后才能进入 Review。", "11 min"],
  ].map(([title, copy, time]) => `<div class="activity-item"><i class="activity-dot"></i><div><strong>${title}</strong><p>${copy}</p></div><time>${time}</time></div>`).join("");
  const artifacts = DATA.artifacts.map(([type, name, meta]) => `<a class="artifact-link" href="#artifact-${type.toLowerCase()}">${icons.file}<b>${type}</b><span>${name} · ${meta}</span></a>`).join("");
  return `<div class="variant-a">
    <div class="prototype-note">prototype · readonly</div>
    <header class="a-context"><div class="context-item"><span class="brand-mark">T</span><strong>${DATA.project}</strong></div><div class="context-item"><span class="muted">Workflow</span><strong>${DATA.workflow}</strong></div><div class="context-item"><span class="muted">Track</span><strong>${DATA.track}</strong></div><div class="context-item"><span class="muted">Change</span><strong class="mono">${DATA.change}</strong></div><div class="context-item"><span class="status ok">Control plane online</span></div></header>
    <div class="a-layout"><aside class="a-rail"><div class="a-brand"><span class="brand-mark">T</span><span>Tenon control</span></div><nav class="a-nav"><button class="active">${icons.grid}任务指挥台</button><button>${icons.flow}流程与状态</button><button>${icons.box}Skill registry</button><button>${icons.file}产物索引</button></nav><div class="a-rail-foot">所有操作都围绕当前 Change 展开。<br>串并行策略由 workflow 决定。</div></aside>
      <main class="a-main"><div class="a-heading"><div><div class="eyebrow" style="color:var(--accent)">Active change</div><h1>企业 SSO 审计</h1><p>看清现在发生什么，知道下一步需要谁做决定。</p></div><div class="a-heading-side"><span class="tag accent">full-stack</span><button class="a-button">${icons.more} 更多</button></div></div>
        <div class="a-grid"><div class="a-main-col"><section class="a-panel a-next"><div><div class="eyebrow muted">Next best action</div><h2>确认回调域名，解锁 Review</h2><p>Build stage 已完成 67%。系统正在等待你的一个判断，确认后会自动串行执行安全检查与 E2E 验收。</p></div><div class="a-next-actions"><button class="a-button">查看上下文</button><button class="a-button primary">打开决策</button></div><div class="a-next-progress"><span>当前 change · 3 / 7 个任务</span><span class="bar"><i style="width:67%"></i></span><span>67%</span></div></section><section class="a-panel a-stages"><div class="panel-head"><h3>执行序列</h3><span>4 stages · 9 skills · 自动编排</span></div>${rows}</section><section class="a-panel a-activity"><div class="panel-head"><h3>实时活动</h3><span>刚刚同步</span></div>${activity}</section></div>
          <aside class="a-side-col"><section class="a-panel a-signal"><div class="panel-head" style="padding-left:0;padding-right:0"><h3>运行信号</h3><span>live</span></div><div class="signal-block"><div class="signal-label"><span>阶段进度</span><span>+8%</span></div><div class="signal-value">67<small>/ 100</small></div></div><div class="signal-block"><div class="signal-label"><span>质量门</span><span class="status ok">通过</span></div><div class="signal-value">18<small>checks</small></div></div><div class="signal-block"><div class="signal-label"><span>需要你</span><span class="status warn">1 项</span></div><div class="signal-value">决策<small>待确认</small></div></div></section><section class="a-panel a-artifacts"><div class="panel-head" style="padding-left:0;padding-right:0"><h3>关键产物</h3><span>可追溯</span></div>${artifacts}</section></aside>
        </div>
      </main>
    </div>${switcher("a")}</div>`;
}

function variantB() {
  const nodes = DATA.stages.map((stage, index) => `<div class="b-node ${stage.status} ${stage.status === "current" ? "selected" : ""}" data-stage="${stage.id}" tabindex="0"><span class="b-node-marker">${stage.status === "complete" ? icons.check : stage.status === "current" ? icons.spark : String(index + 1).padStart(2, "0")}</span><div class="b-node-card"><div class="b-node-copy"><h3>${esc(stage.name)} · ${esc(stage.zh)}</h3><p>${stage.skills.length} skills · ${stage.status === "current" ? "当前正在执行：" + stage.skills.join(" → ") : statusLabel(stage.status)}</p></div><div class="b-node-meta"><strong>${stage.status === "current" ? "67%" : stage.status === "complete" ? "100%" : "—"}</strong><span>${esc(stage.time)}</span></div></div></div>`).join("");
  return `<div class="variant-b"><div class="prototype-note">prototype · readonly</div><header class="b-topbar"><div class="b-logo"><span class="brand-mark">T</span>Tenon</div><div class="b-breadcrumb"><span>Projects</span>${icons.chev}<strong>${DATA.project}</strong>${icons.chev}<strong>${DATA.change}</strong></div><div class="b-top-actions"><button>${icons.spark} 自动编排</button><button>${icons.more}</button></div></header><div class="b-workspace"><aside class="b-explorer"><div class="eyebrow" style="color:var(--muted)">Workspace</div><h2>工作区</h2><div class="b-project-switch"><span class="brand-mark">T</span><b>${DATA.project}</b><span>⌄</span></div><div class="b-tree"><div class="b-tree-row active"><span class="tree-icon">◈</span>${DATA.change}</div><div class="b-tree-row indent"><span class="tree-icon">◇</span>需求与架构</div><div class="b-tree-row indent"><span class="tree-icon">◇</span>前后端实现</div><div class="b-tree-row indent"><span class="tree-icon">◇</span>质量与安全</div><div class="b-tree-row"><span class="tree-icon">＋</span>新建 Change</div></div></aside><main class="b-canvas"><div class="b-canvas-head"><div><div class="eyebrow" style="color:var(--accent)">Workflow map</div><h1>${DATA.workflow}</h1><p>一张图看懂每个 stage 的依赖、skill 和产出。</p></div><div class="b-zoom"><button aria-label="缩小">−</button><button aria-label="适应">Fit</button><button aria-label="放大">＋</button></div></div><div class="b-flow">${nodes}</div><div class="b-bottom-line">${icons.spark}<span>当前阻塞：确认 SSO 回调域名后，Review 会自动接管。</span></div></main><aside class="b-inspector"><div class="eyebrow">Selected stage</div><h2 id="inspector-title">Build · 前后端实现</h2><div class="b-inspector-card"><h3>执行策略</h3><p>先并行运行后端与前端 skill，汇合后串行进入测试。每个输出都注册到当前 Change 的 artifact ledger。</p></div><div class="b-inspector-card"><h3>Skills <span class="muted">3</span></h3><div class="b-skill-row">${icons.check}<span>nestjs-patterns</span><span>done</span></div><div class="b-skill-row">${icons.spark}<span>react-patterns</span><span>running</span></div><div class="b-skill-row">${icons.flow}<span>tdd</span><span>queued</span></div></div><div class="b-inspector-card"><h3>需要决策</h3><div class="b-decision">SSO callback domain<br><strong>等待产品负责人确认</strong></div></div><div class="b-inspector-card"><h3>最近产出</h3><p class="mono">architecture-decision.md<br>workflow-e2e-report.html</p></div></aside></div>${switcher("b")}</div>`;
}

function variantC() {
  return `<div class="variant-c"><div class="prototype-note">prototype · readonly</div><div class="c-top"><div class="c-brandline"><div class="c-brand"><span class="brand-mark">T</span>Tenon <span style="font-weight:400;color:#96a9c4">/ ${DATA.project}</span></div><div class="c-help">${icons.spark} 需要帮助？</div></div><div class="c-journey"><div class="journey-step done"><i>✓</i><span>描述目标</span></div><div class="journey-step done"><i>✓</i><span>选择工作流</span></div><div class="journey-step current"><i>3</i><span>自动开发</span></div><div class="journey-step"><i>4</i><span>检查质量</span></div><div class="journey-step"><i>5</i><span>发布</span></div></div></div><main class="c-main"><div class="c-intro"><div class="eyebrow">现在进行到哪一步？</div><h1>只差一个决定，继续开发</h1><p>Tenon 正在帮你完成「${DATA.change}」。你不需要理解每个 skill，只需要在关键节点做选择。</p></div><section class="c-card"><div class="c-card-main"><div class="c-card-copy"><div class="eyebrow" style="color:#687bff">Step 03 · 自动开发</div><h2>确认 SSO 回调域名</h2><p>Build stage 已经并行完成后端与前端实现。确认域名后，Tenon 会自动调用 security-audit、e2e-testing 并生成验收报告。</p><button class="c-cta" id="guided-cta">查看这个决定 ${icons.arrow}</button></div><div class="c-ring"><div class="c-ring-inner"><strong>67%</strong><span>完成度</span></div></div></div><div class="c-card-foot"><span class="status warn">需要你</span><span>预计还需 <strong>18 分钟</strong> · 3 个 skill · 2 份产物</span></div></section><div class="c-details"><div class="c-detail"><h3>已自动完成</h3><p>产品简报、架构 ADR、数据库迁移检查</p></div><div class="c-detail"><h3>正在处理</h3><p>nestjs-patterns → react-patterns → tdd</p></div><div class="c-detail"><h3>接下来</h3><p>安全审计、E2E 验收、部署预检</p></div></div><div class="c-artifacts"><span class="tag">PRD · 已签收</span><span class="tag">ADR · 刚刚</span><span class="tag">E2E report · 草稿</span></div></main>${switcher("c")}</div>`;
}

function selectedVariant() {
  const raw = new URLSearchParams(location.search).get("variant");
  return ["a", "b", "c"].includes(raw) ? raw : "a";
}

function render(key) {
  document.body.dataset.variant = key;
  document.getElementById("app").innerHTML = key === "a" ? variantA() : key === "b" ? variantB() : variantC();
  bindInteractions(key);
}

function goTo(key) {
  history.replaceState({}, "", `?variant=${key}`);
  render(key);
}

function bindInteractions(key) {
  document.querySelectorAll("[data-switch]").forEach((button) => button.addEventListener("click", () => {
    const order = ["a", "b", "c"]; const current = order.indexOf(key); const step = button.dataset.switch === "next" ? 1 : -1;
    goTo(order[(current + step + order.length) % order.length]);
  }));
  document.querySelectorAll("[data-stage]").forEach((node) => node.addEventListener("click", () => {
    document.querySelectorAll("[data-stage]").forEach((item) => item.classList.toggle("selected", item === node));
    const stage = DATA.stages.find((item) => item.id === node.dataset.stage);
    const title = document.getElementById("inspector-title");
    if (title && stage) title.textContent = `${stage.name} · ${stage.zh}`;
  }));
  const cta = document.getElementById("guided-cta");
  if (cta) cta.addEventListener("click", () => { cta.innerHTML = `已展开决定上下文 ${icons.check}`; cta.setAttribute("aria-pressed", "true"); });
}

document.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag) || event.target?.isContentEditable) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const order = ["a", "b", "c"]; const current = order.indexOf(selectedVariant()); const step = event.key === "ArrowRight" ? 1 : -1;
    goTo(order[(current + step + order.length) % order.length]);
  }
});

render(selectedVariant());
