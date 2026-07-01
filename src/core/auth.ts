/**
 * 设备侧 session 存取（阶段C·二维码设备登录）。
 * 存 localStorage：能扛住安卓 WebView 进程重启，且 api.ts 注入 header 时能同步取到。
 * panel 那边只存 token 的 hash，这份明文只存在设备本地（localStorage）+ 传输过程中。
 */

export interface InkLoopSession {
  sessionId: string;
  sessionToken: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  expiresAt: number;
}

type AuthEvent = { kind: 'login' | 'logout' | 'reauth_required'; session: InkLoopSession | null; reason?: string };
type AuthListener = (event: AuthEvent) => void;

const KEY = 'inkloop.device.session.v1';
const listeners = new Set<AuthListener>();

function normalize(raw: unknown): InkLoopSession | null {
  const x = raw as Partial<InkLoopSession> | null;
  if (!x || typeof x !== 'object') return null;
  if (!x.sessionId || !x.sessionToken || !x.tenantId || !x.userId || !x.deviceId || !Number.isFinite(Number(x.expiresAt))) return null;
  return {
    sessionId: String(x.sessionId),
    sessionToken: String(x.sessionToken),
    tenantId: String(x.tenantId),
    userId: String(x.userId),
    deviceId: String(x.deviceId),
    expiresAt: Number(x.expiresAt),
  };
}

function emit(event: AuthEvent): void {
  for (const fn of listeners) {
    try { fn(event); } catch { /* 监听器出错不该连累调用方 */ }
  }
}

export function onAuthChange(fn: AuthListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSession(): InkLoopSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const session = normalize(JSON.parse(raw));
    if (!session) { localStorage.removeItem(KEY); return null; }
    if (session.expiresAt <= Date.now()) {
      localStorage.removeItem(KEY);
      emit({ kind: 'reauth_required', session: null, reason: 'expired' });
      return null;
    }
    return session;
  } catch {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    return null;
  }
}

export function setSession(session: InkLoopSession): void {
  const normalized = normalize(session);
  if (!normalized) throw new Error('invalid InkLoop session');
  localStorage.setItem(KEY, JSON.stringify(normalized));
  emit({ kind: 'login', session: normalized });
}

export function clearSession(reason = 'logout'): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  emit({ kind: reason === 'reauth_required' ? 'reauth_required' : 'logout', session: null, reason });
}

export function logout(): void {
  clearSession('logout');
}

export function isLoggedIn(): boolean {
  return !!getSession();
}

export function sessionUserId(): string | null {
  return getSession()?.userId ?? null;
}

export function sessionDeviceId(): string | null {
  return getSession()?.deviceId ?? null;
}

export function sessionToken(): string | null {
  return getSession()?.sessionToken ?? null;
}

export function authHeaders(): Record<string, string> {
  const token = sessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function handleAuthFailure(reason = 'reauth_required'): void {
  clearSession(reason);
  document.dispatchEvent(new CustomEvent('inkloop:reauth-required', { detail: { reason } }));
}
