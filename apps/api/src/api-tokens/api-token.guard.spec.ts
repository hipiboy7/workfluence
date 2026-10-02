import { ForbiddenException, HttpException, ServiceUnavailableException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER, type ApiTokenScope } from '@workfluence/shared';
import { describe, expect, it, vi } from 'vitest';
import { CsrfGuard, type SessionUser } from '../auth/auth.guard';
import { ApiTokenGuard } from './api-token.guard';
import { ApiTokensService, type ApiAuthResult } from './api-tokens.service';

/**
 * 공개 API 가드 (docs/spinoff/public-api 계획서 4.1·4.2절). 토큰 인증은 대역이다 — 볼 것은 "어떤 조건에서 막는가"다.
 * 인증 자체(행·사용자·서명)는 `api-tokens.integration.spec.ts`가 실제 PostgreSQL로 본다.
 */

const MEMBER: SessionUser = { id: 'u1', username: 'alice', displayName: '앨리스', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
const ADMIN: SessionUser = { ...MEMBER, id: 'a1', role: 'admin' };

function ctx(opts: { method?: string; auth?: string; meta?: Record<string, unknown>; session?: unknown }) {
  const req: Record<string, unknown> = {
    method: opts.method ?? 'GET',
    headers: opts.auth === undefined ? {} : { authorization: opts.auth },
    session: opts.session,
  };
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => (opts.meta ?? {})[key as string] as never);
  return {
    req,
    reflector,
    exec: { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as unknown as ExecutionContext,
  };
}

const tokensOf = (r: ApiAuthResult) => ({ authenticate: vi.fn().mockResolvedValue(r) }) as unknown as ApiTokensService;
const ok = (user: SessionUser, scopes: ApiTokenScope[]): ApiAuthResult => ({ ok: true, user, scopes, tokenId: 't1' });

async function codeOf(p: Promise<unknown>): Promise<[number, string]> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(HttpException);
  const h = e as HttpException;
  return [h.getStatus(), (h.getResponse() as { code: string }).code];
}

describe('ApiTokenGuard — 인증', () => {
  it('@Public이면 토큰 없이 통과한다 (상태 확인·명세)', async () => {
    const c = ctx({ meta: { 'wf:public': true } });
    await expect(new ApiTokenGuard(c.reflector, tokensOf(ok(MEMBER, ['read']))).canActivate(c.exec)).resolves.toBe(true);
  });

  it.each([undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer'])('Authorization %j → 401 TOKEN_MISSING', async (auth) => {
    const c = ctx({ auth });
    expect(await codeOf(new ApiTokenGuard(c.reflector, tokensOf(ok(MEMBER, ['read']))).canActivate(c.exec))).toEqual([401, 'TOKEN_MISSING']);
  });

  it('**세션 쿠키가 있어도 토큰이 없으면 401** — 공개 API는 세션을 보지 않는다(그래서 CSRF가 닿지 않는다)', async () => {
    const c = ctx({ session: { userId: 'u1', createdAt: Date.now() } });
    expect(await codeOf(new ApiTokenGuard(c.reflector, tokensOf(ok(MEMBER, ['read']))).canActivate(c.exec))).toEqual([401, 'TOKEN_MISSING']);
  });

  it.each(['TOKEN_INVALID', 'TOKEN_UNKNOWN', 'TOKEN_REVOKED', 'TOKEN_EXPIRED', 'ACCOUNT_INACTIVE'] as const)('%s → 401 그 코드', async (code) => {
    const c = ctx({ auth: 'Bearer x.y.z' });
    expect(await codeOf(new ApiTokenGuard(c.reflector, tokensOf({ ok: false, code })).canActivate(c.exec))).toEqual([401, code]);
  });

  it('비밀번호 변경이 강제되면 403 PASSWORD_CHANGE_REQUIRED — 누구인지는 맞다', async () => {
    const c = ctx({ auth: 'Bearer x.y.z' });
    const e = new ApiTokenGuard(c.reflector, tokensOf({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED' })).canActivate(c.exec);
    expect(await codeOf(e)).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
  });

  it('공개 API가 꺼져 있으면 503 API_DISABLED', async () => {
    const c = ctx({ auth: 'Bearer x.y.z' });
    const e = await new ApiTokenGuard(c.reflector, tokensOf({ ok: false, code: 'API_DISABLED' })).canActivate(c.exec).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ServiceUnavailableException);
  });

  it('통과하면 요청에 사용자와 토큰을 싣는다 — 컨트롤러는 화면용과 같은 `@CurrentUser`를 쓴다', async () => {
    const c = ctx({ auth: 'Bearer x.y.z' });
    const tokens = tokensOf(ok(MEMBER, ['read']));
    await expect(new ApiTokenGuard(c.reflector, tokens).canActivate(c.exec)).resolves.toBe(true);
    expect(tokens.authenticate).toHaveBeenCalledWith('x.y.z');
    expect(c.req.user).toEqual(MEMBER);
    expect(c.req.apiToken).toEqual({ id: 't1', scopes: ['read'] });
  });
});

describe('ApiTokenGuard — scope', () => {
  it('read 토큰은 읽기만', async () => {
    const g = (method: string) => {
      const c = ctx({ method, auth: 'Bearer t' });
      return new ApiTokenGuard(c.reflector, tokensOf(ok(MEMBER, ['read']))).canActivate(c.exec);
    };
    await expect(g('GET')).resolves.toBe(true);
    expect(await codeOf(g('POST'))).toEqual([403, 'INSUFFICIENT_SCOPE']);
    expect(await codeOf(g('DELETE'))).toEqual([403, 'INSUFFICIENT_SCOPE']);
  });

  it('write 토큰은 읽기·쓰기', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const c = ctx({ method, auth: 'Bearer t' });
      await expect(new ApiTokenGuard(c.reflector, tokensOf(ok(MEMBER, ['write']))).canActivate(c.exec)).resolves.toBe(true);
    }
  });

  it('관리 경로는 admin scope가 따로 있어야 한다 — 관리자의 write 토큰으로도 안 된다', async () => {
    const c = ctx({ method: 'POST', auth: 'Bearer t', meta: { 'wf:api-admin': true } });
    expect(await codeOf(new ApiTokenGuard(c.reflector, tokensOf(ok(ADMIN, ['write']))).canActivate(c.exec))).toEqual([403, 'INSUFFICIENT_SCOPE']);
  });

  it('admin scope가 있어도 읽기·쓰기 scope는 따로 본다', async () => {
    const c = ctx({ method: 'POST', auth: 'Bearer t', meta: { 'wf:api-admin': true } });
    expect(await codeOf(new ApiTokenGuard(c.reflector, tokensOf(ok(ADMIN, ['read', 'admin']))).canActivate(c.exec))).toEqual([403, 'INSUFFICIENT_SCOPE']);
  });

  it('admin·write면 관리 경로의 쓰기가 된다', async () => {
    const c = ctx({ method: 'POST', auth: 'Bearer t', meta: { 'wf:api-admin': true, 'wf:action': 'user.manage' } });
    await expect(new ApiTokenGuard(c.reflector, tokensOf(ok(ADMIN, ['write', 'admin']))).canActivate(c.exec)).resolves.toBe(true);
  });
});

