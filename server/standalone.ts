/**
 * 托管 AI 代理（独立 Node 服务）——给安卓 WebView 包用。
 *
 * dev 期 /api/* 是 Vite 中间件（见 vite.config.ts），`npm run build` 后的静态包里不存在；
 * 本服务把同一套 server/infer.ts 的 handler 暴露成同名 HTTP 路由，让 WebView 里的相对
 * /api/*（经 VITE_API_BASE_URL 指过来）有真实后端。Key 只在服务端环境变量；
 * **不暴露 /api/__debug/***（仅 dev 调试通道，生产不部署）。
 *
 * 运行（Node ≥23.6 直跑 TS / 本仓库 v25 可直接）：
 *   PORT=3000 node server/standalone.ts        # 真实 env 由部署环境给
 *   # 或本地：读项目根 .env；或 npx tsx server/standalone.ts
 *
 * 路由与 vite.config.ts 的中间件一一对应（9 路由），契约不变。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNonEmptyVaultRelease, guardPanelVaultReqUrl, panelVaultGuardPayload } from './panel-vault-guard';
import {
  runReflow, runReflowAi, reflowAiStream, chatStream,
  runOcrVlm, runExplainImage, runInterpret, runClassifyContext, runReflowVlm,
} from './infer';

// ── .env：把项目根 .env 注入 process.env（只填未设的键），与 vite.config 行为一致 ──
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const k = m[1];
    if (!process.env[k]) process.env[k] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 无 .env 时靠真实环境变量 */ }

// ── CORS：放行 WebView 页面 origin（appassets）+ 本地开发；额外 origin 经 CORS_EXTRA_ORIGIN ──
const ALLOW_ORIGINS = new Set<string>([
  'https://appassets.androidplatform.net',
  'http://localhost:8765',
  ...(process.env.CORS_EXTRA_ORIGIN ? [process.env.CORS_EXTRA_ORIGIN] : []),
]);
function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '86400');
}

// ── WS2-C：panel 飞书事件中枢 GET 代理（注入 x-inkloop-secret·secret 不进前端）。
//    与 vite.config.ts panelFeishuProxy 同构，让安卓/生产包也能拉妙记转写。──
const PANEL_FEISHU_BASE = (process.env.PANEL_FEISHU_BASE || '').replace(/\/+$/, '');
const INKLOOP_SHARED_SECRET = process.env.INKLOOP_SHARED_SECRET || '';
async function handlePanelFeishu(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (!PANEL_FEISHU_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'PANEL_FEISHU_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const rest = (req.url || '').replace(/^\/api\/panel-feishu/, ''); // 含 query
  try {
    const r = await fetch(`${PANEL_FEISHU_BASE}/api/feishu${rest}`, { headers: { 'x-inkloop-secret': INKLOOP_SHARED_SECRET } });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) { send(502, { error: String((e as Error)?.message || e) }); }
}

// ── 交付路线 Y：panel vault release 代理（GET+POST·注入 x-inkloop-secret·secret 不进前端）。
//    与 vite.config.ts panelVaultProxy 同构，让安卓/生产包也能 上传 / 拉取 vault release。
//    userId 服务端 override（INKLOOP_USER_ID 设了→钉死路径 user 段·设备改不了别人的桶）——
//    per-user 接缝：今天=固定 env（单用户），将来=登录态派生。──
const PANEL_VAULT_BASE = (process.env.PANEL_VAULT_BASE || '').replace(/\/+$/, ''); // 形如 http://host:3001/api/inkloop/vault
const VAULT_FORCE_USER = process.env.INKLOOP_USER_ID || ''; // 钉死路径 user 段·必配（guard fail-closed：未配即 503·绝不透传客户端 userId）
const MAX_VAULT_BODY = 50 * 1024 * 1024; // 对齐 panel vault 50mb 上限·避免生产代理比上游更早拒 release（dev proxy 不限·panel 50mb·默认 25mb 是给页面图/ink 的）
async function handlePanelVault(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET' && req.method !== 'POST') return send(405, { error: 'GET/POST only' });
  if (!PANEL_VAULT_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'PANEL_VAULT_BASE / INKLOOP_SHARED_SECRET 未配置' });
  try {
    // fail-closed 路由白名单 + user 钉死 + 路径规范化（防 confused-deputy：`../` 逃出 vault 子树把 secret 打到其它端点 / 越桶）
    const route = guardPanelVaultReqUrl(req.url || '', req.method || 'GET', VAULT_FORCE_USER);
    const headers: Record<string, string> = { 'x-inkloop-secret': INKLOOP_SHARED_SECRET };
    let body: string | undefined;
    if (req.method === 'POST') { body = await readBody(req, MAX_VAULT_BODY); if (route.releasePost) assertNonEmptyVaultRelease(body); headers['content-type'] = String(req.headers['content-type'] || 'application/json'); }
    const r = await fetch(`${PANEL_VAULT_BASE}${route.rest}`, { method: req.method, headers, body });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) { const g = panelVaultGuardPayload(e); if (g) return send(g.status, { error: g.error }); send(502, { error: String((e as Error)?.message || e) }); }
}

