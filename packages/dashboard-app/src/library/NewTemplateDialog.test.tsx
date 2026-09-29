import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NewTemplateDialog, type NewTemplateDialogProps } from './NewTemplateDialog'

function renderDialog(over: Partial<NewTemplateDialogProps> = {}) {
  const props: NewTemplateDialogProps = {
    busy: false, taken: new Set(['backend/mine']), errorKey: null, onClose: vi.fn(), onCreate: vi.fn(), ...over,
  }
  const view = render(<I18nProvider><TooltipProvider><NewTemplateDialog {...props} /></TooltipProvider></I18nProvider>)
  return { props, view }
}

describe('新建模板对话框：字段', () => {
  it('名称 · 标识 · 分类 · 适用框架 · 正文；打开即聚焦名称；正文预填分类标题；固定高度', () => {
    renderDialog()
    expect(screen.getByTestId('lib-tpl-new-name')).toHaveFocus()
    expect(screen.getByTestId('lib-tpl-new-id')).toHaveValue('')
    expect(screen.getByTestId('lib-tpl-new-category')).toHaveValue('common')
    expect(screen.getByTestId('lib-tpl-new-frameworks')).toBeDisabled()
    expect(screen.getByTestId('lib-tpl-new-editor')).toHaveValue('## 通用\n\n- \n')
    expect(screen.getByTestId('lib-tpl-new-dialog-body').className).toContain('h-[560px]')
    expect(screen.getByTestId('lib-tpl-new-dialog-submit')).toBeDisabled()
  })

  it('标识随名称生成（ASCII），手改之后不再跟随；全中文名称时标识留空由用户填', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId('lib-tpl-new-name'), 'Team API')
    expect(screen.getByTestId('lib-tpl-new-id')).toHaveValue('team-api')
    await user.clear(screen.getByTestId('lib-tpl-new-id'))
    await user.type(screen.getByTestId('lib-tpl-new-id'), 'api-v2')
    await user.type(screen.getByTestId('lib-tpl-new-name'), ' 2')
    expect(screen.getByTestId('lib-tpl-new-id')).toHaveValue('api-v2')
  })

  it('换分类：骨架标题跟着换（状态管理为 ###），框架多选可用；换回非前端类分类清空框架', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.selectOptions(screen.getByTestId('lib-tpl-new-category'), 'state')
    expect(screen.getByTestId('lib-tpl-new-editor')).toHaveValue('### 状态管理\n\n- \n')
    expect(screen.getByTestId('lib-tpl-new-frameworks')).toBeEnabled()
    await user.click(screen.getByTestId('lib-tpl-new-frameworks'))
    const menu = await screen.findByTestId('lib-tpl-new-frameworks-menu')
    expect(within(menu).getAllByRole('menuitemcheckbox').map((item) => item.textContent))
      .toEqual(['web', 'react', 'next', 'vue', 'nuxt', 'angular', 'svelte', 'react-native', 'flutter', 'swiftui', 'compose'])
    await user.click(within(menu).getByTestId('lib-tpl-new-framework-vue'))
    await user.click(within(menu).getByTestId('lib-tpl-new-framework-react'))
    await user.keyboard('{Escape}')
    // 选中顺序按选项表，不按点击顺序。
    expect(screen.getByTestId('lib-tpl-new-frameworks')).toHaveTextContent('react, vue')
    await user.selectOptions(screen.getByTestId('lib-tpl-new-category'), 'backend')
    expect(screen.getByTestId('lib-tpl-new-frameworks')).toHaveTextContent('—')
    expect(screen.getByTestId('lib-tpl-new-editor')).toHaveValue('## 后端\n\n- \n')
  })
})

