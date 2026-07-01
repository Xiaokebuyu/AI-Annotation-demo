/**
 * 群文件自动抓取 → 转 PDF → 入资料书架（会前 L3 资料自动化）。
 *
 * 链路：feishu-service `/workspaces/:chatId/files`（群里的文件消息）→ 对每个 PDF/HTML：
 *   PDF 直接拉字节；HTML 经 convert-service 转 PDF → `storePdfBlob` 落 pdf_blobs（稳定 id 去重）
 *   → 加进会议 `material_doc_ids`。点开时走现有 `reopenBook`/`openPdfFromUrl`（那时才建 PersistedDoc + 算页数）。
 *
 * 只「存字节」不打开阅读器（后台静默）——故复用 store 的 loadPdfBlob/storePdfBlob，不碰 loadIntoState/渲染。
 * 图片/docx/压缩包先跳过（convert 段B 接 LibreOffice/图片后再开）。
 */
import { getMeeting, updateMeeting } from '../../local/store';
import { importPdfFromUrl } from '../../surface/renderer';

export interface FeishuFileItem {
  message_id: string;
  msg_type: string;
  file_name: string;
  resource_type: 'file' | 'image';
  resource_key: string;
  download_path: string; // 形如 /api/feishu/messages/:id/file/:key?type=file&name=...
  create_time?: string;  // 群文件消息时刻（epoch ms 字符串·捕获窗口过滤用·feishu-service listChatFiles 返回）
}

export interface SyncMaterialsResult { imported: number; cached: number; skipped: number; failed: number; changed: boolean; }

/** 资料文档稳定 id（同文件不重复转/入）——与现有会中侧栏一致。 */
export const materialDocId = (meetingId: string, messageId: string): string => `mtgdoc_${meetingId}_${messageId}`;

/** 能转成可标注 PDF 的源 URL：PDF 直接拉·HTML 经 convert；其它（图片/docx/压缩包）返回 null = 先跳过。 */
export function pdfSourceUrl(f: FeishuFileItem, feishuBase: string, convertBase: string): string | null {
  const name = f.file_name || '';
  const raw = `${feishuBase}${f.download_path}`;
  if (f.resource_type === 'image') return `${convertBase}/convert/to-pdf?url=${encodeURIComponent(raw)}&name=${encodeURIComponent(name || 'image')}`; // 图片→单页 PDF（convert 靠 content-type 判）
  if (/\.pdf$/i.test(name)) return raw;                                                                       // PDF：直接拉字节
  if (/\.html?$/i.test(name)) return `${convertBase}/convert/to-pdf?url=${encodeURIComponent(raw)}&name=${encodeURIComponent(name)}`;
  return null; // docx/pptx/压缩包等：先跳过（段B 接 LibreOffice 后再开）
}

/** 拉一个群的文件列表（不入库·供「添加资料 · 飞书群文件」让用户挑选·M3）。失败抛（调用方提示）。 */
export async function listMeetingGroupMaterialFiles(opts: { chatId: string; feishuBase: string; limit?: number }): Promise<FeishuFileItem[]> {
  const r = await fetch(`${opts.feishuBase}/api/feishu/workspaces/${encodeURIComponent(opts.chatId)}/files?limit=${opts.limit ?? 50}`);
  if (!r.ok) throw new Error(`拉取群文件失败：HTTP ${r.status}`);
  return ((await r.json()) as { files?: FeishuFileItem[] }).files || [];
}

/**
 * 扫一个会议关联群的文件，自动转 PDF 入库 + 并入 material_doc_ids（幂等·去重·静默后台）。
 * 失败/不支持的文件不阻断其它，计数返回供调用方决定要不要重渲。
 */
export async function syncMeetingGroupMaterials(opts: {
  meetingId: string; chatId: string; feishuBase: string; convertBase: string; limit?: number;
}): Promise<SyncMaterialsResult> {
  const out: SyncMaterialsResult = { imported: 0, cached: 0, skipped: 0, failed: 0, changed: false };
  const meeting = await getMeeting(opts.meetingId);
  if (!meeting || !opts.chatId) return out;

  let files: FeishuFileItem[] = [];
  try { files = await listMeetingGroupMaterialFiles({ chatId: opts.chatId, feishuBase: opts.feishuBase, limit: opts.limit ?? 50 }); }
  catch { return out; } // feishu-service 不在 → 静默退回

  // 捕获窗口：只抓「会议开始前 1h ~ 结束后 1h」内的群文件（用 create_time·缺时刻则保留不误删）。
  const HOUR = 3600_000;
  const winStart = new Date(meeting.scheduled_at).getTime() - HOUR;
  const winEnd = (meeting.ended_at ? new Date(meeting.ended_at).getTime() : Date.now()) + HOUR;
  files = files.filter((f) => { const t = Number(f.create_time) || 0; return !t || (t >= winStart && t <= winEnd); });

  const docIds = new Set(meeting.material_doc_ids || []);
  for (const f of files) {
    const src = pdfSourceUrl(f, opts.feishuBase, opts.convertBase);
    if (!src) { out.skipped++; continue; }
    const docId = materialDocId(opts.meetingId, f.message_id);
    try {
      const res = await importPdfFromUrl(docId, f.file_name || '群文件', src);
      res === 'imported' ? out.imported++ : out.cached++;
      if (!docIds.has(docId)) { docIds.add(docId); out.changed = true; }
    } catch { out.failed++; } // 单文件转换失败（convert 不在/415/超限）不阻断其它
  }
  if (out.changed) await updateMeeting(opts.meetingId, { material_doc_ids: [...docIds] });
  return out;
}