// intent A/B 影子数据落盘位置（板上 production 收集云端↔端侧 respond/fold 一致率）。
const AB_LOG = process.env.AB_LOG || resolve(ROOT, '.ab-intent.jsonl');

const MAX_BODY = 25 * 1024 * 1024; // 25MB：页面图 / ink PNG dataURL
function readBody(req: IncomingMessage, maxBody = MAX_BODY): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) { rej(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    // 先 Buffer.concat 再一次性 decode：逐 chunk toString() 会在多字节 UTF-8（中文）跨 chunk 边界处插入替换字符，
    // 板上长 prompt/会议转写会静默失真（vite.config 代理早已这么做）。
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

// 一次性 JSON 路由（与流式两路分开）
const JSON_ROUTES: Record<string, (body: unknown) => Promise<unknown>> = {
  '/api/reflow': runReflow,
  '/api/reflow-ai': runReflowAi,
  '/api/ocr-vlm': runOcrVlm,
  '/api/explain-image': runExplainImage,
  '/api/interpret': runInterpret,
  '/api/classify-context': runClassifyContext,
  '/api/reflow-vlm': runReflowVlm,
};

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  // WS2-C：panel 飞书 GET 代理（在 POST-only 闸之前）
  if (url.startsWith('/api/panel-feishu')) { await handlePanelFeishu(req, res); return; }
  // 交付路线 Y：vault release GET/POST 代理（在 POST-only 闸之前·因含 GET latest/blob）
  if (url.startsWith('/api/panel-vault')) { await handlePanelVault(req, res); return; }
  if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }

  try {
    // intent A/B 影子收集：落 jsonl（非 LLM 调用；板上 production 也可发）。
    if (url === '/api/ab/intent') {
      const rec = JSON.parse(await readBody(req));
      try { appendFileSync(AB_LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'); }
      catch { /* 落盘失败不影响主链路 */ }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    // 流式：NDJSON 重排——边收模型分组边写回；x-accel-buffering 禁中间层缓冲。
    if (url === '/api/reflow-ai-stream') {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-accel-buffering', 'no');
      for await (const group of reflowAiStream(body)) res.write(JSON.stringify(group) + '\n');
      res.end();
      return;
    }
    // 流式：text/plain 对话——逐段增量写回。
    if (url === '/api/chat') {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-accel-buffering', 'no');
      for await (const delta of chatStream(body)) res.write(String(delta));
      res.write(JSON.stringify({ k: 'done' }) + '\n'); // 完成哨兵（与 vite.config 同·防客户端把半截当成功）
      res.end();
      return;
    }
    // 一次性 JSON
    const fn = JSON_ROUTES[url];
    if (!fn) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: `no such route: ${url}` })); return; }
    const body = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await fn(body)));
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: msg })); }
    else { if (url === '/api/chat') { try { res.write(JSON.stringify({ k: 'e', d: msg }) + '\n'); } catch { /* 客户端已断 */ } } res.end(); } // chat 流已写出后出错：发 error 帧让客户端丢半截
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`[inkloop proxy] :${PORT}  model=${process.env.LLM_MODEL || 'kimi-k2.6'}  key=${process.env.LLM_GATEWAY_KEY ? 'set' : 'MISSING'}`);
});
