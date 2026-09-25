import { BadGatewayException, BadRequestException, ForbiddenException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_POLICY, type Principal } from '@workfluence/shared';
import { eq, sql } from 'drizzle-orm';
import { errors as jose } from 'jose';
import { AuditService } from '../audit/audit.service';
import { auditEvents, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { loadEnv } from '../config/config.module';
import { SettingsService } from '../settings/settings.service';
import { UsersService, toUserView } from '../users/users.service';
import { TEST_POOL_MAX, closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { AuthService, toMeView } from './auth.service';
import { DEV_IDENTITY, encodeMockCode } from './oidc/mock.provider';
import type { OidcProvider } from './oidc/oidc.provider';
import { RevocationBus } from '../common/revocation.bus';
import { isLogLine, type LogLine } from '../common/log-line';

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
let spacesSvc: SpacesService;

const ROOT: Principal = { id: '00000000-0000-0000-0000-000000000000', role: 'root' };

function makeAuth(provider: OidcProvider | null = new StubProvider()): AuthService {
  return new AuthService(usersSvc, audit, spacesSvc, db, ENV as never, provider);
}

beforeAll(async () => {
  ({ db } = await openTestDb());
  usersSvc = new UsersService(db, new SettingsService(db, loadEnv()), new RevocationBus());
  spacesSvc = new SpacesService(db);
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

  it('같은 사용자명·email은 거부되지만 **어느 쪽인지 알려 주지 않는다**', async () => {
    await auth.signup(SIGNUP);
    const messages: string[] = [];
    for (const dto of [SIGNUP, { ...SIGNUP, email: 'other@example.internal' }, { ...SIGNUP, username: 'bob' }]) {
      await auth.signup(dto).catch((e: Error) => messages.push(e.message));
    }
    expect(messages).toHaveLength(3);
    // 아이디 중복인지 email 중복인지가 갈리면 미인증 공격자의 존재 확인 오라클이 된다
    expect(new Set(messages).size).toBe(1);
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

  it('로컬 계정이 쓰는 email이면 IdP 계정은 email 없이 만든다 — 500이 아니다', async () => {
    // 로컬로 가입한 사람이 나중에 IdP로 들어오는 것은 드문 경로가 아니다.
    // users_email_uq 때문에 그대로 넣으면 unique 위반으로 죽는다 (자체 점검 #1)
    await auth.signup({ ...SIGNUP, email: 'shared@example.internal' });
    const s = await start();
    const code = encodeMockCode({ ...DEV_IDENTITY, email: 'shared@example.internal' });
    const user = await auth.oidcCallback({ code, state: s.state }, { state: s.state, nonce: s.nonce });
    expect(user.oidcSub).toBe(DEV_IDENTITY.sub);
    expect(user.email).toBeNull();
    // 계정을 합치지 않았다 — 로컬 계정은 그대로다
    expect((await usersSvc.findByUsername('alice'))?.email).toBe('shared@example.internal');
  });

  it('자기 email은 그대로 유지한다 (재로그인이 자기 자신과 충돌하지 않는다)', async () => {
    const s1 = await start();
    const claims = { ...DEV_IDENTITY, email: 'mine@example.internal' };
    const first = await auth.oidcCallback({ code: encodeMockCode(claims), state: s1.state }, { state: s1.state, nonce: s1.nonce });
    expect(first.email).toBe('mine@example.internal');
    const s2 = await start();
    const again = await auth.oidcCallback({ code: encodeMockCode(claims), state: s2.state }, { state: s2.state, nonce: s2.nonce });
    expect(again.email).toBe('mine@example.internal');
  });

  it('OIDC가 꺼져 있으면 404다 (FR-219)', async () => {
    const off = new AuthService(usersSvc, audit, spacesSvc, db, { ...ENV, WF_OIDC_ENABLED: false } as never, null);
    await expect(off.oidcStart()).rejects.toThrow(/OIDC/);
  });
});

describe('감사로그 (인수 기준 3, FR-236, FR-238)', () => {
  it('두 경로의 로그인이 모두 남는다', async () => {
    await approvedAlice();
    await auth.login({ username: 'alice', password: SIGNUP.password });
    const s = await auth.oidcStart();
    await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s.state }, { state: s.state, nonce: s.nonce });

    const events = await audit.list({ limit: 50 });
    const methods = events.filter((e) => e.action === 'auth.login.success').map((e) => e.detail?.method);
    expect(methods).toContain('local');
    expect(methods).toContain('oidc');
  });

  it('실패도 남고, 사유는 기록에만 있다', async () => {
    await auth.login({ username: 'nobody', password: 'x' }).catch(() => undefined);
    const [e] = await audit.list({ limit: 1 });
    expect(e.action).toBe('auth.login.failure');
    expect(e.detail).toMatchObject({ reason: 'unknown' });
  });

  it('email은 마스킹해서 남긴다', async () => {
    await auth.signup(SIGNUP);
    const e = (await audit.list({ limit: 10 })).find((x) => x.action === 'user.signup');
    expect(e?.detail?.email).toBe('al***@example.internal');
    expect(JSON.stringify(e?.detail)).not.toContain(SIGNUP.email);
  });

  /**
   * **앞 판은 아무것도 검증하지 못했다.** 중복 가입은 `assertUnique`가 insert와 audit.record
   * **전에** 던지므로 롤백이 일어나지 않는다. `audit.record`를 트랜잭션 밖으로 빼도 통과하는
   * 테스트였다. 자체 점검이 잡았다. 이번에는 **기록을 남긴 뒤 실패시켜** 실제로 되돌아가는지 본다.
   */
  it('기록을 남긴 뒤 트랜잭션이 실패하면 기록도 사라진다 (FR-236)', async () => {
    const before = (await audit.list({ limit: 200 })).length;
    await db
      .transaction(async (tx) => {
        await audit.record({ action: 'user.approve', targetType: 'user', targetId: 'rollback-me' }, tx);
        throw new Error('일부러 실패');
      })
      .catch(() => undefined);
    expect((await audit.list({ limit: 200 })).length).toBe(before);
    expect((await audit.list({ limit: 200 })).some((e) => e.targetId === 'rollback-me')).toBe(false);
  });

  it('반대로 커밋되면 남는다 — 위 테스트가 항진 명제가 아님을 보인다', async () => {
    await db.transaction(async (tx) => {
      await audit.record({ action: 'user.approve', targetType: 'user', targetId: 'keep-me' }, tx);
    });
    expect((await audit.list({ limit: 200 })).some((e) => e.targetId === 'keep-me')).toBe(true);
  });

  it('로그인 실패의 횟수 갱신과 기록이 함께 남는다 (FR-236)', async () => {
    const alice = await approvedAlice();
    await auth.login({ username: 'alice', password: 'wrong' }).catch(() => undefined);
    expect((await usersSvc.findById(alice.id))?.failedAttempts).toBe(1);
    expect((await audit.list({ limit: 5 })).some((e) => e.action === 'auth.login.failure')).toBe(true);
  });
});

describe('개인 스페이스는 모든 계정 생성 경로에서 만들어진다 (FR-309)', () => {
  it('IdP JIT 계정에도 생긴다 — **운영의 주 로그인 경로다**', async () => {
    const s = await auth.oidcStart();
    const user = await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s.state }, { state: s.state, nonce: s.nonce });
    const list = await spacesSvc.list({ id: user.id, role: 'member' }, 'personal', 10);
    expect(list).toHaveLength(1);
  });

  it('재로그인해도 하나뿐이다 (멱등)', async () => {
    for (let i = 0; i < 2; i++) {
      const s = await auth.oidcStart();
      await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s.state }, { state: s.state, nonce: s.nonce });
    }
    const u = (await usersSvc.findByOidcSub(DEV_IDENTITY.sub))!;
    expect(await spacesSvc.list({ id: u.id, role: 'member' }, 'personal', 10)).toHaveLength(1);
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

describe('계정 복구 — 미인증 경로는 비밀번호를 발급하지 않는다 (FR-209a)', () => {
  it('요청은 항상 같은 응답이고 비밀번호가 바뀌지 않는다', async () => {
    const alice = await approvedAlice();
    const before = (await usersSvc.findById(alice.id))!.passwordHash;

    expect(await auth.recoverPassword({ username: 'alice', email: SIGNUP.email })).toEqual({ ok: true });
    expect(await auth.recoverPassword({ username: 'alice', email: 'wrong@example.internal' })).toEqual({ ok: true });
    expect(await auth.recoverPassword({ username: 'nobody', email: SIGNUP.email })).toEqual({ ok: true });

    // 가장 중요한 단정: 남의 비밀번호가 바뀌지 않았다
    expect((await usersSvc.findById(alice.id))!.passwordHash).toBe(before);
    await expect(auth.login({ username: 'alice', password: SIGNUP.password })).resolves.toBeDefined();
  });

  it('요청은 감사로그에 남아 관리자가 판단할 수 있다', async () => {
    await approvedAlice();
    await auth.recoverPassword({ username: 'alice', email: SIGNUP.email });
    const e = (await audit.list({ limit: 10 })).find((x) => x.action === 'auth.password.recover');
    expect(e?.detail).toMatchObject({ found: true, requested: true });
  });
});

describe('IdP 계정에는 비밀번호를 부여하지 않는다 (FR-217)', () => {
  it('관리자 초기화가 IdP 계정을 거부한다', async () => {
    const s = await auth.oidcStart();
    const idp = await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s.state }, { state: s.state, nonce: s.nonce });
    expect(idp.passwordHash).toBeNull();
    // 비밀번호를 붙이면 IdP가 강제하던 인증을 건너뛰는 옆문이 생긴다
    await expect(usersSvc.resetPassword(idp.id, ROOT)).rejects.toThrow(/IdP/);
    expect((await usersSvc.findById(idp.id))!.passwordHash).toBeNull();
  });
});