describe('新建模板对话框：校验', () => {
  it('必填错误等字段动过才显示；格式与重名错误立即显示在字段下方', async () => {
    const user = userEvent.setup()
    renderDialog()
    expect(screen.queryByTestId('lib-tpl-new-title-field-error')).toBeNull()
    await user.type(screen.getByTestId('lib-tpl-new-name'), 'x')
    await user.clear(screen.getByTestId('lib-tpl-new-name'))
    expect(screen.getByTestId('lib-tpl-new-title-field-error')).toHaveTextContent('必填')
    await user.type(screen.getByTestId('lib-tpl-new-id'), 'Bad_Id')
    expect(screen.getByTestId('lib-tpl-new-id-field-error')).toHaveTextContent('只能用小写字母、数字与 -')
    expect(screen.getByTestId('lib-tpl-new-id')).toHaveAttribute('aria-describedby', 'lib-tpl-new-id-input-error')
    await user.selectOptions(screen.getByTestId('lib-tpl-new-category'), 'backend')
    await user.clear(screen.getByTestId('lib-tpl-new-id'))
    await user.type(screen.getByTestId('lib-tpl-new-id'), 'mine')
    expect(screen.getByTestId('lib-tpl-new-id-field-error')).toHaveTextContent('该分类下已有同名标识')
  })

  it('状态管理未选框架、正文首行不是标题、未知占位符：各自在字段下方报错，不能提交', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId('lib-tpl-new-name'), 'Signals')
    await user.selectOptions(screen.getByTestId('lib-tpl-new-category'), 'state')
    expect(screen.getByTestId('lib-tpl-new-frameworks-field-error')).toHaveTextContent('状态管理与样式模板必须选框架')
    const editor = screen.getByTestId('lib-tpl-new-editor')
    await user.clear(editor)
    await user.type(editor, '规则')
    expect(screen.getByTestId('lib-tpl-new-body-field-error')).toHaveTextContent('第一行须是 ### 标题')
    await user.clear(editor)
    await user.type(editor, '### 状态{{{{catalog.icons}}')
    expect(screen.getByTestId('lib-tpl-new-body-field-error')).toHaveTextContent('无法解析的占位符 {{catalog.icons}}')
    expect(screen.getByTestId('lib-tpl-new-dialog-submit')).toBeDisabled()
  })
})

describe('新建模板对话框：正文与占位符说明', () => {
  it('编辑 / 渲染切换：渲染时占位符显示成淡色标记；占位符说明在 Tooltip 里', async () => {
    const user = userEvent.setup()
    renderDialog()
    const editor = screen.getByTestId('lib-tpl-new-editor')
    await user.clear(editor)
    await user.type(editor, '## 通用{{{{project.name}}')
    await user.click(screen.getByTestId('lib-tpl-new-body-tab-render'))
    expect(screen.queryByTestId('lib-tpl-new-editor')).toBeNull()
    const preview = screen.getByTestId('lib-tpl-new-preview')
    expect(preview.querySelector('[data-placeholder="project.name"]')).not.toBeNull()
    expect(screen.getByTestId('lib-tpl-new-body-tab-render')).toHaveAttribute('aria-selected', 'true')
    await user.hover(screen.getByRole('button', { name: '正文 说明' }))
    const list = (await screen.findAllByTestId('lib-tpl-placeholders'))[0]
    expect(list).toHaveTextContent('{{project.name}}项目名')
    expect(list).toHaveTextContent('{{directories}}骨架目录表')
    expect(list).toHaveTextContent('\\{{字面量 {{')
    await user.click(screen.getByTestId('lib-tpl-new-body-tab-edit'))
    expect(screen.getByTestId('lib-tpl-new-editor')).toHaveValue('## 通用{{project.name}}')
  })
})

describe('新建模板对话框：提交与关闭', () => {
  it('Enter 提交：onCreate 收到分类、标识与完整模板文本（含适用框架）', async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()
    await user.selectOptions(screen.getByTestId('lib-tpl-new-category'), 'frontend')
    await user.click(screen.getByTestId('lib-tpl-new-frameworks'))
    await user.click(await screen.findByTestId('lib-tpl-new-framework-svelte'))
    await user.keyboard('{Escape}')
    await user.type(screen.getByTestId('lib-tpl-new-name'), 'Svelte Kit{Enter}')
    expect(props.onCreate).toHaveBeenCalledTimes(1)
    expect(props.onCreate).toHaveBeenCalledWith('frontend', 'svelte-kit', '---\nid: svelte-kit\ncategory: frontend\ntitle: Svelte Kit\nframeworks: [svelte]\n---\n## 前端\n\n- \n')
  })

  it('提交后服务端报错：错误码的本地文案显示在按钮旁', async () => {
    const user = userEvent.setup()
    const { props, view } = renderDialog()
    await user.type(screen.getByTestId('lib-tpl-new-name'), 'dup{Enter}')
    view.rerender(<I18nProvider><TooltipProvider><NewTemplateDialog {...props} errorKey="template_exists" /></TooltipProvider></I18nProvider>)
    expect(screen.getByTestId('lib-tpl-new-error')).toHaveTextContent('同名模板已存在')
  })

  it('未改动 Esc 直接关闭；有输入时先确认', async () => {
    const user = userEvent.setup()
    const first = renderDialog()
    await user.keyboard('{Escape}')
    expect(first.props.onClose).toHaveBeenCalledTimes(1)
    first.view.unmount()
    const second = renderDialog()
    await user.type(screen.getByTestId('lib-tpl-new-name'), 'x')
    await user.keyboard('{Escape}')
    expect(await screen.findByTestId('lib-tpl-new-dialog-discard')).toBeInTheDocument()
    expect(second.props.onClose).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('lib-tpl-new-dialog-discard-confirm'))
    expect(second.props.onClose).toHaveBeenCalledTimes(1)
  })
})
