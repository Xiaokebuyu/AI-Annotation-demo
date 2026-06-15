/**
 * 上下文监控：把每次推理「喂了什么上下文 + 模型回了什么」攒成一个环形日志，
 * 供开发面板的「上下文监控」面板展示运行状况。纯记录，不参与主链路。
 */
import { bus } from '../app/state';

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
  debug: Record<string, unknown> | null; // 服务端 _debug：真实 system + task + 用到的记忆
  resultType: string;
  content: string;
  confidence: number;
  recalled: number[];       // Tier2 回看了哪些页
  model: string;
}

const log: InferenceInspect[] = [];
const MAX = 20;

export function pushInspect(rec: InferenceInspect): void {
  log.unshift(rec);
  if (log.length > MAX) log.length = MAX;
  bus.emit('inspect');
}

export function inspectLog(): InferenceInspect[] {
  return log;
}
