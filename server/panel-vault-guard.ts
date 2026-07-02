/**
 * panel vault 代理「fail-closed 路由白名单」（dev vite proxy 与生产 standalone.ts 共用·防两边行为漂移）。
 *
 * 为什么需要：代理会给转发请求注入 server↔server 的 x-inkloop-secret。若不限路由、不规范化路径，
 * 客户端可构造 `/api/panel-vault/../feishu/...`（URL 规范化后逃出 vault 子树）把密钥权限打到 panel 其它端点
 * ——这违反「设备绝不持有 panel 权限」的边界（confused-deputy）。本守卫把代理收成**只做这 3 件事**：
 *   POST /users/<forceUser>/releases · GET /users/<forceUser>/releases/latest · GET /users/<forceUser>/blobs/sha256/<hex64>
 * 且 forceUser 未配置即 503（fail-closed·不透传客户端 userId·不越桶）。
 */
export type PanelVaultRoute = { rest: string; releasePost: boolean };

export class PanelVaultGuardError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const HEX64 = /^[a-f0-9]{64}$/i;
const fail = (status: number, message: string): never => { throw new PanelVaultGuardError(status, message); };

function decodePart(s: string): string {
  try { return decodeURIComponent(s); } catch { return fail(400, 'vault path encoding invalid'); }
}

function cleanParts(rawRest: string): string[] {
  if (!rawRest.startsWith('/') || rawRest.startsWith('//')) fail(400, '非法 vault 路径');
  if (rawRest.includes('\\') || /[\0\r\n]/.test(rawRest)) fail(400, '非法 vault 路径字符');
  if (/[?#]/.test(rawRest)) fail(400, 'vault 路径不接受 query/fragment');
  const parts = rawRest.split('/').slice(1).map(decodePart);
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\0\r\n\\]/.test(p))) fail(400, '非法 vault 路径段');
  return parts;
}

/** rawRest=去掉 /api/panel-vault 前缀后的剩余。返回规范化后只含白名单路由的 rest（拼到 PANEL_VAULT_BASE）。 */
export function guardPanelVaultRest(rawRest: string, method = 'GET', forceUser = ''): PanelVaultRoute {
  if (!forceUser) fail(503, 'INKLOOP_USER_ID 未配置'); // fail-closed：没配 user 就不放行（不透传客户端 userId）
  const verb = method.toUpperCase();
  const parts = cleanParts(rawRest || '/');
  if (parts[0] !== 'users' || !parts[1]) fail(404, 'no such vault route');
  if (parts[1] !== forceUser) fail(403, `userId mismatch: expected ${forceUser}`); // 显式拒绝越桶（非静默改写）
  const user = encodeURIComponent(forceUser);
  if (verb === 'POST' && parts.length === 3 && parts[2] === 'releases') return { rest: `/users/${user}/releases`, releasePost: true };
  if (verb === 'GET' && parts.length === 4 && parts[2] === 'releases' && parts[3] === 'latest') return { rest: `/users/${user}/releases/latest`, releasePost: false };
  if (verb === 'GET' && parts.length === 5 && parts[2] === 'blobs' && parts[3] === 'sha256' && HEX64.test(parts[4])) return { rest: `/users/${user}/blobs/sha256/${parts[4].toLowerCase()}`, releasePost: false };
  return fail(404, 'no such vault route');
}

/** 同上·但入参是完整 req.url（含 /api/panel-vault 前缀）。 */
export function guardPanelVaultReqUrl(reqUrl: string, method = 'GET', forceUser = ''): PanelVaultRoute {
  const prefix = '/api/panel-vault';
  if (reqUrl !== prefix && !reqUrl.startsWith(`${prefix}/`)) fail(404, 'no such vault route');
  return guardPanelVaultRest(reqUrl.slice(prefix.length) || '/', method, forceUser);
}

/** release POST 空包闸（防把 Obsidian 端冲成空 vault·客户端已挡·此为代理层兜底）。 */
export function assertNonEmptyVaultRelease(body: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { fail(400, 'release JSON 非法'); }
  const p = parsed as { manifest?: { files?: unknown }; files?: unknown };
  const manifestFiles = p.manifest?.files;
  const files = p.files;
  if (!Array.isArray(manifestFiles) || !Array.isArray(files) || !manifestFiles.length || !files.length) fail(400, '空 release 未上传');
  else if (manifestFiles.length !== files.length) fail(400, 'manifest.files 与 files 数量不一致');
}

/** PanelVaultGuardError → {status,error}；非该类返回 null（让调用方走原兜底）。 */
export function panelVaultGuardPayload(e: unknown): { status: number; error: string } | null {
  return e instanceof PanelVaultGuardError ? { status: e.status, error: e.message } : null;
}