describe('비밀번호가 바뀌면 그 사용자의 모든 세션이 끊긴다 (FR-224)', () => {
  const sessionRow = (sid: string, userId: string) =>
    db.execute(
      sql`INSERT INTO sessions (sid, sess, expire) VALUES (${sid}, ${JSON.stringify({ userId, cookie: {} })}::jsonb, now() + interval '1 hour')`,
    );
  const countFor = async (userId: string) => {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM sessions WHERE sess->>'userId' = ${userId}`);
    return (r.rows[0] as { n: number }).n;
  };

  it('비밀번호 변경이 다른 기기의 세션까지 지운다', async () => {
    const alice = await approvedAlice();
    await sessionRow('other-device-1', alice.id);
    await sessionRow('other-device-2', alice.id);
    expect(await countFor(alice.id)).toBe(2);

    await auth.changePassword(alice.id, { currentPassword: SIGNUP.password, newPassword: 'New-pw-2026' });
    expect(await countFor(alice.id)).toBe(0);
  });

  it('관리자 초기화도 세션을 끊는다 — 탈취를 의심하는 상황에서 쓰는 기능이다', async () => {
    const alice = await approvedAlice();
    await sessionRow('stolen', alice.id);
    await usersSvc.resetPassword(alice.id, ROOT);
    expect(await countFor(alice.id)).toBe(0);
  });

  it('다른 사용자의 세션은 건드리지 않는다', async () => {
    const alice = await approvedAlice();
    await auth.signup({ ...SIGNUP, username: 'bob', email: 'bob@example.internal' });
    const bob = (await usersSvc.findByUsername('bob'))!;
    await sessionRow('alice-s', alice.id);
    await sessionRow('bob-s', bob.id);
    await auth.changePassword(alice.id, { currentPassword: SIGNUP.password, newPassword: 'New-pw-2026' });
    expect(await countFor(alice.id)).toBe(0);
    expect(await countFor(bob.id)).toBe(1);
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

/**
 * **풀 크기보다 많은 동시 로그인** (T-026).
 *
 * 트랜잭션 안에서 풀에 두 번째 연결을 달라고 하면, 동시 요청이 풀 크기에 닿는 순간
 * 열려 있는 트랜잭션끼리 서로의 연결을 기다려 **영원히 풀리지 않는다.** 부하 측정에서
 * 실제로 앱 전체가 멈췄다.
 *
 * **동시 요청 수를 풀 크기에서 계산한다.** 숫자를 직접 적어 두면 누가 풀을 키웠을 때
 * 결함이 되살아난 채로 테스트가 초록이 된다 — 두 숫자가 묶여 있지 않으면 조용히
 * 무장해제된다 (코드 리뷰 5).
 *
 * 이 테스트는 **느려지면 실패한다.** 데드락은 오류를 내지 않고 조용히 멈추기 때문에
 * "던졌더니 다 돌아왔다"를 시간 안에 확인하는 것 말고는 잡을 방법이 없다.
 */
describe('동시 로그인이 연결 풀을 잠그지 않는다 (T-026)', () => {
  const CONCURRENT = TEST_POOL_MAX * 2;

  it('풀 크기의 두 배를 동시에 던져도 전부 돌아온다', { timeout: 20_000 }, async () => {
    // 설정이 흘러가 버리면 이 테스트는 아무것도 재현하지 않는다
    expect(CONCURRENT).toBeGreaterThan(TEST_POOL_MAX);
    await approvedAlice();
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => auth.login({ username: 'alice', password: SIGNUP.password })),
    );
    expect(results).toHaveLength(CONCURRENT);
    expect(results.every((u) => u.username === 'alice')).toBe(true);
  });

  it('실패하는 로그인도 마찬가지다 — 실패 경로는 갱신까지 해서 더 오래 잡는다', { timeout: 20_000 }, async () => {
    await approvedAlice();
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () => auth.login({ username: 'alice', password: 'wrong-password' })),
    );
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
  });
});

describe('위임 — root가 관리자에게 LLM 연결 관리를 준다 (P11 D.1, FR-1200~1205)', () => {
  async function mkAdmin(username = 'boss') {
    const [u] = await db.insert(users).values({ username, displayName: `${username} 이름`, passwordHash: 'x', role: 'admin', status: 'active' }).returning();
    return u;
  }

  it('**root가 주고 거둔다** — 이전·이후를 돌려주고, 같은 목록을 다시 보내도 된다(멱등). 화면·me에 실린다', async () => {
    const a = await mkAdmin();
    const given = await usersSvc.changeGrants(a.id, ['llm.manage'], ROOT);
    expect([given.before, given.after, given.row.grants]).toEqual([[], ['llm.manage'], ['llm.manage']]);
    expect([toUserView(given.row).grants, toMeView(given.row).grants]).toEqual([['llm.manage'], ['llm.manage']]);
    const again = await usersSvc.changeGrants(a.id, ['llm.manage'], ROOT);
    expect([again.before, again.after]).toEqual([['llm.manage'], ['llm.manage']]);
    const taken = await usersSvc.changeGrants(a.id, [], ROOT);
    expect([taken.before, taken.after, taken.row.grants]).toEqual([['llm.manage'], [], []]);
  });

  it('**root만 준다** — 관리자는, 위임받은 관리자라도 403 (A.1-3)', async () => {
    const a = await mkAdmin();
    const b = await mkAdmin('other');
    await usersSvc.changeGrants(b.id, ['llm.manage'], ROOT);
    for (const actor of [{ id: b.id, role: 'admin', grants: ['llm.manage'] }, { id: b.id, role: 'admin' }] as Principal[]) {
      await expect(usersSvc.changeGrants(a.id, ['llm.manage'], actor)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('**관리자에게만** — member·root에게 주면 400, 없는 사용자는 404', async () => {
    const alice = await approvedAlice();
    await expect(usersSvc.changeGrants(alice.id, ['llm.manage'], ROOT)).rejects.toBeInstanceOf(BadRequestException);
    const [r] = await db.insert(users).values({ username: 'root2', displayName: 'r', passwordHash: 'x', role: 'root', status: 'active' }).returning();
    await expect(usersSvc.changeGrants(r.id, ['llm.manage'], ROOT)).rejects.toBeInstanceOf(BadRequestException);
    await expect(usersSvc.changeGrants('00000000-0000-4000-8000-000000000001', ['llm.manage'], ROOT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('**관리자가 member가 되면 위임이 사라진다** — 다시 관리자가 되어도 돌아오지 않는다 (A.1-4)', async () => {
    const a = await mkAdmin();
    await usersSvc.changeGrants(a.id, ['llm.manage'], ROOT);
    const down = await usersSvc.changeRole(a.id, 'member', ROOT);
    expect([down.row.grants, down.clearedGrants]).toEqual([[], ['llm.manage']]);
    const up = await usersSvc.changeRole(a.id, 'admin', ROOT);
    expect([up.row.grants, up.clearedGrants]).toEqual([[], []]);
  });

  it('**DB도 막는다** — 위임을 비우지 않고 역할만 내리는 문장, 위임할 수 없는 행위는 거부된다', async () => {
    const a = await mkAdmin();
    await usersSvc.changeGrants(a.id, ['llm.manage'], ROOT);
    await expect(db.update(users).set({ role: 'member' }).where(eq(users.id, a.id))).rejects.toThrow();
    await expect(db.update(users).set({ grants: ['system.manage'] }).where(eq(users.id, a.id))).rejects.toThrow();
    expect((await usersSvc.findById(a.id))?.grants).toEqual(['llm.manage']);
  });

  it('**사내 계정의 역할 동기화도 위임을 비운다** — IdP가 관리자 그룹에서 뺐다. 로그인 감사 행에 남는다 (FR-1203·1205)', async () => {
    const asAdmin = { ...DEV_IDENTITY, groups: ['wf-admins'] };
    const s1 = await auth.oidcStart();
    const first = await auth.oidcCallback({ code: encodeMockCode(asAdmin), state: s1.state }, { state: s1.state, nonce: s1.nonce });
    expect(first.role).toBe('admin');
    await usersSvc.changeGrants(first.id, ['llm.manage'], ROOT);
    const s2 = await auth.oidcStart();
    const second = await auth.oidcCallback({ code: encodeMockCode(DEV_IDENTITY), state: s2.state }, { state: s2.state, nonce: s2.nonce });
    expect([second.role, second.grants]).toEqual(['member', []]);
    const logins = await db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.login.success'));
    expect(logins.map((e) => (e.detail as { clearedGrants?: string[] }).clearedGrants ?? null)).toEqual([null, ['llm.manage']]);
  });

  it('**같은 목록을 다시 보내면 쓰지 않는다** — `changed: false`, 호출부는 감사 행을 남기지 않는다 (코드 리뷰 9)', async () => {
    const a = await mkAdmin();
    expect((await usersSvc.changeGrants(a.id, ['llm.manage'], ROOT)).changed).toBe(true);
    const again = await usersSvc.changeGrants(a.id, ['llm.manage'], ROOT);
    expect([again.changed, again.before, again.after, again.row.grants]).toEqual([false, ['llm.manage'], ['llm.manage'], ['llm.manage']]);
  });

  it('**위임 없는 관리자는 위임받은 관리자를 관리하지 못한다** — 비밀번호를 초기화해 그 계정으로 위임을 얻는 길, 역할을 내렸다 올려 거두는 길 (보안 검토 1)', async () => {
    const plain = await mkAdmin('plain');
    const boss = await mkAdmin('boss2');
    await usersSvc.changeGrants(boss.id, ['llm.manage'], ROOT);
    const plainActor: Principal = { id: plain.id, role: 'admin', grants: [] };
    await expect(usersSvc.resetPassword(boss.id, plainActor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(usersSvc.changeRole(boss.id, 'member', plainActor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(usersSvc.unlock(boss.id, plainActor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(usersSvc.terminateSessions(boss.id, plainActor)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await usersSvc.findById(boss.id))?.grants).toEqual(['llm.manage']);

    // 같은 것을 가진 관리자와 root는 된다. 위임 없는 관리자끼리는 그대로다
    const peer = await mkAdmin('peer');
    await usersSvc.changeGrants(peer.id, ['llm.manage'], ROOT);
    await expect(usersSvc.terminateSessions(boss.id, { id: peer.id, role: 'admin', grants: ['llm.manage'] })).resolves.toBeTypeOf('number');
    await expect(usersSvc.resetPassword(boss.id, ROOT)).resolves.toMatchObject({ user: { id: boss.id } });
    const plain2 = await mkAdmin('plain2');
    await expect(usersSvc.terminateSessions(plain2.id, plainActor)).resolves.toBeTypeOf('number');
  });

  /** 한 트랜잭션이 위임을 바꾸고 **커밋하기 전에** 다른 연결의 요청을 띄운다 — 잠그지 않으면 그 요청이 옛 값을 읽고 커밋 뒤에 덮는다 */
  async function whileGrantPending<T>(adminId: string, grants: 'llm.manage'[], run: () => Promise<T>): Promise<T> {
    let pending: Promise<T> | undefined;
    await db.transaction(async (tx) => {
      await usersSvc.changeGrants(adminId, grants, ROOT, tx);
      pending = run();
      // 다른 요청이 읽기(잠그지 않았다면)를 마치고 쓰기에서 기다릴 만큼
      await new Promise((r) => setTimeout(r, 200));
    });
    return pending!;
  }

  it('**역할을 그대로 두는 변경이 그 사이의 위임을 덮지 않는다** — 행을 잠그고 읽는다 (코드 리뷰 4)', async () => {
    const a = await mkAdmin();
    const r = await whileGrantPending(a.id, ['llm.manage'], () => usersSvc.changeRole(a.id, 'admin', ROOT));
    expect([r.row.grants, (await usersSvc.findById(a.id))?.grants]).toEqual([['llm.manage'], ['llm.manage']]);
  });

  it('**동시에 위임을 바꾸면 뒤의 것이 앞의 결과를 이전 값으로 본다** — 감사 행의 이전 값이 맞다 (코드 리뷰 4)', async () => {
    const a = await mkAdmin();
    const second = await whileGrantPending(a.id, ['llm.manage'], () => usersSvc.changeGrants(a.id, [], ROOT));
    expect([second.before, second.after, second.changed]).toEqual([['llm.manage'], [], true]);
  });

  it('**root 둘을 동시에 내려도 root가 남는다** — 강등을 줄 세운다. 먼저 내린 것이 커밋되기 전에 센 뒤의 요청은 "마지막 root"로 거절된다 (FR-233, 종료 루틴 자체 점검 6)', async () => {
    const [r1] = await db.insert(users).values({ username: 'root-a', displayName: 'a', passwordHash: 'x', role: 'root', status: 'active' }).returning();
    const [r2] = await db.insert(users).values({ username: 'root-b', displayName: 'b', passwordHash: 'x', role: 'root', status: 'active' }).returning();
    let second: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await usersSvc.changeRole(r1.id, 'admin', ROOT, tx);
      // 앞의 강등이 커밋되기 전에 다른 root를 내린다 — 잠그지 않으면 이 요청도 root 2명을 센다
      second = usersSvc.changeRole(r2.id, 'admin', ROOT).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(await second).toBeInstanceOf(BadRequestException);
    const roots = await db.select().from(users).where(eq(users.role, 'root'));
    expect(roots.map((u) => u.username)).toEqual(['root-b']);
  });

  it('**판정과 쓰기 사이에 위임을 받아도 위임 없는 관리자는 초기화하지 못한다** — 관리 대상의 행을 잠그고 판정한다 (종료 루틴 자체 점검 2)', async () => {
    const plain = await mkAdmin('plain3');
    const target = await mkAdmin('soon-boss');
    // root가 위임을 주는 트랜잭션이 커밋되기 전에 초기화가 온다 — 잠그지 않으면 옛 값(위임 없음)으로 판정하고 쓴다
    const reset = await whileGrantPending(target.id, ['llm.manage'], () =>
      usersSvc.resetPassword(target.id, { id: plain.id, role: 'admin', grants: [] }).catch((e: unknown) => e),
    );
    expect(reset).toBeInstanceOf(ForbiddenException);
  });

  it('**사내 계정 동기화도 그 사이의 위임을 덮지 않는다** — 관리자로 다시 로그인하는 사이 root가 준 것 (보안 검토 후보 1)', async () => {
    const asAdmin = { ...DEV_IDENTITY, groups: ['wf-admins'] };
    const s1 = await auth.oidcStart();
    const first = await auth.oidcCallback({ code: encodeMockCode(asAdmin), state: s1.state }, { state: s1.state, nonce: s1.nonce });
    const s2 = await auth.oidcStart();
    const again = await whileGrantPending(first.id, ['llm.manage'], () =>
      auth.oidcCallback({ code: encodeMockCode(asAdmin), state: s2.state }, { state: s2.state, nonce: s2.nonce }),
    );
    expect([again.role, again.grants]).toEqual(['admin', ['llm.manage']]);
  });
});

describe('사내 IdP가 실패하면 (P11 FR-1215, 코드 리뷰 8)', () => {
  class FailingProvider implements OidcProvider {
    constructor(private readonly err: unknown) {}
    authorizationUrl(): Promise<string> {
      return Promise.reject(this.err);
    }
    exchange(): Promise<typeof DEV_IDENTITY> {
      return Promise.reject(this.err);
    }
  }
  const eventLines = (spy: { mock: { calls: unknown[][] } }): LogLine[] => spy.mock.calls.map((c) => c[0]).filter(isLogLine);
  /** 콜백의 실패가 남긴 로그인 실패 감사 행의 까닭 */
  const loginFailures = async () =>
    (await db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.login.failure'))).map((e) => e.detail as Record<string, unknown>);

  it('**닿지 않으면 502와 warn 한 줄** — `auth.oidc_failed`에 단계와 오류(사내 CA를 믿지 못하면 그 코드). 처리되지 않은 예외(500)가 아니다', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const tls = new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'unable to verify the first certificate' } });
      const failing = makeAuth(new FailingProvider(tls));
      await expect(failing.oidcStart()).rejects.toBeInstanceOf(BadGatewayException);
      await expect(failing.oidcCallback({ code: 'c', state: 's' }, { state: 's', nonce: 'n' })).rejects.toBeInstanceOf(BadGatewayException);
      const lines = eventLines(warn);
      expect(lines.map((l) => [l.event, l.fields.step])).toEqual([
        ['auth.oidc_failed', 'start'],
        ['auth.oidc_failed', 'callback'],
      ]);
      expect(lines[0].err).toBe(tls);
      // **콜백의 실패는 로그인 실패로 남는다** — 시작의 실패는 IdP에 가 보지도 못해 남기지 않는다 (종료 루틴 자체 점검 1)
      expect(await loginFailures()).toEqual([{ method: 'oidc', reason: 'idp_unreachable' }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('**id_token을 받아들이지 않으면 401** — 서명·aud·exp(jose)는 다시 해도 같다. "잠시 뒤 다시"(502)가 아니다. 키 목록을 제때 못 받은 것만 502', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      for (const err of [
        new jose.JWTClaimValidationFailed('unexpected "aud" claim value', {}, 'aud', 'check_failed'),
        new jose.JWTExpired('"exp" claim timestamp check failed', {}, 'exp', 'check_failed'),
        new jose.JWSSignatureVerificationFailed(),
      ]) {
        await expect(makeAuth(new FailingProvider(err)).oidcCallback({ code: 'c', state: 's' }, { state: 's', nonce: 'n' })).rejects.toBeInstanceOf(UnauthorizedException);
      }
      await expect(makeAuth(new FailingProvider(new jose.JWKSTimeout())).oidcCallback({ code: 'c', state: 's' }, { state: 's', nonce: 'n' })).rejects.toBeInstanceOf(BadGatewayException);
      expect(eventLines(warn).map((l) => l.event)).toEqual(['auth.oidc_failed', 'auth.oidc_failed', 'auth.oidc_failed', 'auth.oidc_failed']);
      expect((await loginFailures()).map((d) => d.reason)).toEqual(['idp_rejected', 'idp_rejected', 'idp_rejected', 'idp_unreachable']);
    } finally {
      warn.mockRestore();
    }
  });

  it('**우리가 판정한 거절은 그대로 던지고 남긴다** — 토큰 교환의 거절은 로그에 아무것도 없었다', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const failing = makeAuth(new FailingProvider(new UnauthorizedException('토큰 교환 실패: HTTP 400')));
      await expect(failing.oidcCallback({ code: 'c', state: 's' }, { state: 's', nonce: 'n' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(eventLines(warn).map((l) => [l.event, l.fields.step])).toEqual([['auth.oidc_failed', 'callback']]);
      expect(await loginFailures()).toEqual([{ method: 'oidc', reason: 'idp_rejected' }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('state가 맞지 않는 것은 IdP 탓이 아니다 — 남기지 않는다', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(auth.oidcCallback({ code: 'c', state: 'tampered' }, { state: 's', nonce: 'n' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(eventLines(warn)).toEqual([]);
      expect(await loginFailures()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

