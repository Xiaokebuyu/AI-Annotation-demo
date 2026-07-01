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
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-max-age', '86400');
}

// ── WS2-C：panel 飞书事件中枢 GET 代理（注入 x-inkloop-secret·secret 不进前端）。
//    与 vite.config.ts panelFeishuProxy 同构，让安卓/生产包也能拉妙记转写。──
const PANEL_FEISHU_BASE = (process.env.PANEL_FEISHU_BASE || '').replace(/\/+$/, '');
const INKLOOP_SHARED_SECRET = process.env.INKLOOP_SHARED_SECRET || '';
// 阶段C：二维码设备登录代理 + session introspection 校验（复用 PANEL_FEISHU_BASE 当 panel 地址，未来可用独立 PANEL_AUTH_BASE 覆盖）。
const PANEL_AUTH_BASE = (process.env.PANEL_AUTH_BASE || process.env.PANEL_FEISHU_BASE || '').replace(/\/+$/, '');

interface InkLoopSessionContext {
  active: boolean;
  session_id?: string;
  tenant_id?: string;
  user_id?: string;
  device_id?: string;
  expires_at?: number;
  error?: string;
  feishu_open_id?: string | null; // 阶段D：introspect 顺带返回，给 handleFeishuService 转发用户上下文
}

function bearerToken(req: IncomingMessage): string {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

/** 向 panel 校验设备 session（token 只传 hash 不落库明文·panel 侧核对）。校验失败直接把响应写掉并返回 null，调用方一律 `if (!session) return;`。 */
async function requireDeviceSession(req: IncomingMessage, res: ServerResponse): Promise<InkLoopSessionContext | null> {
  const token = bearerToken(req) || String(req.headers['x-inkloop-session'] || '').trim();
  if (!token) { sendJson(res, 401, { error: 'missing_session_token' }); return null; }
  if (!PANEL_AUTH_BASE || !INKLOOP_SHARED_SECRET) { sendJson(res, 503, { error: 'PANEL_AUTH_BASE/PANEL_FEISHU_BASE / INKLOOP_SHARED_SECRET 未配置' }); return null; }
  try {
    const r = await fetch(`${PANEL_AUTH_BASE}/api/internal/inkloop/sessions/introspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inkloop-secret': INKLOOP_SHARED_SECRET },
      body: JSON.stringify({ session_token: token }),
    });
    const data = await r.json() as InkLoopSessionContext;
    if (!r.ok || !data.active) { sendJson(res, 401, { error: data.error || 'reauth_required' }); return null; }
    return data;
  } catch (e) { sendJson(res, 502, { error: String((e as Error)?.message || e) }); return null; }
}

/** 阶段C：设备二维码登录 GET/POST 代理——create/status/ack 走 shared secret（前端不持有），scan 是纯 302 跳转。 */
async function handleInkLoopAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => sendJson(res, code, obj);
  if (!PANEL_AUTH_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'PANEL_AUTH_BASE/PANEL_FEISHU_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const method = req.method || 'GET';
  const rest = (req.url || '').replace(/^\/api\/inkloop\/auth/, '');
  const apath = (rest || '/').split('?')[0];

  const create = method === 'POST' && apath === '/device-authorizations';
  const status = method === 'GET' && /^\/device-authorizations\/flow_[A-Za-z0-9_-]+\/status$/.test(apath);
  const ack = method === 'POST' && /^\/device-authorizations\/flow_[A-Za-z0-9_-]+\/ack$/.test(apath);
  const scan = method === 'GET' && /^\/device-authorizations\/flow_[A-Za-z0-9_-]+\/scan$/.test(apath);
  if (!create && !status && !ack && !scan) return send(403, { error: 'path not allowed' });

  if (scan) {
    res.statusCode = 302;
    res.setHeader('location', `${PANEL_AUTH_BASE}/api/inkloop/auth${rest}`);
    res.end();
    return;
  }

  try {
    const headers: Record<string, string> = {
      'x-inkloop-secret': INKLOOP_SHARED_SECRET,
      'x-forwarded-host': String(req.headers.host || ''),
      'x-forwarded-proto': String(req.headers['x-forwarded-proto'] || 'http'),
    };
    let body: string | undefined;
    if (method === 'POST') { body = await readBody(req); headers['content-type'] = String(req.headers['content-type'] || 'application/json'); }
    const r = await fetch(`${PANEL_AUTH_BASE}/api/inkloop/auth${rest}`, { method, headers, body });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) { send(502, { error: String((e as Error)?.message || e) }); }
}

async function handlePanelFeishu(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  const method = req.method || 'GET';
  // GET=拉妙记/会议/转写；POST=写操作（bind-minute / 生成总结 / 日程回写）。panel 侧 requireInkloopSecret + 路由收敛兜底。
  if (method !== 'GET' && method !== 'POST') return send(405, { error: 'GET/POST only' });
  const rest = (req.url || '').replace(/^\/api\/panel-feishu/, ''); // 含 query
  // 白名单：只放行设备真用的端点（防 confused-deputy——代理替前端带 secret，别让任意 POST 打到非预期端点）。
  const apath = (rest || '/').split('?')[0];
  const allowed = method === 'GET'
    ? (/^\/meetings\/[^/]+$/.test(apath) || /^\/meetings\/[^/]+\/summary$/.test(apath) || /^\/minutes\/[A-Za-z0-9_-]+(?:\/transcript)?$/.test(apath) || /^\/oauth\/status$/.test(apath))
    : /^\/meetings\/[^/]+\/(?:bind-minute|summary)$/.test(apath);
  if (!allowed) return send(403, { error: 'path not allowed' });
  if (!PANEL_FEISHU_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'PANEL_FEISHU_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const session = await requireDeviceSession(req, res);
  if (!session) return;
  try {
    const headers: Record<string, string> = { 'x-inkloop-secret': INKLOOP_SHARED_SECRET };
    let body: string | undefined;
    if (method === 'POST') { body = await readBody(req); headers['content-type'] = String(req.headers['content-type'] || 'application/json'); } // readBody 一次性 decode·中文安全
    const r = await fetch(`${PANEL_FEISHU_BASE}/api/feishu${rest}`, { method, headers, body });
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
const VAULT_FORCE_USER = process.env.INKLOOP_USER_ID || ''; // 兼容旧桶 edy；未配时用阶段C session.user_id 当新桶（多租户接缝）
const MAX_VAULT_BODY = 50 * 1024 * 1024; // 对齐 panel vault 50mb 上限·避免生产代理比上游更早拒 release（dev proxy 不限·panel 50mb·默认 25mb 是给页面图/ink 的）
async function handlePanelVault(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET' && req.method !== 'POST') return send(405, { error: 'GET/POST only' });
  if (!PANEL_VAULT_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'PANEL_VAULT_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const session = await requireDeviceSession(req, res);
  if (!session) return;
  try {
    // fail-closed 路由白名单 + user 钉死 + 路径规范化（防 confused-deputy：`../` 逃出 vault 子树把 secret 打到其它端点 / 越桶）
    const route = guardPanelVaultReqUrl(req.url || '', req.method || 'GET', VAULT_FORCE_USER || session.user_id || '');
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

// ── P0 安全止血：feishu-service（日历/群聊/群文件）+ convert-service（文件转PDF）GET 代理。
//    两条服务之前设备前端裸连、零鉴权（见项目记忆盲区扫描发现）；与 vite.config.ts feishuServiceProxy/convertServiceProxy 同构，
//    让安卓/生产包也走同源代理注入 secret。响应统一走 Buffer（群文件下载是图片/PDF 字节，.text() 会糟蹋二进制）。──
const FEISHU_SERVICE_BASE = (process.env.FEISHU_SERVICE_BASE || '').replace(/\/+$/, '');
const CONVERT_SERVICE_BASE = (process.env.CONVERT_SERVICE_BASE || '').replace(/\/+$/, '');
async function relayBinary(res: ServerResponse, r: Response): Promise<void> {
  const buf = Buffer.from(await r.arrayBuffer());
  res.statusCode = r.status;
  res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
  const cd = r.headers.get('content-disposition'); if (cd) res.setHeader('content-disposition', cd);
  res.end(buf);
}
// 阶段D：这几条端点要「我本人」的飞书用户身份（走 panel 统一 token 店），需要有效设备 session 才能拿到
// tenant_id/user_id/feishu_open_id 转发给 feishu-service；其余群/文件/应用日历端点走 tenant 身份，不需要 session。
const FEISHU_NEEDS_USER_CONTEXT = /^\/api\/feishu\/(oauth\/status|my\/events|docx\/[^/]+\/(meta|raw-content|pdf))$/;

function feishuUserContextHeaders(session: InkLoopSessionContext): Record<string, string> {
  const openId = session.feishu_open_id;
  if (!session.tenant_id || !session.user_id || !openId) return {}; // 未连接飞书身份·feishu-service 走 legacy fallback
  return {
    'x-inkloop-tenant-id': session.tenant_id,
    'x-inkloop-user-id': session.user_id,
    'x-inkloop-feishu-open-id': openId,
  };
}

async function handleFeishuService(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (!FEISHU_SERVICE_BASE) return send(503, { error: 'FEISHU_SERVICE_BASE 未配置' });
  const rest = (req.url || '').replace(/^\/api\/feishu-svc/, ''); // 含 query
  const apath = (rest || '/').split('?')[0];
  const target = `${FEISHU_SERVICE_BASE}${rest}`;
  if (apath === '/api/feishu/oauth/login') { res.statusCode = 302; res.setHeader('location', target); res.end(); return; } // 纯跳转·不需要 secret
  if (!INKLOOP_SHARED_SECRET) return send(503, { error: 'INKLOOP_SHARED_SECRET 未配置' });
  // 白名单：只放行设备真用的 GET 数据端点（防 confused-deputy）。
  // 妙记 docx 挂资料：workspaces/:chatId/docx-links(链接候选) + docx/:token/(meta|raw-content|pdf)(元信息/纯文本/手动导出PDF)。
  const allowed = /^\/api\/feishu\/(oauth\/status|my\/events|workspaces(\/[^/]+)?(\/(members|messages|files|docx-links))?|messages\/[^/]+\/file\/[^/]+|docx\/[^/]+\/(meta|raw-content|pdf)|calendars|events)$/.test(apath);
  if (!allowed) return send(403, { error: 'path not allowed' });
  let userContextHeaders: Record<string, string> = {};
  if (FEISHU_NEEDS_USER_CONTEXT.test(apath)) {
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    userContextHeaders = feishuUserContextHeaders(session);
  }
  try {
    const r = await fetch(target, { headers: { 'x-inkloop-secret': INKLOOP_SHARED_SECRET, ...userContextHeaders } });
    await relayBinary(res, r);
  } catch (e) { send(502, { error: String((e as Error)?.message || e) }); }
}
// 阶段E：convert-service 代抓 feishu-service 的 docx 私有资源(meta/raw-content/pdf)时，不能只信任裸 url——
// 要先拿真实设备 session 向 panel 换一张一次性下载票据，转发给 convert-service（而不是 tenant/user 身份头，
// convert-service 不该直接持有/转发这些身份信息）。群文件等其它 convert 目标不受影响，走原来的裸转发。
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
const FEISHU_DOCX_TICKET_PATH = /^\/api\/feishu\/docx\/([A-Za-z0-9_-]{8,80})\/(meta|raw-content|pdf)$/;

function parseFeishuDocxTicketTarget(raw: string): { token: string; action: string } | null {
  if (!FEISHU_SERVICE_BASE) return null;
  try {
    const u = new URL(raw);
    const b = new URL(FEISHU_SERVICE_BASE + '/');
    if (u.origin !== b.origin) return null;
    const base = b.pathname.replace(/\/+$/, '');
    const rel = base && base !== '/' ? (u.pathname.startsWith(base + '/') ? u.pathname.slice(base.length) : '') : u.pathname;
    const m = rel.match(FEISHU_DOCX_TICKET_PATH);
    return m ? { token: m[1], action: m[2] } : null;
  } catch { return null; }
}

async function issueDownloadTicket(sessionToken: string, target: { token: string; action: string }): Promise<string> {
  if (!PANEL_AUTH_BASE || !INTERNAL_SERVICE_TOKEN) throw Object.assign(new Error('PANEL_AUTH_BASE / INTERNAL_SERVICE_TOKEN 未配置'), { status: 503 });
  const r = await fetch(`${PANEL_AUTH_BASE}/api/internal/inkloop/download-tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_token: sessionToken, resource_type: 'feishu_docx', resource_id: target.token, action: target.action, audience: 'feishu-service', ttl_ms: 300000 }),
  });
  const data = await r.json().catch(() => ({})) as { ticket?: string; error?: string };
  if (!r.ok || !data.ticket) throw Object.assign(new Error(data.error || `issue ticket HTTP ${r.status}`), { status: r.status });
  return data.ticket;
}

