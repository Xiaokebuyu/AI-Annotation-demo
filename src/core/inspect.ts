/**
 * 上下文监控：把每次推理「喂了什么上下文 + 模型回了什么」攒成一个环形日志，
 * 供开发面板的「上下文监控」面板展示运行状况。纯记录，不参与主链路。
 */
import { bus, settings, state } from '../app/state';

export interface InferenceInspect {
  ts: string;
  pageIndex: number;
  gesture: string;          // 触发的手势/符号
  intent: string;           // 用户意图（为什么写）——手写经 VLM 判定
  modes: string[];          // output_modes
  nearby: string;           // 圈住/附近的结构化上下文
  ocrTexts: string[];       // 命中的 OCR 文本块
  memoryPages: number;      // 附带的前页记忆数
  hasImage: boolean;        // 是否带了截图底图
  composite?: string;       // 实际送给模型的合成图(墨迹叠原文)dataURL —— 用于核对"模型看到了什么"
  images?: Array<{ role: string; data: string }>; // 实际送给模型的全部图(笔迹/原文/合成)，逐张核对
  bbox?: number[];          // 合成图裁剪的归一化 bbox [x,y,w,h]
  debug: Record<string, unknown> | null; // 服务端 _debug：真实 system + task + 用到的记忆
  resultType: string;
  content: string;
  confidence: number;
  recalled: number[];       // Tier2 回看了哪些页
  model: string;
}

const log: InferenceInspect[] = [];
const MAX = 20;

/**
 * dev-only：把这条 inspect 镜像到服务端调试通道（/api/__debug/event）。
 * 去掉 base64（只留图的角色+字节数），附当前设置/页码快照——便于"开发者侧"离线定位问题。
 * fire-and-forget，失败不影响 UI；生产构建（import.meta.env.DEV=false）直接跳过。
 */
function mirrorToDebug(rec: InferenceInspect): void {
  if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return;
  try {
    const slim = {
      kind: 'inference',
      ts: rec.ts,
      gesture: rec.gesture,
      intent: rec.intent,
      modes: rec.modes,
      focus: rec.nearby,
      hasImage: rec.hasImage,
      images: (rec.images ?? []).map((im) => ({ role: im.role, bytes: im.data?.length ?? 0 })),
      resultType: rec.resultType,
      content: rec.content,
      confidence: rec.confidence,
      recalled: rec.recalled,
      model: rec.model,
      debug: rec.debug, // 服务端 _debug：真实 system + task + page_text_len + image_roles + mode
      env: {
        model: settings.inferModel,
        routing: settings.gesture.routing,
        placement: settings.placement,
        pauseSeconds: settings.gesture.pauseSeconds,
        contextLines: settings.gesture.contextLines,
        pageIndex: state.pageIndex,
        documentId: state.documentId,
        textBlocks: state.textBlocks.length,
        overlays: state.overlays.length,
      },
    };
    void fetch('/api/__debug/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(slim),
    }).catch(() => { /* dev sink 不在/出错都无所谓 */ });
  } catch { /* 取值出错也不连累 UI */ }
}

export function pushInspect(rec: InferenceInspect): void {
  log.unshift(rec);
  if (log.length > MAX) log.length = MAX;
  bus.emit('inspect');
  mirrorToDebug(rec);
}

export function inspectLog(): InferenceInspect[] {
  return log;
}
