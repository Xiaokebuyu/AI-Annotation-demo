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
import { getMeeting, addMeetingMaterialDocIds } from '../../local/store';
import { importPdfFromUrl } from '../../surface/renderer';
import { apiUrl } from '../../core/api';
import type { PersistedMeeting } from '../../core/store-format';
import type { FeishuDocxLinkItem } from './feishu-doc-links';

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

/**
 * 资料文档稳定 id——用 resource_key 而非 message_id（B7-bug6）：同一文件被转发/机器人重贴一次，
 * message_id 会变但 resource_key（飞书资源本体标识）不变；用 message_id 当键会让同一文件重复转换、重复入库。
 */
export const materialDocId = (meetingId: string, resourceKey: string): string => `mtgdoc_${meetingId}_${resourceKey}`;

const HOUR = 3600_000;
// B7-bug3：会议没有 ended_at 时不能用 Date.now() 当捕获窗口上界——那样窗口永远跟着"现在"往后延，
// 一场忘了发 ended 事件的会议会无限期抓后续所有无关群文件。给个兜底会议时长上限：以 started_at（无则 scheduled_at）
// 为锚点 + 4h，超过这个还没收到 ended，就当作数据异常，不再当作"仍在捕获窗口"。
const MAX_OPEN_CAPTURE_SPAN_MS = 4 * HOUR;
// B7-bug7：群文件分页安全上限（6 页 × 50 = 300 条），防止巨量刷屏文件的群把自动扫描拖成无限翻页。
const FILE_PAGE_SIZE = 50;
const MAX_FILE_PAGES = 6;

/** 会议的资料捕获窗口 [start, end]（epoch ms）。scheduled_at 非法（如日历同步异常数据）返回 null。 */
export function captureWindow(meeting: Pick<PersistedMeeting, 'scheduled_at' | 'started_at' | 'ended_at'>): { start: number; end: number } | null {
  const start = new Date(meeting.scheduled_at).getTime();
  if (!Number.isFinite(start)) return null;
  if (meeting.ended_at) {
    const end = new Date(meeting.ended_at).getTime();
    return { start: start - HOUR, end: end + HOUR };
  }
  const anchor = meeting.started_at ? new Date(meeting.started_at).getTime() : start;
  return { start: start - HOUR, end: anchor + MAX_OPEN_CAPTURE_SPAN_MS };
}

/** 会议当前是否在资料捕获窗口内（开始前 1h ~ 结束后 1h；未结束时以硬上限兜底，见 captureWindow）。 */
export function inCaptureWindow(meeting: Pick<PersistedMeeting, 'scheduled_at' | 'started_at' | 'ended_at'>, now = Date.now()): boolean {
  const w = captureWindow(meeting);
  return !!w && now >= w.start && now <= w.end;
}

/**
 * 能转成可标注 PDF 的源 URL：PDF 直接拉·HTML/图片经 convert；其它（docx/压缩包）返回 null = 先跳过。
 *
 * P0 安全止血后 feishu base 分两份（两条服务之前零鉴权、设备前端直连裸端口，见项目记忆盲区扫描发现）：
 *   feishuProxyBase   —— 设备浏览器直接 fetch 用（同源代理，secret 服务端注入，PDF 直拉分支走它）
 *   feishuAbsoluteBase —— 喂给 convert-service 当抓取源用（真绝对地址，convert-service 自己服务端 fetch 时代填 secret）
 * convertBase 同理是浏览器直连的同源代理地址。
 */
export function pdfSourceUrl(f: FeishuFileItem, feishuProxyBase: string, feishuAbsoluteBase: string, convertBase: string): string | null {
  const name = f.file_name || '';
  const proxied = `${feishuProxyBase}${f.download_path}`;
  const absolute = `${feishuAbsoluteBase}${f.download_path}`;
  if (f.resource_type === 'image') return `${convertBase}/to-pdf?url=${encodeURIComponent(absolute)}&name=${encodeURIComponent(name || 'image')}`; // 图片→单页 PDF（convert 靠 content-type 判）
  if (/\.pdf$/i.test(name)) return proxied;                                                                       // PDF：设备浏览器直接拉字节
  if (/\.html?$/i.test(name)) return `${convertBase}/to-pdf?url=${encodeURIComponent(absolute)}&name=${encodeURIComponent(name)}`;
  return null; // docx/pptx/压缩包等：先跳过（段B 接 LibreOffice 后再开）
}

export interface ListFilesPage { files: FeishuFileItem[]; pageToken?: string; hasMore: boolean; }

/** 拉一个群的文件列表某一页（不入库·供「添加资料 · 飞书群文件」让用户挑选/自动扫描分页用）。失败抛（调用方提示）。 */
export async function listMeetingGroupMaterialFiles(opts: { chatId: string; feishuBase: string; limit?: number; pageToken?: string }): Promise<ListFilesPage> {
  const qs = new URLSearchParams({ limit: String(opts.limit ?? FILE_PAGE_SIZE) });
  if (opts.pageToken) qs.set('page_token', opts.pageToken);
  // codex 扫描出的真 bug：裸 fetch 在安卓静态包下不会走 VITE_API_BASE_URL，必须过 apiUrl()。
  const r = await fetch(apiUrl(`${opts.feishuBase}/api/feishu/workspaces/${encodeURIComponent(opts.chatId)}/files?${qs}`));
  if (!r.ok) throw new Error(`拉取群文件失败：HTTP ${r.status}`);
  const body = (await r.json()) as { files?: FeishuFileItem[]; page_token?: string; has_more?: boolean };
  return { files: body.files || [], pageToken: body.page_token, hasMore: !!body.has_more };
}

