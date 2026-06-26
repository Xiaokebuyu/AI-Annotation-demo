/**
 * 平台能力 ports（F1）—— 把已存在的「非正式平台接缝」形式化成 TS 接口契约。
 *
 * 这些接缝原本就是「web/dev 自动降级、套壳内由原生桥接管」的模式：
 *   · EinkPort  ← surface/eink.ts（window.InkLoopEink，无桥 no-op）
 *   · OcrPort   ← evidence/ondevice.ts（window.InkLoopOcr，无桥/无引擎返 null → 降级云端）
 *   · TelemetryPort ← core/dev-telemetry.ts（devEmit，生产构建 no-op）
 *
 * 本文件只定义契约 + 从现有函数装配 port 对象（零改现有模块）。tsc 即「一致性校验」：
 * 接缝函数签名若漂移、不再满足接口 → 编译报错。F2 起的 use-case 依赖这些 port（而非具体模块）。
 * AiPort / StorePort 偏「服务」接缝、随 F2 pipeline 提纯一并抽。
 */
import type { DevEventKind } from '../core/dev-telemetry';
import { devEmit } from '../core/dev-telemetry';
import { einkAvailable, setEinkEnabled, signalPageReady, signalInkArea, initEinkMirror } from '../surface/eink';
import { ondeviceAvailable, setOndeviceEnabled, ondeviceRecognizeInk, ondeviceOcrRegion, ondeviceCapabilities } from '../evidence/ondevice';

/** 电纸屏推帧（IT8951 / window.InkLoopEink）。web/dev 无桥则各方法 no-op。 */
export interface EinkPort {
  available(): boolean;
  setEnabled(v: boolean): void;
  signalPageReady(mode?: number): void;
  signalInkArea(bbox: [number, number, number, number]): void;
  initMirror(): void;
}

/** 端侧 OCR / 手写识别（OcrBridge / window.InkLoopOcr）。无桥/无引擎 → null → 调用方降级云端。 */
export interface OcrPort {
  available(): boolean;
  setEnabled(v: boolean): void;
  recognizeInk(inkPng: string | undefined, strokes?: unknown): Promise<{ kind: string; reading: string; description: string } | null>;
  ocrRegion(imagePng: string): Promise<{ text: string } | null>;
  capabilities(): Promise<{ gms?: boolean } | null>;
}

/** DEV 遥测（单一发射器 → /api/__debug/event）。生产构建下 no-op。 */
export interface TelemetryPort {
  emit(kind: DevEventKind, build: () => Record<string, unknown>): void;
}

export const einkPort: EinkPort = {
  available: einkAvailable,
  setEnabled: setEinkEnabled,
  signalPageReady,
  signalInkArea,
  initMirror: initEinkMirror,
};

export const ocrPort: OcrPort = {
  available: ondeviceAvailable,
  setEnabled: setOndeviceEnabled,
  recognizeInk: ondeviceRecognizeInk,
  ocrRegion: ondeviceOcrRegion,
  capabilities: ondeviceCapabilities,
};

export const telemetryPort: TelemetryPort = {
  emit: devEmit,
};
