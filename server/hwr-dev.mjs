/**
 * dev-only：英文手写识别端点（识别分类器选「端侧手写·OpenVINO」时走这里）。
 *
 * 持久 worker（保活）：spawn 一个 `hwr_runner.py --serve` 常驻进程，模型只加载一次；
 * 之后每次请求把临时图片路径写进 worker.stdin、读回一行 JSON。首次请求付模型加载(~2.5s)，之后只剩推理(~百毫秒)。
 * 单 stdin/stdout 流 → 请求串行化（一次一个）。worker 挂了下次请求自动重启。
 *
 * shell 到 端侧ocr方案/hwr_runner（OpenVINO handwritten-english-recognition-0001，图像式行识别，**英文 only**）。
 * ⚠️ 仅 dev：**不进生产 standalone 代理**。板上换 NPU 跑同模型，前端契约 {reading} 不变。
 *
 * REQ  { image: dataURL }   RES  { reading: string }
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER_DIR = process.env.HWR_RUNNER_DIR || '/Users/edy/Desktop/Nova_project/端侧ocr方案/hwr_runner';
const PYTHON = process.env.MAC_RUNNER_PYTHON || '/Users/edy/Desktop/Nova_project/端侧ocr方案/mac_runner/.venv/bin/python';

// 默认用我们下载的英文 GNHK 模型（产品英文为主；徐没有英文手写模型，他交付的是中文且不合格）。
// 临时验证徐的中文模型：起 dev 前 export HWR_MODEL=<...chinese.xml> HWR_CHARSET=<...scut_ept.txt>（runner 读这两个 env）。

let worker = null;            // 持久 python worker（模型常驻）
let pending = null;           // 当前在途请求的 resolve（串行，一次一个）
let buf = '';

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  const p = spawn(PYTHON, ['hwr_runner.py', '--serve'], { cwd: RUNNER_DIR }); // 继承 process.env（HWR_MODEL/HWR_CHARSET 若设了即生效，否则 runner 默认英文）
  buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.ready) continue; // 启动就绪信号，跳过
      const r = pending; pending = null;
      if (r) r(obj);
    }
  });
  p.stderr.on('data', () => { /* 吞 openvino 日志 */ });
  p.on('exit', () => {
    if (worker === p) worker = null;
    const r = pending; pending = null;
    if (r) r({ reading: '', error: 'worker exited' });
  });
  worker = p;
  return p;
}

// 串行队列：单 worker 流，前一个完成才发下一个。
let queue = Promise.resolve();

export async function runInterpretHwr(payload) {
  const dataUrl = payload?.image;
  if (typeof dataUrl !== 'string' || !dataUrl) throw new Error('image (dataURL) required');
  const comma = dataUrl.indexOf(',');
  const imgBuf = Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');

  const run = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwr-'));
    const imgPath = join(dir, 'ink.png');
    await writeFile(imgPath, imgBuf);
    try {
      const p = ensureWorker();
      return await new Promise((resolve) => {
        pending = resolve;
        const to = setTimeout(() => { if (pending === resolve) { pending = null; resolve({ reading: '', error: 'timeout' }); } }, 20000);
        const wrapped = (v) => { clearTimeout(to); resolve(v); };
        pending = wrapped;
        p.stdin.write(imgPath + '\n');
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  queue = run.then(() => {}, () => {}); // 链式串行，吞错不断链
  // ★ 「是否采纳为本地手写」的判定**与本模型（OpenVINO 英文 GNHK）强耦合，封装在此适配层、不外泄到核心 pipeline**。
  //   置信度 + 长度双门：可信多字符英文才回 reading；否则（低置信=跑偏/OOD，或太短=多半是画/符号）回空字符串 →
  //   前端按"reading 空即降级"的统一契约落云 VLM（拿正确 kind+画描述，本模型判不了画）。换引擎=换这里的判据，pipeline 不动。
  //   数据依据：真手写 hello conf0.97/11字 采纳；画(笑脸 conf0.994 仅1字「0」、涂鸦 0.905 仅2字「in」)、中文草书 conf0.475 → 全落云。
  return run.then((r) => {
    const reading = String(r?.reading || '').trim();
    const conf = Number(r?.confidence) || 0;
    return { reading: (reading.length >= 4 && conf >= 0.6) ? reading : '' };
  });
}
