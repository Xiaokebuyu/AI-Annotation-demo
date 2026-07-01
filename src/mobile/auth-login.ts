/**
 * 移动版（电纸屏）二维码设备登录门禁——最小黑白实现。没有有效 session 时挂在最上层，
 * 有 session 后隐藏，让原有 app 照常运行。
 */
import QRCode from 'qrcode';
import { apiUrl, getJson, postJson } from '../core/api';
import { getSession, logout, onAuthChange, setSession, type InkLoopSession } from '../core/auth';

type DeviceAuthorization = {
  flow_id: string;
  device_id: string;
  poll_token: string;
  qr_payload: string;
  user_code: string;
  expires_at: number;
  interval_ms?: number;
};

type DeviceStatus = {
  flow_id: string;
  status: 'pending' | 'scanned' | 'authorized' | 'denied' | 'expired' | 'failed' | 'delivered';
  expires_at: number;
  scanned_at?: number;
  authorized_at?: number;
  error_code?: string;
  error_message?: string;
  session?: {
    session_id: string;
    session_token: string;
    tenant_id: string;
    user_id: string;
    device_id: string;
    expires_at: number;
  };
};

const INSTALL_KEY = 'inkloop.install_id.v1';

let mounted = false;
let flow: DeviceAuthorization | null = null;
let timer: number | undefined;

function installId(): string {
  let id = localStorage.getItem(INSTALL_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(INSTALL_KEY, id);
  }
  return id;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function setText(id: string, text: string): void {
  el(id).textContent = text;
}

function show(showLogin: boolean): void {
  document.body.classList.toggle('auth-open', showLogin);
  const gate = document.getElementById('auth-gate');
  if (gate) gate.hidden = !showLogin;
}

function statusText(s: DeviceStatus['status'] | 'idle'): string {
  switch (s) {
    case 'idle': return '待生成二维码';
    case 'pending': return '等待扫码';
    case 'scanned': return '已扫码，等待飞书授权';
    case 'authorized': return '已授权，正在写入登录态';
    case 'delivered': return '已领取';
    case 'denied': return '已拒绝';
    case 'expired': return '已过期';
    case 'failed': return '登录失败';
    default: return s;
  }
}

/**
 * 二维码本地生成（不经第三方服务）——扫码链接本身能触发"用任意飞书账号完成这次设备登录"，
 * 一旦交给外部图片服务渲染，对方（或链路上任何一环）能抢在真用户之前打开这个链接，
 * 把设备绑到攻击者自己的飞书身份上（设备扫码登录这类流程的已知劫持手法）。本地生成杜绝这条路径。
 */
async function renderFlow(f: DeviceAuthorization): Promise<void> {
  const img = el<HTMLImageElement>('auth-qr');
  img.src = await QRCode.toDataURL(f.qr_payload, { width: 240, margin: 1 });
  img.alt = f.user_code;
  setText('auth-code', f.user_code);
  const link = el<HTMLAnchorElement>('auth-link');
  link.href = apiUrl(f.qr_payload);
  link.textContent = f.qr_payload;
  setText('auth-status', statusText('pending'));
  setText('auth-expire', `有效至 ${new Date(f.expires_at).toLocaleTimeString()}`);
}

async function createFlow(): Promise<void> {
  window.clearTimeout(timer);
  setText('auth-status', '正在生成二维码');
  flow = await postJson<DeviceAuthorization>('/api/inkloop/auth/device-authorizations', {
    install_id: installId(),
    device_label: navigator.userAgent.includes('Android') ? 'InkLoop Android' : 'InkLoop Web',
    platform: navigator.userAgent.includes('Android') ? 'android-webview' : 'web',
    requested_scopes: ['device_session'],
  }, { auth: false });
  await renderFlow(flow);
  schedulePoll(300);
}

function schedulePoll(ms: number): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void poll(), ms);
}

async function poll(): Promise<void> {
  if (!flow) return;
  if (Date.now() > flow.expires_at) {
    setText('auth-status', statusText('expired'));
    return;
  }
  try {
    const qs = new URLSearchParams({ poll_token: flow.poll_token });
    const st = await getJson<DeviceStatus>(`/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/status?${qs}`, { auth: false });
    setText('auth-status', statusText(st.status));
    if (st.status === 'authorized' && st.session) {
      const session: InkLoopSession = {
        sessionId: st.session.session_id,
        sessionToken: st.session.session_token,
        tenantId: st.session.tenant_id,
        userId: st.session.user_id,
        deviceId: st.session.device_id,
        expiresAt: st.session.expires_at,
      };
      setSession(session);
      await postJson('/api/inkloop/auth/device-authorizations/' + encodeURIComponent(flow.flow_id) + '/ack', {
        poll_token: flow.poll_token,
      }, { auth: false, acceptStatuses: [409] });
      show(false);
      flow = null;
      return;
    }
    if (st.status === 'denied' || st.status === 'expired' || st.status === 'failed') {
      setText('auth-status', st.error_message || statusText(st.status));
      return;
    }
    schedulePoll(flow.interval_ms || 2000);
  } catch (e) {
    setText('auth-status', String((e as Error)?.message || e));
    schedulePoll(3000);
  }
}

export function initMobileAuthLogin(): void {
  if (mounted) return;
  mounted = true;

  const gate = document.getElementById('auth-gate');
  if (!gate) return;
  el('auth-refresh').addEventListener('click', () => void createFlow());
  el('auth-logout').addEventListener('click', () => logout());
  document.addEventListener('inkloop:reauth-required', () => { show(true); void createFlow(); });
  onAuthChange((ev) => {
    if (ev.kind === 'login') show(false);
    if (ev.kind === 'reauth_required' || ev.kind === 'logout') { show(true); void createFlow(); }
  });

  const session = getSession();
  if (session) {
    show(false);
  } else {
    show(true);
    void createFlow();
  }
}
