/**
 * 端侧 OCR / intent provider 接缝（前端侧）。
 *
 * 安卓原生壳通过 androidx.webkit `WebViewCompat.addWebMessageListener` 注入一个全局通道对象
 * （约定名 `InkLoopOcr`）：`postMessage(string)` 发请求、`message` 事件回应答。本模块在其上封装
 * 一层带 id 关联 + 超时的小 RPC，暴露 recognizeInk / ocrRegion / capabilities。
 * （intent 判定在前端 TS intent-rules.ts 直接做，不走桥，故无 classifyIntent 包装。）
 *
 * Web / dev 环境没有该注入对象 → available()=false → 每个方法返回 null，各调用方据此**自动降级到云端**，
 * 行为与现状完全一致。契约即接口：Android 侧 `OcrBridge` 必须按下面的 REQ/RES 形状应答。
 *
 *   REQ  {"id":"r1","method":"recognizeInk","args":{...}}
 *   RES  {"id":"r1","ok":true,"result":{...}}   // 或 {"id":"r1","ok":false,"error":"..."}
 */
import { z } from 'zod';
import { bridgeRpcRes, ondeviceResult, type BridgeRpcRes } from '../core/schemas';

interface NativeChannel {
  postMessage(data: string): void;
  addEventListener?(type: 'message', cb: (e: { data: string }) => void): void;
  onmessage?: ((e: { data: string }) => void) | null;
}
type RpcRes = BridgeRpcRes;

function channel(): NativeChannel | null {
  const w = window as unknown as { InkLoopOcr?: NativeChannel };
  return w.InkLoopOcr ?? null;
}

let enabled = true; // 运行期总开关（dev 面板/设置后续可控）；默认开，无桥时自然降级
/** 关/开端侧通道（不影响降级语义；关时一律走云端）。 */
export function setOndeviceEnabled(v: boolean): void { enabled = v; }
/** 原生桥是否在场且启用（web/dev 恒为 false）。 */
export function ondeviceAvailable(): boolean { return enabled && !!channel(); }

let seq = 0;
const pending = new Map<string, (res: RpcRes) => void>();
let wired = false;
function ensureWired(ch: NativeChannel): void {
  if (wired) return;
  const handler = (e: { data: string }): void => {
    let raw: unknown;
    try { raw = JSON.parse(e.data); } catch { return; }
    const parsed = bridgeRpcRes.safeParse(raw); // C5：桥应答畸形即丢弃，防 Kotlin 契约漂移污染下游
    if (!parsed.success) return;
    const msg = parsed.data;
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  };
  if (ch.addEventListener) ch.addEventListener('message', handler);
  else ch.onmessage = handler;
  wired = true;
}

/** 发一次 RPC；无桥/未启用/超时/出错/应答 ok=false 一律解析为 null（让调用方降级）。 */
function rpc<T>(method: string, args: unknown, resultSchema: z.ZodType<T>, timeoutMs = 6000): Promise<T | null> {
  const ch = channel();
  if (!ch || !enabled) return Promise.resolve(null);
  ensureWired(ch);
  const id = `r${++seq}`;
  return new Promise<T | null>((resolve) => {
    const to = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, (res) => {
      clearTimeout(to);
      if (!res.ok) return resolve(null);
      const parsed = resultSchema.safeParse(res.result); // C5：结果不符约定形状 → null → 调用方降级云端
      resolve(parsed.success ? parsed.data : null);
    });
    try { ch.postMessage(JSON.stringify({ id, method, args })); }
    catch { clearTimeout(to); pending.delete(id); resolve(null); }
  });
}

/** Seam A：手写/涂鸦识别（判 kind+转写+描述）。inkPng=白底笔迹图；strokes=原始点序。
 *  ⚠️ 端侧目前无可用手写引擎：Digital Ink 需 GMS（徐实测汉王无 Play 服务即死、已禁用，目标 RK3588 板多半同样无 GMS），
 *  PP-OCR/ML Kit-text 读手写栅格实测基本不可用（exact≈0.5）。故板上拿不到引擎即返回 null → 调用方降级云 /api/interpret。
 *  待商业 raw-stroke HWR SDK（汉王/Onyx 厂商 SDK / MyScript iink）接入后，此路才真正承载手写转写。 */
export function ondeviceRecognizeInk(
  inkPng: string | undefined, strokes?: unknown,
): Promise<{ kind: string; reading: string; description: string } | null> {
  if (!inkPng) return Promise.resolve(null);
  return rpc('recognizeInk', { inkPng, strokes }, ondeviceResult.recognizeInk);
}

/** Seam B：图像区域 OCR（圈/划命中图区或无文字对象时的兜底）。 */
export function ondeviceOcrRegion(imagePng: string): Promise<{ text: string } | null> {
  return rpc('ocrRegion', { imagePng }, ondeviceResult.ocrRegion);
}

/** 能力探测：gms=板上有无 Google Play 服务（决定 ML Kit Digital Ink 手写是否可用；无 gms 则手写留云）。
 *  印刷区域 OCR（ML Kit text-recognition，模型打进 APK）不依赖 gms、恒可用——端侧真正能承载的就是它。 */
export function ondeviceCapabilities(): Promise<{ gms?: boolean } | null> {
  return rpc('capabilities', {}, ondeviceResult.capabilities);
}
