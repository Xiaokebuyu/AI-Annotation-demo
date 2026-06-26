/** HTML 文本转义（插入 innerHTML 前用）。纯函数、无 DOM/平台依赖 → 放 core，导航壳与各 feature 共用。 */
export const esc = (s: string): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
