import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD_POLICY, type Principal } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { users } from '../db/schema';
import { UsersService } from '../users/users.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { AuthService } from './auth.service';
import { DEV_IDENTITY, encodeMockCode } from './oidc/mock.provider';
import type { OidcProvider } from './oidc/oidc.provider';

/**
 * B등급 통합 테스트 (P1_설계서_Auth 10절). **실제 PostgreSQL**을 쓴다.
 * OIDC 제공자만 모의를 쓴다 — 사내 IdP에 나갈 수 없다 (확인 필요 A).
 */

/** 이 테스트가 보는 설정만. AuthService는 AppEnv 전체를 받지만 여기서 쓰는 것은 넷이다 */
const ENV = {
  WF_OIDC_ENABLED: true,
  WF_OIDC_ROLE_MAP: { 'wf-users': 'member', 'wf-admins': 'admin' } as Record<string, 'root' | 'admin' | 'member'>,
  WF_OIDC_PKCE: true,
  WF_OIDC_REDIRECT_URI: '',
};

class StubProvider implements OidcProvider {
  constructor(private readonly claims = DEV_IDENTITY) {}
  authorizationUrl(state: string): Promise<string> {
    return Promise.resolve(`/cb?code=${encodeMockCode(this.claims)}&state=${state}`);
  }
  exchange(code: string): Promise<typeof DEV_IDENTITY> {
    return Promise.resolve(JSON.parse(Buffer.from(code, 'base64url').toString()) as typeof DEV_IDENTITY);
  }
}

let db: TestDb;
let usersSvc: UsersService;
let audit: AuditService;
let auth: AuthService;

const ROOT: Principal = { id: '00000000-0000-0000-0000-000000000000', role: 'root' };

function makeAuth(provider: OidcProvider | null = new StubProvider()): AuthService {
  return new AuthService(usersSvc, audit, db, ENV as never, provider);
}

