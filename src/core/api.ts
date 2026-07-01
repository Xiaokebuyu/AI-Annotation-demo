/**
 * 客户端 AI 传输信封：把分散在各调用点的 fetch('/api/...') 样板收口到一处。
 *
 *   - postJson：一次性 JSON POST，失败即抛（!ok 与网络错统一成一条 catch 路径）。
 *   - postNdjson：流式 NDJSON POST，逐行解析后回调，容忍半行/坏行。
 *
 * 只吸收 HTTP 样板（method/headers/序列化/ok 校验/分帧）；**降级语义留给各调用方**
 * （recognize 返默认、reflow 返原值、classify 返 {respond:true}……各不相同，不能一刀切）。
 */

/**
 * 生产/安卓包 API 基址：dev 留空 → 仍走 Vite 的 /api/* 中间件（同源相对路径）。
 * 安卓包构建时注入 `VITE_API_BASE_URL=https://<proxy>`，让 WebView 里的相对 /api/*
 * 指向托管 HTTPS 后端（dev 中间件在静态包里不存在）。
 */
// ── API 线路（所有设备直连的云服务共用这一个出口：AI(interpret/chat/classify) + Obsidian 上传(panel-vault)
//    + 飞书妙记(panel-feishu) + 设备登录 + convert 全走 apiUrl）──
// 运行时可切换（换地方免重打包）：localStorage `inkloop.apiRoute` 覆盖烧录默认。''/'default'=烧录默认；
// 'intranet'/'cloud'=下面内置路由；也可存自定义 http(s):// URL。dev 页「网络线路」下拉调 setApiRoute。
const BAKED_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');
const KNOWN_ROUTES: Record<string, string> = {
  intranet: 'http://10.4.36.30:3000',        // 内网直连（少一跳更快；http 明文仅 debug 构建放行）
  cloud: 'https://inkloopai.xiaobuyu.trade', // cloudflared 公网（内外网通用；https 无需明文配置）
};
const ROUTE_KEY = 'inkloop.apiRoute';
function readRouteOverride(): string { try { return localStorage.getItem(ROUTE_KEY) || ''; } catch { return ''; } }
function resolveApiBase(): string {
  const o = readRouteOverride();
  if (o && KNOWN_ROUTES[o]) return KNOWN_ROUTES[o];
  if (/^https?:\/\//i.test(o)) return o.replace(/\/+$/, ''); // 自定义绝对 URL
  return BAKED_BASE;
}
let API_BASE = resolveApiBase();

/** 运行时切换所有云服务共用的 API 线路（换地方免重打包·立即对后续请求生效）。
 *  route: ''/'default'=用烧录默认；'intranet'/'cloud'=内置路由；或自定义 http(s):// URL。 */
export function setApiRoute(route: string): void {
  try {
    if (!route || route === 'default') localStorage.removeItem(ROUTE_KEY);
    else localStorage.setItem(ROUTE_KEY, route);
  } catch { /* localStorage 不可用则仅本次会话不持久 */ }
  API_BASE = resolveApiBase();
}
/** dev 页显示用：当前线路选择的原始值（''=烧录默认）。 */
export function apiRouteChoice(): string { return readRouteOverride(); }
/** dev 页显示用：当前实际生效的 base（空=dev 同源）。 */
export function apiBase(): string { return API_BASE; }

/** 导出供直连 fetch 的调用点复用（不走 getJson/postJson 的场景，如二进制下载）——codex 扫描出的真 bug：
 *  会中资料链路(feishuGet/fetchPdfBytes/listMeetingGroupMaterialFiles)之前裸 fetch('/api/...')，
 *  安卓静态包(WebView appassets 源)下不会走 VITE_API_BASE_URL，直接打到 assets 域名 404。 */
export function apiUrl(path: string): string {
  if (!API_BASE) return path;                    // dev：同源 /api/*
  if (/^https?:\/\//i.test(path)) return path;   // 已是绝对 URL，原样
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

import { authHeaders, handleAuthFailure } from './auth';

type ApiOpts = {
  signal?: AbortSignal;
  acceptStatuses?: number[];
  auth?: boolean;
};

/** 阶段C：哪些路径自动带设备 session——只覆盖 panel/受保护代理路由，AI 推理端点(/api/chat等)这轮不动，
 *  避免一次性把还没接 session 校验的服务端一起改坏行为。调用方可用 opts.auth 显式覆盖。 */
function shouldSendAuth(url: string, opts?: ApiOpts): boolean {
  if (opts?.auth === false) return false;
  if (opts?.auth === true) return true;
  return /^\/api\/(?:panel-feishu|panel-vault|feishu-svc|convert)(?:\/|$)/.test(url);
}

function headersWithAuth(url: string, base?: Record<string, string>, opts?: ApiOpts): Record<string, string> {
  return shouldSendAuth(url, opts) ? { ...(base || {}), ...authHeaders() } : { ...(base || {}) };
}

async function parseAuthErrorCode(resp: Response): Promise<string> {
  try {
    const data = await resp.clone().json() as { error?: unknown; code?: unknown };
    return String(data.error || data.code || '');
  } catch {
    return '';
  }
}

/** 401/403 且能识别出"需要重新登录"的错误码时，清本地 session + 派发 `inkloop:reauth-required`
 *  （auth-login.ts 监听后重新弹二维码）。不抛错——调用方原有的状态码判断逻辑照常处理这次失败。 */
async function notifyAuthFailureIfNeeded(resp: Response): Promise<void> {
  if (resp.status !== 401 && resp.status !== 403) return;
  const err = await parseAuthErrorCode(resp);
  if (err === 'reauth_required' || err === 'missing_session_token' || err === 'invalid_session' || resp.status === 401) {
    handleAuthFailure(err || 'reauth_required');
  }
}

/** 需要设备 session 但不走 JSON 收发的原始 fetch（如二进制下载）。 */
export async function authFetch(path: string, init: RequestInit = {}, opts?: ApiOpts): Promise<Response> {
  const headers = new Headers(init.headers || undefined);
  for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);
  const resp = await fetch(apiUrl(path), { ...init, headers, signal: opts?.signal ?? init.signal });
  await notifyAuthFailureIfNeeded(resp);
  return resp;
}

/** 发后不管的 JSON POST（遥测/beacon）：失败静默、不阻塞、不抛。keepalive 让翻页/退出时也能送达。 */
export function postBeacon(url: string, body: unknown): void {
  try {
    void fetch(apiUrl(url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), keepalive: true,
    }).catch(() => { /* beacon 不在/出错都无所谓 */ });
  } catch { /* 序列化出错也不连累 UI */ }
}

/** 一次性 JSON POST。失败（!resp.ok 且状态码不在 opts.acceptStatuses 里）一律抛错，调用方自行 try/catch 兜底。
 *  acceptStatuses：个别非 2xx 状态码本身携带可展示的结构化 body（如 409 表示"缺依赖不是真失败"），
 *  调用方想正常解析这份 body 而非被泛化成异常时传入（codex 扫描出的真 bug：不传时 body 会被整个丢弃）。 */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts?: ApiOpts,
): Promise<T> {
  const resp = await fetch(apiUrl(url), {
    method: 'POST',
    headers: headersWithAuth(url, { 'content-type': 'application/json' }, opts),
    signal: opts?.signal,
    body: JSON.stringify(body),
  });
  await notifyAuthFailureIfNeeded(resp);
  if (!resp.ok && !opts?.acceptStatuses?.includes(resp.status)) throw new Error(`${url} ${resp.status}`);
  return (await resp.json()) as T;
}

