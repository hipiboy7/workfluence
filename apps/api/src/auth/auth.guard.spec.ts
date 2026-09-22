import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@workfluence/shared';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../db/schema';
import { AuthGuard, CsrfGuard } from './auth.guard';

/**
 * 가드는 보안 경계다 (P1_설계서_Auth 4절·7절). 여기서 뚫리면 뒤가 전부 무의미해진다.
 * 세션과 사용자 조회는 대역을 쓴다 — 볼 것은 "어떤 조건에서 막는가"이지 DB가 아니다.
 */

const ACTIVE: Partial<UserRow> = {
  id: 'u1',
  username: 'alice',
  displayName: '앨리스',
  role: 'member',
  status: 'active',
  mustChangePassword: false,
};

function ctx(session: Record<string, unknown> | undefined, meta: Record<string, unknown> = {}) {
  const destroy = vi.fn((cb: () => void) => cb());
  const req: Record<string, unknown> = { session: session ? { ...session, destroy } : undefined };
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => meta[key as string] as never);
  return {
    reflector,
    destroy,
    req,
    exec: { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as unknown as ExecutionContext,
  };
}

const usersOf = (u: Partial<UserRow> | undefined) => ({ findById: vi.fn().mockResolvedValue(u) }) as unknown as UsersService;
const ENV = { WF_SESSION_ABSOLUTE_HOURS: 12 } as never;

/** 정책은 대역이다. 이 테스트가 보는 것은 **세션 판정**이지 값의 출처가 아니다 */
const POLICY_STUB = { get: async () => ({ sessionIdleMinutes: 30, sessionAbsoluteHours: 12 }) } as never;

describe('AuthGuard', () => {
  it('세션이 없으면 401', async () => {
    const c = ctx(undefined);
    await expect(new AuthGuard(c.reflector, usersOf(ACTIVE), ENV, POLICY_STUB).canActivate(c.exec)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('userId가 없으면 401', async () => {
    const c = ctx({});
    await expect(new AuthGuard(c.reflector, usersOf(ACTIVE), ENV, POLICY_STUB).canActivate(c.exec)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('@Public이면 세션 없이 통과한다', async () => {
    const c = ctx(undefined, { 'wf:public': true });
    await expect(new AuthGuard(c.reflector, usersOf(undefined), ENV, POLICY_STUB).canActivate(c.exec)).resolves.toBe(true);
  });

  it('절대 타임아웃을 넘으면 세션을 파기하고 401 (FR-223)', async () => {
    const c = ctx({ userId: 'u1', createdAt: Date.now() - 13 * 3600_000 });
    await expect(new AuthGuard(c.reflector, usersOf(ACTIVE), ENV, POLICY_STUB).canActivate(c.exec)).rejects.toThrow(/절대 타임아웃/);
    expect(c.destroy).toHaveBeenCalled();
  });

  it('createdAt이 아예 없으면 만료로 본다 — 모르는 세션을 통과시키지 않는다', async () => {
    const c = ctx({ userId: 'u1' });
    await expect(new AuthGuard(c.reflector, usersOf(ACTIVE), ENV, POLICY_STUB).canActivate(c.exec)).rejects.toThrow(/절대 타임아웃/);
  });

  it('계정이 없어졌거나 비활성이면 세션을 파기하고 401', async () => {
    for (const u of [undefined, { ...ACTIVE, status: 'pending' }]) {
      const c = ctx({ userId: 'u1', createdAt: Date.now() });
      await expect(new AuthGuard(c.reflector, usersOf(u), ENV, POLICY_STUB).canActivate(c.exec)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(c.destroy).toHaveBeenCalled();
    }
  });

  it('정상 세션은 통과하고 req.user를 채운다', async () => {
    const c = ctx({ userId: 'u1', createdAt: Date.now() });
    await expect(new AuthGuard(c.reflector, usersOf(ACTIVE), ENV, POLICY_STUB).canActivate(c.exec)).resolves.toBe(true);
    expect(c.req.user).toMatchObject({ id: 'u1', username: 'alice', role: 'member' });
  });

  it('비밀번호 변경이 강제면 막는다 (FR-207)', async () => {
    const c = ctx({ userId: 'u1', createdAt: Date.now() });
    const guard = new AuthGuard(c.reflector, usersOf({ ...ACTIVE, mustChangePassword: true }), ENV, POLICY_STUB);
    await expect(guard.canActivate(c.exec)).rejects.toBeInstanceOf(ForbiddenException);
    try {
      await guard.canActivate(c.exec);
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    }
  });

  it('@AllowPendingPasswordChange면 변경 강제 중에도 통과한다 — 아니면 빠져나올 수 없다', async () => {
    const c = ctx({ userId: 'u1', createdAt: Date.now() }, { 'wf:allow-pending-password': true });
    const guard = new AuthGuard(c.reflector, usersOf({ ...ACTIVE, mustChangePassword: true }), ENV, POLICY_STUB);
    await expect(guard.canActivate(c.exec)).resolves.toBe(true);
  });

  it('요구 행위에 권한이 없으면 403 — 판정은 shared의 can()이 한다', async () => {
    const c = ctx({ userId: 'u1', createdAt: Date.now() }, { 'wf:action': 'user.manage' });
    await expect(new AuthGuard(c.reflector, usersOf(ACTIVE), ENV, POLICY_STUB).canActivate(c.exec)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('권한이 있으면 통과한다', async () => {
    const c = ctx({ userId: 'u1', createdAt: Date.now() }, { 'wf:action': 'user.manage' });
    await expect(new AuthGuard(c.reflector, usersOf({ ...ACTIVE, role: 'admin' }), ENV, POLICY_STUB).canActivate(c.exec)).resolves.toBe(true);
  });
});

describe('CsrfGuard (FR-240)', () => {
  const call = (method: string, headers: Record<string, string> = {}) =>
    new CsrfGuard().canActivate({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) } as unknown as ExecutionContext);

  it('읽기는 헤더 없이 통과한다', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(call(m)).toBe(true);
  });

  it('상태 변경은 헤더가 없으면 403', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(() => call(m)).toThrow(ForbiddenException);
  });

  it('헤더가 있으면 통과한다 — 값이 아니라 존재가 방어다', () => {
    expect(call('POST', { [CSRF_HEADER]: '1' })).toBe(true);
    expect(call('POST', { [CSRF_HEADER]: 'anything' })).toBe(true);
  });
});
