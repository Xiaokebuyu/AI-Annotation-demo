import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultRelease } from './vault-release';
import { fetchLatestRelease, publishVaultRelease } from './vault-publish';

const release: VaultRelease = {
  manifest: { schema_version: 'inkloop.vault_release.v1', generated_at: 'x', app_version: 'd', release_hash: 'sha256:ab', files: [{ path: 'InkLoop/a.md', content_hash: 'sha256:cd', bytes: 3 }] },
  files: [{ path: 'InkLoop/a.md', markdown: 'abc' }],
};

afterEach(() => vi.restoreAllMocks());

describe('vault-publish client', () => {
  it('publishVaultRelease → POST per-user releases·带 manifest/files/device_id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, release_id: 'r1', file_count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = await publishVaultRelease(release, { userId: 'u_demo', deviceId: 'mac' });
    expect(r.release_id).toBe('r1');
    // 断言路径后缀（不锁整串）：core/api 在生产/设备构建会前缀 VITE_API_BASE_URL，dev 同源为空——测试对 base 中立。
    expect(calls[0].url.endsWith('/api/panel-vault/users/u_demo/releases')).toBe(true);
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.manifest.release_hash).toBe('sha256:ab');
    expect(body.files).toHaveLength(1);
    expect(body.device_id).toBe('mac');
  });

  it('userId 进路径做 encodeURIComponent', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await publishVaultRelease(release, { userId: 'u/evil' });
    expect(calls[0].endsWith('/api/panel-vault/users/u%2Fevil/releases')).toBe(true);
  });

  it('fetchLatestRelease → GET latest', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ release: {}, manifest: {}, assets: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await fetchLatestRelease('u_demo');
    expect(calls[0].endsWith('/api/panel-vault/users/u_demo/releases/latest')).toBe(true);
  });

  it('非 2xx → 抛（postJson 行为）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(publishVaultRelease(release, { userId: 'u_demo' })).rejects.toThrow();
  });
});
