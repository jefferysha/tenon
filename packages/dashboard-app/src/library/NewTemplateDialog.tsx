import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useT } from '../i18n'
import { TEMPLATE_CATEGORIES, type TemplateCategory } from '../api/instructionsDecoders'
import { Dialog } from '../shared/Dialog'
import { BUTTON_GHOST, BUTTON_SOLID, FIELD_LABEL, INPUT, SELECT } from '../shared/uiRecipes'

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 新建自定义模板：选分类 + 填标识；正文由调用方给出起始骨架。 */
export function NewTemplateDialog({
  busy, onClose, onCreate,
}: {
  busy: boolean
  onClose: () => void
  onCreate: (category: TemplateCategory, id: string) => void
}): JSX.Element {
  const { t } = useT()
  const [category, setCategory] = useState<TemplateCategory>('common')
  const [id, setId] = useState('')
  const valid = ID.test(id)

  return (
    <Dialog
      title={t('library.new')}
      onClose={onClose}
      testid="lib-tpl-new-dialog"
      actions={(
        <>
          <button type="button" className={BUTTON_GHOST} data-testid="lib-tpl-new-cancel" onClick={onClose}>
            {t('library.cancel')}
          </button>
          <button
            type="button"
            className={BUTTON_SOLID}
            data-testid="lib-tpl-new-confirm"
            disabled={!valid || busy}
            onClick={() => onCreate(category, id)}
          >
            {t('library.confirm')}
          </button>
        </>
      )}
    >
      <div className="grid gap-4">
        <label className={FIELD_LABEL}>
          {t('library.category')}
          {/* SELECT 是 appearance-none：原生箭头被去掉了，这里补一个，否则看起来像文本框。 */}
          <span className="relative block">
            <select
              className={SELECT}
              value={category}
              data-testid="lib-tpl-new-category"
              onChange={(event) => setCategory(TEMPLATE_CATEGORIES.find((value) => value === event.target.value) ?? 'common')}
            >
              {TEMPLATE_CATEGORIES.map((value) => (
                <option key={value} value={value}>{t(`library.categories.${value}`)}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-3" aria-hidden="true" data-testid="lib-tpl-new-category-arrow" />
          </span>
        </label>
        <label className={FIELD_LABEL}>
          {t('library.id')}
          <input
            className={INPUT}
            value={id}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={id !== '' && !valid}
            data-testid="lib-tpl-new-id"
            onChange={(event) => setId(event.target.value)}
          />
        </label>
      </div>
    </Dialog>
  )
}
