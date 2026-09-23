import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD_POLICY, type Principal } from '@workfluence/shared';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { loadEnv } from '../config/config.module';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { TEST_POOL_MAX, closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { AuthService } from './auth.service';
import { DEV_IDENTITY, encodeMockCode } from './oidc/mock.provider';
import type { OidcProvider } from './oidc/oidc.provider';
import { RevocationBus } from '../common/revocation.bus';

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