beforeAll(async () => {
  ({ db } = await openTestDb());
  usersSvc = new UsersService(db);
  audit = new AuditService(db);
  auth = makeAuth();
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

const SIGNUP = { username: 'alice', displayName: '앨리스', email: 'alice@example.internal', password: 'Alice-pw-2026' };

async function approvedAlice() {
  await auth.signup(SIGNUP);
  const row = await usersSvc.findByUsername('alice');
  await usersSvc.approve(row!.id, ROOT);
  return (await usersSvc.findByUsername('alice'))!;
}

describe('가입 → 승인 → 로그인 (인수 기준 1)', () => {
  it('가입은 승인 대기로 들어간다', async () => {
    await auth.signup(SIGNUP);
    const row = await usersSvc.findByUsername('alice');
    expect(row?.status).toBe('pending');
  });

  it('승인 전에는 비밀번호가 맞아도 로그인되지 않는다', async () => {
    await auth.signup(SIGNUP);
    await expect(auth.login({ username: 'alice', password: SIGNUP.password })).rejects.toThrow();
  });

  it('승인하면 로그인된다', async () => {
    await approvedAlice();
    const user = await auth.login({ username: 'alice', password: SIGNUP.password });
    expect(user.username).toBe('alice');
  });

  it('같은 사용자명·email은 거부된다', async () => {
    await auth.signup(SIGNUP);
    await expect(auth.signup(SIGNUP)).rejects.toThrow();
    await expect(auth.signup({ ...SIGNUP, email: 'other@example.internal' })).rejects.toThrow(/사용자명/);
    await expect(auth.signup({ ...SIGNUP, username: 'bob' })).rejects.toThrow(/email/);
  });
});

describe('계정 열거 방지 (FR-206, FR-208)', () => {
  it('없는 계정·틀린 비밀번호·승인 대기가 모두 같은 메시지로 거부된다', async () => {
    await auth.signup(SIGNUP); // pending
    const messages: string[] = [];
    for (const dto of [
      { username: 'nobody', password: 'x' },
      { username: 'alice', password: 'wrong' },
      { username: 'alice', password: SIGNUP.password },
    ]) {
      await auth.login(dto).catch((e: Error) => messages.push(e.message));
    }
    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
  });

  it('ID 찾기는 일치할 때만 마스킹된 ID를, 아니면 null을 준다 — 모양은 같다', async () => {
    await approvedAlice();
    expect(await auth.findId({ email: SIGNUP.email, displayName: '앨리스' })).toEqual({ username: 'al**e' });
    expect(await auth.findId({ email: SIGNUP.email, displayName: '다른사람' })).toEqual({ username: null });
    expect(await auth.findId({ email: 'nobody@example.internal', displayName: '앨리스' })).toEqual({ username: null });
  });
});

describe('잠금 (FR-205)', () => {
  it('임계 횟수만큼 실패하면 잠기고, 올바른 비밀번호도 막힌다', async () => {
    const alice = await approvedAlice();
    for (let i = 0; i < PASSWORD_POLICY.lockoutThreshold; i++) {
      await auth.login({ username: 'alice', password: 'wrong' }).catch(() => undefined);
    }
    const locked = await usersSvc.findById(alice.id);
    expect(locked?.lockedUntil).not.toBeNull();
    await expect(auth.login({ username: 'alice', password: SIGNUP.password })).rejects.toThrow();
  });

  it('관리자가 풀면 다시 로그인된다', async () => {
    const alice = await approvedAlice();
    for (let i = 0; i < PASSWORD_POLICY.lockoutThreshold; i++) {
      await auth.login({ username: 'alice', password: 'wrong' }).catch(() => undefined);
    }
    await usersSvc.unlock(alice.id, ROOT);
    const user = await auth.login({ username: 'alice', password: SIGNUP.password });
    expect(user.id).toBe(alice.id);
  });

  it('성공하면 실패 횟수가 0으로 돌아간다', async () => {
    const alice = await approvedAlice();
    await auth.login({ username: 'alice', password: 'wrong' }).catch(() => undefined);
    await auth.login({ username: 'alice', password: SIGNUP.password });
    expect((await usersSvc.findById(alice.id))?.failedAttempts).toBe(0);
  });
});

describe('OIDC (인수 기준 2)', () => {
  const start = async () => {
    const s = await auth.oidcStart();
    return s;
  };

  it('groups가 역할로 매핑되고 계정이 JIT 생성된다', async () => {
    const s = await start();
    const code = encodeMockCode(DEV_IDENTITY);
    const user = await auth.oidcCallback({ code, state: s.state }, { state: s.state, nonce: s.nonce, verifier: s.verifier });
    expect(user.role).toBe('member');
    expect(user.oidcSub).toBe(DEV_IDENTITY.sub);
    // IdP 계정은 비밀번호로 로그인할 수 없다 (FR-217)
    expect(user.passwordHash).toBeNull();
  });

  it('state가 다르면 거부한다 (FR-211)', async () => {
    const s = await start();
    await expect(
      auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: 'tampered' }, { state: s.state, nonce: s.nonce }),
    ).rejects.toThrow(/state/);
  });

  it('매핑되는 그룹이 없으면 거부한다 (FR-218)', async () => {
    const s = await start();
    const code = encodeMockCode({ ...DEV_IDENTITY, sub: 'x', groups: ['unmapped'] });
    await expect(auth.oidcCallback({ code, state: s.state }, { state: s.state, nonce: s.nonce })).rejects.toThrow(/역할/);
  });

  it('다시 로그인하면 IdP 값으로 갱신한다 — IdP가 정본이다', async () => {
    const s1 = await start();
    await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s1.state }, { state: s1.state, nonce: s1.nonce });
    const s2 = await start();
    const promoted = { ...DEV_IDENTITY, preferredUsername: 'idp.dev', groups: ['wf-admins'] };
    const user = await auth.oidcCallback({ code: encodeMockCode(promoted), state: s2.state }, { state: s2.state, nonce: s2.nonce });
    expect(user.role).toBe('admin');
    const all = await db.select().from(users).where(eq(users.oidcSub, DEV_IDENTITY.sub));
    expect(all).toHaveLength(1); // 계정이 늘어나지 않는다
  });

  it('username이 이미 쓰이고 있으면 숫자를 붙인다 — 로컬 계정과 합치지 않는다', async () => {
    await auth.signup({ ...SIGNUP, username: 'idp.dev' });
    const s = await start();
    const user = await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s.state }, { state: s.state, nonce: s.nonce });
    expect(user.username).toBe('idp.dev1');
    expect(user.oidcSub).toBe(DEV_IDENTITY.sub);
  });

  it('OIDC가 꺼져 있으면 404다 (FR-219)', async () => {
    const off = new AuthService(usersSvc, audit, db, { ...ENV, WF_OIDC_ENABLED: false } as never, null);
    await expect(off.oidcStart()).rejects.toThrow(/OIDC/);
  });
});

