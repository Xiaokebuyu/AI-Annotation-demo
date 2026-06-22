/**
 * dev-only 遥测通道（server 端 sink）：让"开发者侧的 Claude"不进浏览器也能看清一次标注真实发生了什么。
 *
 * 流向：客户端**唯一发射器** `devEmit(kind, () => payload)`（src/core/dev-telemetry.ts，DEV-gated）
 *   → POST /api/__debug/event（已去 base64，只留精简事实）→ 这里：盖 `t`(落库时刻) + 落 JSONL + 存内存环。
 *   server 只透传、不校验 kind（taxonomy 由客户端定义、改它无需动这里）。
 * 读取：① 直接 Read `.dev-telemetry.jsonl`（最省事，无需服务在跑时联网）
 *      ② GET /api/__debug/snapshot?n=20 取内存环 JSON（要服务在跑）。
 *
 * envelope：`{ kind, ts(客户端事件时刻), t(server 落库时刻), ...payload }`。kind taxonomy（按一次标注时序）：
 *   gesture   —— 组装定型：笔画构成(类型+分)/feature/shape/flush(收口原因·时长·区域)
 *   recognize —— 识别裁判：freeform 是否送 /api/interpret·为何跳过·判定 kind/转写/描述·feature_in→out
 *   hmp       —— HMP 取证：mode/action/object_hint/命中对象(解析原文)/有无图/置信
 *   recall    —— 空间召回：逐候选 euclid/dy/dx/sameRow/verdict + 锚点笔 + 阈值
 *   inferview —— 蒸馏载荷：narrative/marked/question/referent_lines/recall_n/thematic_n/滑窗长度
 *   classify  —— 上下文分类器：respond/fold + 理由
 *   inference —— 主模型一轮：真实 system/task/焦点/回复/计时/设置快照
 *   relviz    —— 关系图可视化（dev 叠层）调试
 * 纯 dev：路由只挂在 vite 中间件里，生产构建不含；文件 gitignored。
 */
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const RING = [];
const MAX = 80;
let lastState = null;
const FILE = resolve(process.cwd(), '.dev-telemetry.jsonl');

/** 收一条事件：进内存环 + 追加 JSONL。kind='state' 的另存为 lastState 便于快照里直读。 */
export function debugEvent(rec) {
  const e = { t: new Date().toISOString(), ...(rec && typeof rec === 'object' ? rec : { raw: rec }) };
  RING.push(e);
  if (RING.length > MAX) RING.shift();
  if (e.kind === 'state' || e.env) lastState = e;
  appendFile(FILE, JSON.stringify(e) + '\n').catch(() => { /* 落盘失败不连累主链路 */ });
  return { ok: true, count: RING.length };
}

/** 取最近 n 条 + 最后一次设置/状态快照 + 文件路径（供外部 Read）。 */
export function debugSnapshot(n = 20) {
  const k = Math.max(1, Math.min(MAX, Number(n) || 20));
  return { file: FILE, count: RING.length, lastState, events: RING.slice(-k) };
}
