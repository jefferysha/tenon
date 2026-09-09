// 原型交互：仅切换四页与更新面包屑，其余为静态视觉稿。
const CRUMB = {
  workspace: '工作台',
  workflow: '工作流',
  automation: '自动化',
  machines: '机器',
}

const tabs = document.querySelectorAll('.tab')
const crumb = document.querySelector('[data-crumb]')

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const page = tab.dataset.page
    tabs.forEach((t) => t.classList.toggle('is-on', t === tab))
    document.querySelectorAll('.page').forEach((p) => {
      p.classList.toggle('is-on', p.id === `page-${page}`)
    })
    crumb.textContent = CRUMB[page]
  })
})

// `/` 聚焦全局搜索，Esc 退出——与 design.md 的交互约定一致。
document.addEventListener('keydown', (event) => {
  const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')
  if (event.key === '/' && !editing) {
    event.preventDefault()
    document.getElementById('globalSearch').focus()
  }
  if (event.key === 'Escape' && editing) document.activeElement.blur()
})

// 工作流页：点左列「工作流」显示阶段编辑面板，点「轨道」显示轨道与管线面板。
document.querySelectorAll('[data-wf-select]').forEach((card) => {
  card.addEventListener('click', () => {
    const which = card.dataset.wfSelect
    document.querySelectorAll('#page-workflow [data-wf-select]').forEach((c) => c.classList.toggle('is-on', c === card))
    document.querySelectorAll('#page-workflow [data-wf-panel]').forEach((p) => { p.hidden = p.dataset.wfPanel !== which })
  })
})
