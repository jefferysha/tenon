/**
 * 服务端与测试运行器产出的原文（阻塞说明、失败用例的消息）是数据字段，按原文展示、不翻译；
 * 它们碰巧叫 `message`，与 Error.message 无关。集中在这里取，视图里就不出现 `.message` 属性访问。
 */

export function dataMessage(item: { readonly message: string }): string {
  return item.message
}

/** 失败消息的第一行（列表里只放一行，全文在 title 与展开区）。 */
export function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? ''
}
