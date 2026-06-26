import { describe, it, expect, beforeEach, vi } from 'vitest';

// node 测试环境无 DOM：自带内存 localStorage，import state.ts 前先 stub（它的回填 IIFE 会读 localStorage）。
function makeLocalStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => { m.set(k, String(v)); },
    removeItem: (k: string): void => { m.delete(k); },
    clear: (): void => m.clear(),
  };
}

const PRODUCT_KEY = 'inkloop.prefs.v1';
const DEV_KEY = 'inkloop.devflags.v1';
const LEGACY_KEY = 'inkloop.settings.v1';

describe('设置持久化 reset / 迁移（C4 双键 + R2 收口）', () => {
  beforeEach(() => { vi.resetModules(); }); // 让每个用例重新跑 state.ts 的回填 IIFE

  it('resetSettings() 删产品键 + dev 键 + 旧扁平键三个', async () => {
    const ls = makeLocalStorage();
    ls.setItem(PRODUCT_KEY, JSON.stringify({ v: 1, data: {} }));
    ls.setItem(DEV_KEY, JSON.stringify({ v: 1, data: {} }));
    ls.setItem(LEGACY_KEY, JSON.stringify({ placement: 'left' }));
    vi.stubGlobal('localStorage', ls);

    const { resetSettings } = await import('./state');
    resetSettings();

    expect(ls.getItem(PRODUCT_KEY)).toBeNull();
    expect(ls.getItem(DEV_KEY)).toBeNull();
    expect(ls.getItem(LEGACY_KEY)).toBeNull(); // 关键：旧键也删，否则 reload 后回填 IIFE 会从它重导，等于没重置
  });

  it('首次升级：旧扁平键一次性迁到新双键，且吸收旧值', async () => {
    const ls = makeLocalStorage();
    ls.setItem(LEGACY_KEY, JSON.stringify({ placement: 'left', inferModel: 'kimi-test' }));
    vi.stubGlobal('localStorage', ls);

    const mod = await import('./state'); // import 即跑迁移 IIFE（!prod && !dev → 从 legacy 导入并 saveSettings）

    expect(ls.getItem(PRODUCT_KEY)).not.toBeNull();   // 新双键已落盘
    expect(ls.getItem(DEV_KEY)).not.toBeNull();
    expect((mod.settings as unknown as Record<string, unknown>).placement).toBe('left');     // 产品字段吸收
    expect((mod.settings as unknown as Record<string, unknown>).inferModel).toBe('kimi-test'); // dev 字段吸收
  });
});