describe('감사로그 (인수 기준 3, FR-236, FR-238)', () => {
  it('두 경로의 로그인이 모두 남는다', async () => {
    await approvedAlice();
    await auth.login({ username: 'alice', password: SIGNUP.password });
    const s = await auth.oidcStart();
    await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s.state }, { state: s.state, nonce: s.nonce });

    const events = await audit.list(50);
    const methods = events.filter((e) => e.action === 'auth.login.success').map((e) => e.detail?.method);
    expect(methods).toContain('local');
    expect(methods).toContain('oidc');
  });

  it('실패도 남고, 사유는 기록에만 있다', async () => {
    await auth.login({ username: 'nobody', password: 'x' }).catch(() => undefined);
    const [e] = await audit.list(1);
    expect(e.action).toBe('auth.login.failure');
    expect(e.detail).toMatchObject({ reason: 'unknown' });
  });

  it('email은 마스킹해서 남긴다', async () => {
    await auth.signup(SIGNUP);
    const e = (await audit.list(10)).find((x) => x.action === 'user.signup');
    expect(e?.detail?.email).toBe('al***@example.internal');
    expect(JSON.stringify(e?.detail)).not.toContain(SIGNUP.email);
  });

  it('본 작업이 롤백되면 기록도 사라진다 (FR-236)', async () => {
    // 같은 트랜잭션이라 사용자 삽입이 실패하면 감사 기록도 남지 않는다
    await auth.signup(SIGNUP);
    const before = (await audit.list(100)).length;
    await auth.signup(SIGNUP).catch(() => undefined); // 중복이라 실패
    expect((await audit.list(100)).length).toBe(before);
  });
});

describe('비밀번호 변경 (FR-207)', () => {
  it('현재 비밀번호가 맞아야 바뀌고, 변경 강제가 풀린다', async () => {
    const alice = await approvedAlice();
    await usersSvc.resetPassword(alice.id, ROOT); // must_change_password = true
    const { temporaryPassword } = await usersSvc.resetPassword(alice.id, ROOT);
    expect((await usersSvc.findById(alice.id))?.mustChangePassword).toBe(true);

    await expect(auth.changePassword(alice.id, { currentPassword: 'wrong', newPassword: 'New-pw-2026' })).rejects.toThrow();
    await auth.changePassword(alice.id, { currentPassword: temporaryPassword, newPassword: 'New-pw-2026' });
    expect((await usersSvc.findById(alice.id))?.mustChangePassword).toBe(false);
    await expect(auth.login({ username: 'alice', password: 'New-pw-2026' })).resolves.toBeDefined();
  });
});

describe('역할 (FR-232, FR-233)', () => {
  it('마지막 root는 강등할 수 없다', async () => {
    const [root] = await db
      .insert(users)
      .values({ username: 'root', displayName: 'r', passwordHash: 'x', role: 'root', status: 'active' })
      .returning();
    const actor: Principal = { id: '11111111-1111-1111-1111-111111111111', role: 'root' };
    await expect(usersSvc.changeRole(root.id, 'admin', actor)).rejects.toThrow(/마지막 root/);
  });

  it('자기 자신의 역할은 바꿀 수 없다', async () => {
    const alice = await approvedAlice();
    await expect(usersSvc.changeRole(alice.id, 'admin', { id: alice.id, role: 'root' })).rejects.toThrow(/자기 자신/);
  });
});