/** 拉一个群文本消息里的妙记 docx 链接候选（不入库·供「添加资料 · 飞书群文件」手动挑选用，MVP 不自动扫描）。失败抛（调用方提示）。 */
export async function listMeetingGroupDocxLinks(opts: { chatId: string; feishuBase: string; limit?: number }): Promise<FeishuDocxLinkItem[]> {
  const qs = new URLSearchParams({ limit: String(opts.limit ?? FILE_PAGE_SIZE) });
  const r = await fetch(apiUrl(`${opts.feishuBase}/api/feishu/workspaces/${encodeURIComponent(opts.chatId)}/docx-links?${qs}`));
  if (!r.ok) throw new Error(`拉取妙记文档链接失败：HTTP ${r.status}`);
  const body = (await r.json()) as { links?: FeishuDocxLinkItem[] };
  return body.links || [];
}

/** 每 meetingId 同一时间只允许一轮扫描在跑（B7-bug8）：poll 12s 一拍撞上 detail 入口重渲触发的扫描，
 *  重叠调用直接复用同一个 in-flight Promise，不重复拉取/转换。 */
const inFlightScans = new Map<string, Promise<SyncMaterialsResult>>();

/**
 * 扫一个会议关联群的文件，自动转 PDF 入库 + 并入 material_doc_ids（幂等·去重·静默后台）。
 * 失败/不支持的文件不阻断其它，计数返回供调用方决定要不要重渲。
 */
export function syncMeetingGroupMaterials(opts: {
  meetingId: string; chatId: string; feishuBase: string; feishuAbsoluteBase: string; convertBase: string; limit?: number;
}): Promise<SyncMaterialsResult> {
  const existing = inFlightScans.get(opts.meetingId);
  if (existing) return existing;
  const p = syncMeetingGroupMaterialsInner(opts).finally(() => {
    if (inFlightScans.get(opts.meetingId) === p) inFlightScans.delete(opts.meetingId);
  });
  inFlightScans.set(opts.meetingId, p);
  return p;
}

async function syncMeetingGroupMaterialsInner(opts: {
  meetingId: string; chatId: string; feishuBase: string; feishuAbsoluteBase: string; convertBase: string; limit?: number;
}): Promise<SyncMaterialsResult> {
  const out: SyncMaterialsResult = { imported: 0, cached: 0, skipped: 0, failed: 0, changed: false };
  const meeting = await getMeeting(opts.meetingId);
  if (!meeting || !opts.chatId) return out;
  const win = captureWindow(meeting);
  if (!win) return out; // scheduled_at 非法：没法判窗口，别乱抓

  // 分页拉取，直到：翻完 / 遇到早于窗口起点的文件（sort_type=ByCreateTimeDesc，之后只会更早，可提前停）/ 达安全页数上限。
  const files: FeishuFileItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_FILE_PAGES; page++) {
    let res: ListFilesPage;
    try { res = await listMeetingGroupMaterialFiles({ chatId: opts.chatId, feishuBase: opts.feishuBase, limit: opts.limit ?? FILE_PAGE_SIZE, pageToken }); }
    catch { return out; } // feishu-service 不在 → 静默退回（首页失败才整体放弃；已拉到的页不因此丢弃）
    files.push(...res.files);
    const oldestOnPage = res.files.length ? Number(res.files[res.files.length - 1].create_time) || 0 : 0;
    if (!res.hasMore || !res.pageToken) break;
    if (oldestOnPage && oldestOnPage < win.start) break; // 已翻到窗口之前，更早的页全部在窗口外，不用再翻
    pageToken = res.pageToken;
  }

  // 捕获窗口过滤：create_time 缺失/非法（B7-bug5）不再默认保留——没有时刻没法判断是否在会议前后，直接跳过等用户手动加。
  const inWindow = files.filter((f) => {
    const t = Number(f.create_time) || 0;
    return t > 0 && t >= win.start && t <= win.end;
  });

  const existingIds = new Set(meeting.material_doc_ids || []);
  const newIds: string[] = [];
  for (const f of inWindow) {
    const src = pdfSourceUrl(f, opts.feishuBase, opts.feishuAbsoluteBase, opts.convertBase);
    if (!src) { out.skipped++; continue; }
    const docId = materialDocId(opts.meetingId, f.resource_key);
    if (existingIds.has(docId)) { out.cached++; continue; } // 已并入过 material_doc_ids：免重复 importPdfFromUrl 往返
    try {
      const res = await importPdfFromUrl(docId, f.file_name || '群文件', src);
      res === 'imported' ? out.imported++ : out.cached++;
      newIds.push(docId); // storePdfBlob 落库失败会在这里被 catch 接住，不会走到这行——不会把半成品 docId 并入
    } catch { out.failed++; } // 单文件转换失败（convert 不在/415/超限/落库失败）不阻断其它
  }
  if (newIds.length) {
    // B7-bug1：原子并入而非整体覆盖 material_doc_ids，防止和手动添加资料并发时互相用旧快照覆盖对方刚写入的 docId。
    await addMeetingMaterialDocIds(opts.meetingId, newIds);
    out.changed = true;
  }
  return out;
}