/**
 * 一次性 JSON GET（经 apiUrl·支持安卓包绝对基址）。失败（!ok / 网络错）即抛。
 * WS2-C panel-feishu client 走它，不裸 fetch('/api/...')（dev 同源 + 生产 VITE_API_BASE_URL 都覆盖）。
 */
export async function getJson<T>(url: string, opts?: ApiOpts): Promise<T> {
  const resp = await fetch(apiUrl(url), { method: 'GET', signal: opts?.signal, headers: headersWithAuth(url, undefined, opts) });
  await notifyAuthFailureIfNeeded(resp);
  if (!resp.ok && !opts?.acceptStatuses?.includes(resp.status)) throw new Error(`${url} ${resp.status}`);
  return (await resp.json()) as T;
}

/**
 * 流式 NDJSON POST：边收边按 '\n' 切行，逐行 JSON.parse 后调 onLine。
 * 半行先攒着、坏行跳过、收尾处理残行。失败（!ok / 无 body）抛错。
 */
export async function postNdjson<T>(
  url: string,
  body: unknown,
  onLine: (parsed: T) => void,
  opts?: ApiOpts,
): Promise<void> {
  const resp = await fetch(apiUrl(url), {
    method: 'POST',
    headers: headersWithAuth(url, { 'content-type': 'application/json' }, opts),
    signal: opts?.signal,
    body: JSON.stringify(body),
  });
  await notifyAuthFailureIfNeeded(resp);
  if (!resp.ok) throw new Error(`${url} ${resp.status}`);
  const consume = (line: string): void => {
    if (!line) return;
    try { onLine(JSON.parse(line) as T); } catch { /* 容忍半行/坏行 */ }
  };
  // 非流式兜底：某些代理/CDN/WebView 会缓冲或剥离流式 body，则一次性读全文按行解析。
  if (!resp.body) {
    const text = await resp.text();
    for (const line of text.split('\n')) consume(line.trim());
    return;
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      consume(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  consume(buf.trim()); // 残行
}
