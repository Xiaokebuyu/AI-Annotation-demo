/**
 * dev-only：图片版/扫描 PDF 的「带坐标 OCR」端点（Phase 2 位置文本层用）。
 *
 * shell 到 端侧ocr方案/mac_runner（RapidOCR，与板上 PP-OCR 同一套 det/rec 模型），拿每行 box+text+score。
 * 前端 src/evidence/page-ocr.ts 把它转成带 bbox 的 OcrTextBlock → SurfaceIndex。
 *
 * ⚠️ 仅 dev（本机有 mac_runner venv）：**不进生产 standalone 代理**。
 *    板子到位后换成 PpOcrBridge 透出 box（com.paddle.ocr 的 OCRBox+BoxSorter），前端契约 {blocks,width,height} 不变。
 *
 * REQ  { image: dataURL }
 * RES  { blocks: [{ text, box:[[x,y]*4(像素)], score }], width, height }
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER_DIR = process.env.MAC_RUNNER_DIR
  || '/Users/edy/Desktop/Nova_project/端侧ocr方案/mac_runner';
const PYTHON = process.env.MAC_RUNNER_PYTHON || join(RUNNER_DIR, '.venv/bin/python');

export async function runOcrLayout(payload) {
  const dataUrl = payload?.image;
  if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('image (dataURL) required');
  const comma = dataUrl.indexOf(',');
  const buf = Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');
  const dir = await mkdtemp(join(tmpdir(), 'ocrlayout-'));
  const imgPath = join(dir, 'page.png');
  await writeFile(imgPath, buf);
  try {
    const stdout = await new Promise((resolve, reject) => {
      const p = spawn(PYTHON, ['runner.py', '--json', imgPath], { cwd: RUNNER_DIR });
      let so = '', se = '';
      p.stdout.on('data', (d) => (so += d));
      p.stderr.on('data', (d) => (se += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(`runner exit ${code}: ${se.slice(-400)}`))));
    });
    // runner 可能在 JSON 前打印别的 → 取最后一行非空作 JSON
    const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}';
    return JSON.parse(line);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
