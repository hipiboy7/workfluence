import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMITS } from '@workfluence/shared';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitGuard, RateLimitStore } from '../common/rate-limit.guard';
import { RevocationBus } from '../common/revocation.bus';
import { AuthController } from './auth.module';
import { AuthService } from './auth.service';

/**
 * 컨트롤러의 **배선** (P13 좁은 자체 점검 3·6·8). 서비스 시험은 서비스를 직접 부르므로, 컨트롤러가 무엇을 언제 넘기는지는 보지 않았다 —
 * 로그인이 세션을 계정의 줄 **안에서** 만들게 넘기는 것을 "로그인 뒤에 세션"으로 되돌려도 모든 시험이 초록이었다. 서비스는 가짜로, 세션은
 * `express-session`처럼 `regenerate`가 새 세션으로 갈아 끼우는 가짜로 둔다
 */

type FakeSession = Record<string, unknown> & { regenerate(cb: (e?: Error) => void): void; save(cb: (e?: Error) => void): void };
type FakeReq = { ip: string; sessionID: string; session: FakeSession };

/** 한 요청 — 무슨 일이 어떤 순서로 있었는지 `log`에 적는다. 컨트롤러에는 `http`를 넘긴다 */
function fakeReq(initial: Record<string, unknown> = {}) {
  const log: string[] = [];
  const req: FakeReq = { ip: '127.0.0.1', sessionID: 'old-sid', session: {} as FakeSession };
  const session = (data: Record<string, unknown>): FakeSession => ({
    ...data,
    regenerate(cb) {
      log.push('regenerate');
      req.sessionID = 'new-sid';
      req.session = session({}); // 옛 세션의 값은 따라오지 않는다
      cb();
    },
    save(cb) {
      log.push(`save:${req.sessionID}`);
      cb();
    },
  });
  req.session = session(initial);
  return { req, http: req as unknown as Request, log };
}

const USER = { id: 'u1', username: 'alice', displayName: '앨리스', role: 'member', mustChangePassword: false, grants: [], passwordHash: 'x' };

function controller(auth: Partial<AuthService>, store = new RateLimitStore()) {
  return new AuthController(auth as AuthService, {} as never, store, new RevocationBus(), {} as never, {} as never);
}

describe('AuthController — 배선', () => {
  it('**로그인은 세션을 그 계정의 줄 안에서 만든다** — 서비스가 줄을 놓기 전에 세션이 새 ID로 저장돼 있다 (D.4, 좁은 자체 점검 8)', async () => {
    const { req, http, log } = fakeReq();
    const login = vi.fn(async (_dto: unknown, _ip?: string, begin?: (u: never) => Promise<void>) => {
      expect(log).toEqual([]); // 줄에 들기 전에는 아무것도 없다
      await begin!(USER as never);
      expect(log).toEqual(['regenerate', 'save:new-sid']); // 줄 안에서 — 서비스가 돌아가기 전에
      log.push('login-returned');
      return USER as never;
    });
    await expect(controller({ login } as never).login({ username: 'alice', password: 'pw' } as never, http)).resolves.toMatchObject({ id: 'u1' });
    expect(log).toEqual(['regenerate', 'save:new-sid', 'login-returned']); // 돌아온 뒤에 또 만들지 않는다
    expect(req.session.userId).toBe('u1');
  });

  it('**OIDC 시작은 세션을 새로 받아 거기에 일회용 값을 둔다** — 불러온 세션에 넣어 저장하면 그 사이 지운 세션이 사용자째 되살아난다 (좁은 자체 점검 3)', async () => {
    const { req, http, log } = fakeReq({ userId: 'victim', createdAt: 1 });
    const oidcStart = vi.fn(async () => ({ url: '/idp/authorize', state: 's', nonce: 'n', verifier: 'v' }));
    await expect(controller({ oidcStart } as never).oidcStart(http)).resolves.toEqual({ url: '/idp/authorize' });
    expect(log).toEqual(['regenerate', 'save:new-sid']);
    expect(req.session.userId).toBeUndefined();
    expect(req.session.createdAt).toBeUndefined();
    expect(req.session).toMatchObject({ oidcState: 's', oidcNonce: 'n', oidcVerifier: 'v' });
  });

  it('OIDC가 꺼져 있으면 세션을 건드리지 않는다 — 서비스가 먼저 거절한다', async () => {
    const { req, http, log } = fakeReq({ userId: 'u1' });
    const oidcStart = vi.fn(async () => {
      throw new Error('OIDC가 꺼져 있다');
    });
    await expect(controller({ oidcStart } as never).oidcStart(http)).rejects.toThrow(/OIDC/);
    expect(log).toEqual([]);
    expect(req.session.userId).toBe('u1');
  });

  it('**비밀번호 변경은 IP별로 센다** — 분당 5건을 넘으면 429. 성공한 것은 돌려주고, 실패한 것은 남긴다 (좁은 자체 점검 6)', async () => {
    const store = new RateLimitStore();
    const guard = new RateLimitGuard(new Reflector(), store);
    const ctx = (req: Request) =>
      ({
        getHandler: () => AuthController.prototype.changePassword,
        getClass: () => AuthController,
        switchToHttp: () => ({ getRequest: () => req }),
      }) as unknown as ExecutionContext;
    const key = 'AuthController.changePassword:127.0.0.1';
    const dto = { currentPassword: 'old-pw', newPassword: 'New-pw-2026' } as never;
    const user = { id: 'u1' } as never;

    // 성공 — 센 것을 돌려준다
    const ok = fakeReq();
    expect(guard.canActivate(ctx(ok.http))).toBe(true);
    expect(store.countFor(key)).toBe(1);
    await controller({ changePassword: vi.fn(async () => undefined) } as never, store).changePassword(dto, user, ok.http);
    expect(store.countFor(key)).toBe(0);

    // 실패(틀린 현재 비밀번호) — 남는다. 다섯 번째까지 들이고 여섯 번째를 막는다
    const failing = controller({ changePassword: vi.fn(async () => Promise.reject(new Error('현재 비밀번호가 올바르지 않다'))) } as never, store);
    for (let i = 0; i < RATE_LIMITS.changePassword.max; i++) {
      const { http } = fakeReq();
      expect(guard.canActivate(ctx(http))).toBe(true);
      await expect(failing.changePassword(dto, user, http)).rejects.toThrow(/올바르지 않다/);
    }
    expect(store.countFor(key)).toBe(RATE_LIMITS.changePassword.max);
    expect(() => guard.canActivate(ctx(fakeReq().http))).toThrow(/너무 잦다/);
  });
});
