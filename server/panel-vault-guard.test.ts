import { describe, expect, it } from 'vitest';
import { PanelVaultGuardError, assertNonEmptyVaultRelease, guardPanelVaultRest, guardPanelVaultReqUrl } from './panel-vault-guard';

const HEX = 'a'.repeat(64);
/** 断言守卫抛出指定 HTTP 状态（安全行为以「拒绝」为正）。 */
const expectStatus = (fn: () => unknown, status: number): void => {
  try { fn(); throw new Error('expected throw'); }
  catch (e) { expect(e).toBeInstanceOf(PanelVaultGuardError); expect((e as PanelVaultGuardError).status).toBe(status); }
};

describe('guardPanelVaultRest · fail-closed + 白名单', () => {
  it('未配 forceUser → 503（绝不透传客户端 userId）', () => expectStatus(() => guardPanelVaultRest('/users/x/releases', 'POST', ''), 503));
  it('user 不匹配 forceUser → 403（防越桶·非静默改写）', () => expectStatus(() => guardPanelVaultRest('/users/other/releases', 'POST', 'edy'), 403));
  it('合法 POST /users/<u>/releases', () => expect(guardPanelVaultRest('/users/edy/releases', 'POST', 'edy')).toEqual({ rest: '/users/edy/releases', releasePost: true }));
  it('合法 GET /users/<u>/releases/latest', () => expect(guardPanelVaultRest('/users/edy/releases/latest', 'GET', 'edy')).toEqual({ rest: '/users/edy/releases/latest', releasePost: false }));
  it('合法 GET /users/<u>/blobs/sha256/<hex64>（小写化）', () => expect(guardPanelVaultRest(`/users/edy/blobs/sha256/${HEX.toUpperCase()}`, 'GET', 'edy')).toEqual({ rest: `/users/edy/blobs/sha256/${HEX}`, releasePost: false }));
  it('GET 打 POST-only releases → 404', () => expectStatus(() => guardPanelVaultRest('/users/edy/releases', 'GET', 'edy'), 404));
  it('非白名单路由 → 404', () => expectStatus(() => guardPanelVaultRest('/users/edy/bogus', 'GET', 'edy'), 404));
  it('blob 非 hex64 → 404', () => expectStatus(() => guardPanelVaultRest('/users/edy/blobs/sha256/zzz', 'GET', 'edy'), 404));
});

describe('guardPanelVaultRest · confused-deputy 防逃逸', () => {
  it('明文 .. 段 → 400（防 fetch URL 规范化逃出 vault 子树）', () => expectStatus(() => guardPanelVaultRest('/users/edy/../feishu/minutes', 'GET', 'edy'), 400));
  it('编码 %2e%2e → 400（decode 后再查段）', () => expectStatus(() => guardPanelVaultRest('/users/edy/%2e%2e/feishu', 'GET', 'edy'), 400));
  it('双斜杠 //users → 400', () => expectStatus(() => guardPanelVaultRest('//users/edy/releases', 'POST', 'edy'), 400));
  it('反斜杠 → 400', () => expectStatus(() => guardPanelVaultRest('/users/edy\\releases', 'POST', 'edy'), 400));
  it('query/fragment → 400', () => expectStatus(() => guardPanelVaultRest('/users/edy/releases/latest?x=1', 'GET', 'edy'), 400));
});

describe('guardPanelVaultReqUrl · 完整 url（standalone 用）', () => {
  it('剥 /api/panel-vault 前缀后等价', () => expect(guardPanelVaultReqUrl('/api/panel-vault/users/edy/releases/latest', 'GET', 'edy')).toEqual({ rest: '/users/edy/releases/latest', releasePost: false }));
  it('非 /api/panel-vault 前缀 → 404', () => expectStatus(() => guardPanelVaultReqUrl('/api/other', 'GET', 'edy'), 404));
});

describe('assertNonEmptyVaultRelease · 空包闸', () => {
  it('空 files → 400（防把 Obsidian 冲成空 vault）', () => expectStatus(() => assertNonEmptyVaultRelease('{"manifest":{"files":[]},"files":[]}'), 400));
  it('manifest/files 数量不符 → 400', () => expectStatus(() => assertNonEmptyVaultRelease('{"manifest":{"files":[{},{}]},"files":[{}]}'), 400));
  it('非法 JSON → 400', () => expectStatus(() => assertNonEmptyVaultRelease('not json'), 400));
  it('合法非空 → 不抛', () => expect(() => assertNonEmptyVaultRelease('{"manifest":{"files":[{"path":"a"}]},"files":[{"path":"a"}]}')).not.toThrow());
});