async function handleConvertService(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (!CONVERT_SERVICE_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'CONVERT_SERVICE_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const rest = (req.url || '').replace(/^\/api\/convert/, '');
  const apath = (rest || '/').split('?')[0];
  if (apath !== '/to-pdf') return send(403, { error: 'path not allowed' });
  const sourceUrl = new URL(req.url || '/', 'http://inkloop.local').searchParams.get('url') || '';
  const docxTarget = parseFeishuDocxTicketTarget(sourceUrl);
  const headers: Record<string, string> = { 'x-inkloop-secret': INKLOOP_SHARED_SECRET };
  try {
    if (docxTarget) {
      const sessionToken = bearerToken(req) || String(req.headers['x-inkloop-session'] || '').trim();
      const session = await requireDeviceSession(req, res);
      if (!session) return;
      if (!session.tenant_id || !session.user_id || !session.feishu_open_id) return send(409, { error: 'reauth_required' });
      headers['x-inkloop-download-ticket'] = await issueDownloadTicket(sessionToken, docxTarget);
    }
    const r = await fetch(`${CONVERT_SERVICE_BASE}/convert${rest}`, { headers });
    await relayBinary(res, r);
  } catch (e) { send(Number((e as { status?: number })?.status) || 502, { error: String((e as Error)?.message || e) }); }
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
  // 阶段C：二维码设备登录（在 POST-only 闸之前·create/status/ack 都有 POST/GET 混合）
  if (url.startsWith('/api/inkloop/auth')) { await handleInkLoopAuth(req, res); return; }
  // WS2-C：panel 飞书 GET 代理（在 POST-only 闸之前）
  if (url.startsWith('/api/panel-feishu')) { await handlePanelFeishu(req, res); return; }
  // 交付路线 Y：vault release GET/POST 代理（在 POST-only 闸之前·因含 GET latest/blob）
  if (url.startsWith('/api/panel-vault')) { await handlePanelVault(req, res); return; }
  // P0 安全止血：feishu-service / convert-service GET 代理（在 POST-only 闸之前）
  if (url.startsWith('/api/feishu-svc')) { await handleFeishuService(req, res); return; }
  if (url.startsWith('/api/convert')) { await handleConvertService(req, res); return; }
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
