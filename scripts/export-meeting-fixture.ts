/**
 * dev 验证脚本：合成一场会议 → assembleMeetingL1Export → 写出 KO/projection 两份 JSON 信封，
 * 供对方 validate-fixtures.ts 重算哈希校验 + obsidian-fs CLI 写测试 vault。
 * 用法：npx tsx scripts/export-meeting-fixture.ts <outDir>
 * 纯 Node（crypto.subtle 全局可用）·不碰 store。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assembleMeetingL1Export, type MeetingExportInput } from '../src/integration/inksurface/meeting-export';
import { parseSrtTranscript } from '../src/integration/panel-feishu/align';
import type { PersistedMeeting } from '../src/core/store-format';

const T0 = 1_700_000_000_000;
const SRT = `1
00:00:03,000 --> 00:00:11,000
张宇：今天过一遍 v4 数据架构，核心是把真相分两层。

2
00:00:12,000 --> 00:00:21,000
徐智强：端侧采样率会不会有压力？

3
00:00:46,000 --> 00:00:58,000
张宇：L1 对接已过 validator，扩展我们后面自己扩。

4
00:01:00,000 --> 00:01:10,000
徐智强：采样率下限写进契约，至少 60Hz。

5
00:01:50,000 --> 00:02:02,000
蒋蕾：导出到 Obsidian 的 sidecar 下周对齐。
`;

const meeting: PersistedMeeting = {
  meeting_id: 'mtg_demo1', workspace_id: 'ws_1', title: '架构评审 v4',
  scheduled_at: new Date(T0).toISOString(), status: 'ended',
  started_at: new Date(T0).toISOString(), ended_at: new Date(T0 + 175000).toISOString(),
  material_doc_ids: [],
  feishu_minute_token: 'tok_demo', panel_meeting_start: T0, feishu_recording_t0: T0, align_offset_ms: 0, align_state: 'approx',
  summary: '会议要点：\n· 确认数据架构两层（基岩 / 语义）。\n· 采样率下限 60Hz 写入契约。\n你的强调：在采样率附近你标注了"≥60Hz"。',
  created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(),
};
const mk = (id: string, relS: number, text: string, feat = 'handwriting') =>
  ({ mark_id: id, abs_timestamp: T0 + relS * 1000, feature_type: feat, marked_text: text, page_index: 0 });

const input: MeetingExportInput = {
  meeting,
  cues: parseSrtTranscript(SRT),
  marks: [mk('a', 15, '两层真相·边界要画清'), mk('b', 50, '采样率≥60Hz 才够'), mk('c', 130, '', 'drawing'), mk('d', 152, '导出 sidecar 下周对齐')],
};

const outDir = resolve(process.cwd(), process.argv[2] || 'scratchpad-meeting-export');
const out = await assembleMeetingL1Export(input, { generatedAt: '2026-06-29T00:00:00.000Z' });
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'meeting-knowledge-objects.json'), JSON.stringify(out.knowledgeExport, null, 2));
await writeFile(resolve(outDir, 'meeting-document-projections.json'), JSON.stringify(out.documentProjections, null, 2));
console.log('wrote:', outDir);
console.log('KOs:', out.knowledgeExport.objects.length, '| blocks:', out.documentProjections.document_projections[0]?.blocks.length, '| diagnostics:', JSON.stringify(out.diagnostics));
console.log('warnings:', out.warnings);
