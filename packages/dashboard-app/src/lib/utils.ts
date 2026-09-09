import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * 字号刻度是项目自定义命名（index.css 的 `@theme static`），不在 tailwind-merge 内置的
 * xs/sm/base/lg… 词表里。不登记的话 tailwind-merge 会把 `text-caption` 之类当成**文字颜色**，
 * 于是 `cn('text-caption', 'text-base')` 两条都留下来，最终由生成 CSS 的**字母序**（base、body、
 * caption、micro、page…）决定谁生效——覆写方向随档位名首字母乱掉。登记进 font-size 组后，
 * 冲突重新按「后者胜」收敛。圆角刻度沿用 xs/sm/md/lg 内置名，无需登记。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'caption', 'body', 'base', 'title', 'section', 'page'] }],
    },
  },
})

/** shadcn 惯例：clsx 组合条件类名 + tailwind-merge 去冲突（后者胜）。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
