import type { InferenceRequest, InferenceResult, ResultType } from '../core/contracts';
import { shortId } from '../core/ids';

export type InferenceProvider = (req: InferenceRequest) => Promise<InferenceResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let counter = 0;

const mock: InferenceProvider = async (req) => {
  await sleep(600);
  const types: ResultType[] = ['question', 'inspiration', 'connection'];
  const t = types[counter++ % types.length];
  const snippet = (req.ocr_blocks[0]?.text || req.nearby_text || '该区域').slice(0, 24);
  const content = {
    question: `这里值得追问：「${snippet}…」背后的假设是否成立？`,
    inspiration: `「${snippet}」可以和你之前标注过的概念建立联系，形成一个新的假设方向。`,
    connection: `「${snippet}」与本文档其他章节可能存在呼应，建议对照阅读。`,
  }[t as 'question' | 'inspiration' | 'connection'];
  return {
    result_id: shortId('res'),
    trace_id: req.trace_id,
    request_id: req.request_id,
    result_type: t,
    content,
    source_refs: [{
      page_id: req.annotation_event.page_id,
      bbox: req.ocr_blocks[0]?.bbox || req.annotation_event.geometry.bbox,
      ocr_block_ids: req.ocr_blocks.map((b) => b.id),
      event_id: req.event_id,
    }],
    confidence: 0.82,
    created_at: new Date().toISOString(),
    model_name: 'deterministic-mock',
    model_version: '0',
  };
};

const fail: InferenceProvider = async () => {
  await sleep(400);
  throw new Error('模拟云端超时（A11 演练）');
};

const cloud: InferenceProvider = async () => {
  throw new Error('真实云端推理待 AB1 定稿后经 API client 接入（A8）');
};

export const inferProviders: Record<string, InferenceProvider> = { mock, fail, cloud };

export const INFER_PROVIDER_LABELS: Record<string, string> = {
  mock: 'deterministic mock',
  fail: '模拟失败（测 A11）',
  cloud: '真实云端（stub）',
};
