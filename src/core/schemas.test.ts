import { describe, it, expect } from 'vitest';
import { bridgeRpcRes, ondeviceResult } from './schemas';

describe('bridgeRpcRes 信封校验', () => {
  it('合法应答通过', () => {
    expect(bridgeRpcRes.safeParse({ id: 'r1', ok: true, result: { text: 'hi' } }).success).toBe(true);
    expect(bridgeRpcRes.safeParse({ id: 'r1', ok: false, error: 'x' }).success).toBe(true);
  });
  it('缺字段 / 类型错 / 非对象 → 拒', () => {
    expect(bridgeRpcRes.safeParse({ id: 'r1' }).success).toBe(false);       // 缺 ok
    expect(bridgeRpcRes.safeParse({ id: 1, ok: true }).success).toBe(false); // id 类型错
    expect(bridgeRpcRes.safeParse(null).success).toBe(false);
    expect(bridgeRpcRes.safeParse('garbage').success).toBe(false);
  });
});

describe('ondeviceResult 各 method 结果校验', () => {
  it('recognizeInk', () => {
    expect(ondeviceResult.recognizeInk.safeParse({ kind: 'handwriting', reading: 'x', description: '' }).success).toBe(true);
    expect(ondeviceResult.recognizeInk.safeParse({ kind: 'handwriting' }).success).toBe(false); // 缺字段
    expect(ondeviceResult.recognizeInk.safeParse({ kind: 1, reading: 'x', description: '' }).success).toBe(false);
  });
  it('ocrRegion / capabilities', () => {
    expect(ondeviceResult.ocrRegion.safeParse({ text: 'abc' }).success).toBe(true);
    expect(ondeviceResult.ocrRegion.safeParse({}).success).toBe(false);
    expect(ondeviceResult.capabilities.safeParse({}).success).toBe(true);       // gms 可选
    expect(ondeviceResult.capabilities.safeParse({ gms: true }).success).toBe(true);
    expect(ondeviceResult.capabilities.safeParse({ gms: 'yes' }).success).toBe(false);
  });
});
