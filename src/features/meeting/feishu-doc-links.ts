/**
 * 妙记文档（飞书云文档 docx 导出形态，形如 `.../docx/<token>`）识别 + 稳定 id。
 *
 * 区别于 `feishu_minute_token`（`/minutes/<token>` 妙记卡片链接，走现成的严格自动绑定）：
 * 群里更常见的分享方式是把妙记生成的文档链接直接贴在文本消息里（不是上传文件、不是转发卡片）。
 * 这条链路走「链接型资料」（PersistedMeetingMaterialLink），不强求满足 `/minutes/<token>` 格式。
 */

/** 一条从群消息文本里识别出的妙记 docx 链接。 */
export interface FeishuDocxLinkItem {
  message_id: string;
  create_time?: string; // 群消息时刻（epoch ms 字符串·和 FeishuFileItem 同款捕获窗口过滤用）
  url: string;           // 完整原链接
  token: string;         // /docx/<token> 的 token
}

// 匹配 https://xxx.feishu.cn/docx/<token>（token 通常是 20+ 位字母数字混合，不严格锁死长度，留余量）。
// 排除紧跟的中英文标点/引号/括号，避免把句末标点吃进 token；不捕获 query/hash（一律丢弃，文档 id 只在 path 段）。
const DOCX_RE = /https?:\/\/[^\s"'<>（）()]+\/docx\/([A-Za-z0-9_-]{8,40})(?:[?#][^\s"'<>（）()]*)?/g;

/** 从一段消息文本里抽取全部妙记 docx 链接（去重·同一条消息里出现两次同链接只算一条）。 */
export function extractFeishuDocxLinks(text: string): Array<{ url: string; token: string }> {
  if (!text) return [];
  const seen = new Set<string>();
  const out: Array<{ url: string; token: string }> = [];
  for (const m of text.matchAll(DOCX_RE)) {
    const token = m[1];
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ url: m[0], token });
  }
  return out;
}

/** 会议+token 稳定 id——同一篇文档被多次转发/多条消息重复分享，token 不变，不会重复挂资料。 */
export const materialLinkId = (meetingId: string, token: string): string => `mtglink_${meetingId}_${token}`;

/** 用户手动「导出 PDF」成功后，这篇文档对应 material_doc_ids 里的 document_id（和普通群文件资料共用同一套书架/阅读器）。 */
export const materialDocxPdfDocId = (meetingId: string, token: string): string => `mtgdoc_${meetingId}_docx_${token}`;