describe('ApiTokenGuard — 권한은 사람의 것', () => {
  it('scope가 넉넉해도 사람이 못 하는 일은 403 FORBIDDEN — 토큰은 권한을 늘리지 않는다', async () => {
    const c = ctx({ method: 'POST', auth: 'Bearer t', meta: { 'wf:api-admin': true, 'wf:action': 'user.manage' } });
    const e = new ApiTokenGuard(c.reflector, tokensOf(ok(MEMBER, ['read', 'write', 'admin']))).canActivate(c.exec);
    expect(await codeOf(e)).toEqual([403, 'FORBIDDEN']);
  });

  it('위임받은 행위는 된다 — 판정은 같은 `can()`이다', async () => {
    const c = ctx({ method: 'POST', auth: 'Bearer t', meta: { 'wf:action': 'category.manage' } });
    const delegated = { ...MEMBER, grants: ['category.manage' as const] };
    await expect(new ApiTokenGuard(c.reflector, tokensOf(ok(delegated, ['write']))).canActivate(c.exec)).resolves.toBe(true);
  });
});

describe('CsrfGuard — 공개 API 경로', () => {
  const csrf = (method: string, path: string, headers: Record<string, string> = {}) =>
    new CsrfGuard().canActivate({ switchToHttp: () => ({ getRequest: () => ({ method, path, headers }) }) } as unknown as ExecutionContext);

  it('/api/v1의 쓰기는 CSRF 헤더 없이 지나간다 — 가드가 Bearer만 받는다', () => {
    expect(csrf('POST', '/api/v1/pages')).toBe(true);
    expect(csrf('DELETE', '/api/v1/comments/abc')).toBe(true);
  });

  it('화면용 경로는 그대로 헤더를 요구한다', () => {
    expect(() => csrf('POST', '/api/pages')).toThrow(ForbiddenException);
    expect(csrf('POST', '/api/pages', { [CSRF_HEADER]: '1' })).toBe(true);
  });

  it.each(['/api/v1/../pages', '/api/v1/./x/../../auth/logout', '/api/v10/pages', '/api/v1pages', '/api/v1/%2e%2e/pages'])(
    '%s는 공개 API로 치지 않는다',
    (path) => {
      expect(() => csrf('POST', path)).toThrow(ForbiddenException);
    },
  );
});

describe('UnauthorizedException과 구분', () => {
  it('401은 UnauthorizedException이다 — Nest 기본 처리와 같은 상태', async () => {
    const c = ctx({});
    const e = await new ApiTokenGuard(c.reflector, tokensOf(ok(MEMBER, ['read']))).canActivate(c.exec).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnauthorizedException);
  });
});
