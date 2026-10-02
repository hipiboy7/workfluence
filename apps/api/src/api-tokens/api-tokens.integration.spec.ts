import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { API_TOKEN_LIMITS } from '@workfluence/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { RevocationBus } from '../common/revocation.bus';
import { loadEnv } from '../config/config.module';
import { apiTokens, auditEvents, users } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { UsersService } from '../users/users.service';
import { ApiTokensService } from './api-tokens.service';
import { verifyApiToken } from './domain/jwt';

/**
 * B등급 통합 시험 (docs/spinoff/public-api 계획서 4.1절·분석서 G3). **실제 PostgreSQL**을 쓴다. 시간은 `now`로 넣는다.
 */

const SECRET = 'spec-secret-0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-10-02T00:00:00Z');
const DAY = 86_400_000;

let db: TestDb;
let bus: RevocationBus;
let usersSvc: UsersService;
let audit: AuditService;
let svc: ApiTokensService;

const make = (secret = SECRET) => new ApiTokensService(db, audit, usersSvc, bus, { WF_API_JWT_SECRET: secret });

beforeAll(async () => {
  ({ db } = await openTestDb());
  bus = new RevocationBus();
  const settings = new SettingsService(db, loadEnv());
  usersSvc = new UsersService(db, settings, bus);
  audit = new AuditService(db);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  svc?.onModuleDestroy();
  svc = make();
});

async function addUser(username = 'alice', over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({ username, displayName: `${username} 님`, passwordHash: 'x', status: 'active', ...over })
    .returning();
  return u!;
}

const create = (userId: string, body: Partial<{ name: string; scopes: ('read' | 'write' | 'admin')[]; expiresInDays: number }> = {}, now = NOW) =>
  svc.create(userId, { name: '보고서 봇', scopes: ['read'], ...body }, '10.0.0.1', now);

const auditRows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

describe('발급', () => {
  it('서명된 JWT를 한 번 돌려주고, 행에는 값을 두지 않는다', async () => {
    const u = await addUser();
    const { token, view } = await create(u.id, { scopes: ['write', 'read'] });

    expect(await verifyApiToken(token, SECRET, NOW)).toEqual({ ok: true, userId: u.id, tokenId: view.id, scopes: ['read', 'write'] });
    expect(view).toMatchObject({ name: '보고서 봇', scopes: ['read', 'write'], status: 'active', lastUsedAt: null, revokedAt: null });
    expect(view.expiresAt).toBe(new Date(NOW.getTime() + API_TOKEN_LIMITS.defaultDays * DAY).toISOString());

    const raw = await db.execute(sql`SELECT row_to_json(t)::text AS j FROM api_tokens t`);
    expect(raw.rows).toHaveLength(1);
    expect(String((raw.rows[0] as { j: string }).j)).not.toContain(token.split('.')[2]);
  });

  it('감사에 남기되 토큰 값은 싣지 않는다', async () => {
    const u = await addUser();
    const { token, view } = await create(u.id);
    const [row] = await auditRows('api_token.create');
    expect(row).toMatchObject({ actorId: u.id, targetType: 'api_token', targetId: view.id, ip: '10.0.0.1' });
    expect(row!.detail).toMatchObject({ name: '보고서 봇', scopes: ['read'] });
    expect(JSON.stringify(row!.detail)).not.toContain(token);
  });

  it('날 수를 주면 그만큼, 상한을 넘으면 400 EXPIRY_TOO_LONG', async () => {
    const u = await addUser();
    const { view } = await create(u.id, { expiresInDays: 7 });
    expect(view.expiresAt).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    await expect(create(u.id, { expiresInDays: API_TOKEN_LIMITS.maxDays + 1 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it(`살아 있는 토큰이 ${API_TOKEN_LIMITS.maxPerUser}개면 409 TOKEN_LIMIT — 폐기·만료된 것은 세지 않는다`, async () => {
    const u = await addUser();
    const made = [];
    for (let i = 0; i < API_TOKEN_LIMITS.maxPerUser; i++) made.push(await create(u.id, { name: `봇 ${i}` }));
    const err = await create(u.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'TOKEN_LIMIT' });

    await svc.revoke(u.id, made[0]!.view.id, null, NOW);
    await db.update(apiTokens).set({ expiresAt: new Date(NOW.getTime() - 1) }).where(eq(apiTokens.id, made[1]!.view.id));
    await expect(create(u.id)).resolves.toBeDefined();
    await expect(create(u.id)).resolves.toBeDefined();
    await expect(create(u.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('서명 키가 없으면 503 API_DISABLED — 공개 API가 꺼져 있다', async () => {
    const u = await addUser();
    svc.onModuleDestroy();
    svc = make('');
    const err = await create(u.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'API_DISABLED' });
  });
});

describe('목록', () => {
  it('내 것만, 새것부터, 값 없이, 상태를 붙여 준다', async () => {
    const a = await addUser('alice');
    const b = await addUser('bob');
    const first = await create(a.id, { name: '첫째' }, NOW);
    const second = await create(a.id, { name: '둘째' }, new Date(NOW.getTime() + 1000));
    const third = await create(a.id, { name: '셋째', expiresInDays: 1 }, new Date(NOW.getTime() + 2000));
    await create(b.id, { name: '남의 것' });
    await svc.revoke(a.id, first.view.id, null, NOW);

    const list = await svc.list(a.id, new Date(NOW.getTime() + 2 * DAY));
    expect(list.map((t) => [t.name, t.status])).toEqual([
      ['셋째', 'expired'],
      ['둘째', 'active'],
      ['첫째', 'revoked'],
    ]);
    expect(JSON.stringify(list)).not.toContain(second.token);
    expect(JSON.stringify(list)).not.toContain(third.token);
  });
});

describe('폐기', () => {
  it('내 토큰을 폐기하면 그 뒤로 인증되지 않고 감사에 남는다', async () => {
    const u = await addUser();
    const { token, view } = await create(u.id);
    const revoked = await svc.revoke(u.id, view.id, '10.0.0.2', NOW);
    expect(revoked).toMatchObject({ id: view.id, status: 'revoked' });
    expect(await svc.authenticate(token, NOW)).toEqual({ ok: false, code: 'TOKEN_REVOKED' });
    const [row] = await auditRows('api_token.revoke');
    expect(row).toMatchObject({ actorId: u.id, targetId: view.id, ip: '10.0.0.2' });
    expect(row!.detail).toMatchObject({ reason: 'user' });
  });

  it('두 번 폐기해도 감사는 한 번이다', async () => {
    const u = await addUser();
    const { view } = await create(u.id);
    await svc.revoke(u.id, view.id, null, NOW);
    await svc.revoke(u.id, view.id, null, NOW);
    expect(await auditRows('api_token.revoke')).toHaveLength(1);
  });

  it('남의 토큰과 없는 토큰은 404 — 있는지도 드러내지 않는다', async () => {
    const a = await addUser('alice');
    const b = await addUser('bob');
    const { view } = await create(b.id);
    await expect(svc.revoke(a.id, view.id, null, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.revoke(a.id, '00000000-0000-4000-8000-000000000000', null, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('인증', () => {
  it('살아 있는 토큰이면 지금의 사용자와 scope를 준다 — 역할은 요청마다 사용자 행에서 읽는다', async () => {
    const u = await addUser();
    const { token, view } = await create(u.id, { scopes: ['read', 'admin'] });
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, u.id));

    const r = await svc.authenticate(token, NOW);
    expect(r).toMatchObject({ ok: true, tokenId: view.id, scopes: ['read', 'admin'] });
    expect(r.ok && r.user).toMatchObject({ id: u.id, username: 'alice', role: 'admin', mustChangePassword: false });
  });

  it('쓰면 마지막 사용 시각이 남는다', async () => {
    const u = await addUser();
    const { token, view } = await create(u.id);
    const later = new Date(NOW.getTime() + 5000);
    await svc.authenticate(token, later);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, view.id));
    expect(row!.lastUsedAt?.toISOString()).toBe(later.toISOString());
  });

  it('만료 뒤는 TOKEN_EXPIRED', async () => {
    const u = await addUser();
    const { token } = await create(u.id, { expiresInDays: 1 });
    expect(await svc.authenticate(token, new Date(NOW.getTime() + 2 * DAY))).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('행이 지워졌으면 TOKEN_UNKNOWN', async () => {
    const u = await addUser();
    const { token, view } = await create(u.id);
    await db.delete(apiTokens).where(eq(apiTokens.id, view.id));
    expect(await svc.authenticate(token, NOW)).toEqual({ ok: false, code: 'TOKEN_UNKNOWN' });
  });

  it('정지된 사람의 토큰은 ACCOUNT_INACTIVE — 그 자리에서', async () => {
    const u = await addUser();
    const { token } = await create(u.id);
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, u.id));
    expect(await svc.authenticate(token, NOW)).toEqual({ ok: false, code: 'ACCOUNT_INACTIVE' });
  });

  it('비밀번호 변경이 강제되면 PASSWORD_CHANGE_REQUIRED', async () => {
    const u = await addUser();
    const { token } = await create(u.id);
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, u.id));
    expect(await svc.authenticate(token, NOW)).toEqual({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('다른 키로 서명된 것·모양이 틀린 것은 TOKEN_INVALID', async () => {
    const u = await addUser();
    svc.onModuleDestroy();
    svc = make('another-secret-0123456789abcdef0123456789abcdef');
    const { token } = await create(u.id);
    svc.onModuleDestroy();
    svc = make();
    expect(await svc.authenticate(token, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
    expect(await svc.authenticate('not-a-jwt', NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('공개 API가 꺼져 있으면 API_DISABLED', async () => {
    svc.onModuleDestroy();
    svc = make('');
    expect(await svc.authenticate('a.b.c', NOW)).toEqual({ ok: false, code: 'API_DISABLED' });
  });
});

describe('세션을 끊으면 토큰도 끊는다 (분석서 G3)', () => {
  it('그 사람의 세션을 모두 끊는 통지(sid 없음)면 살아 있는 토큰을 모두 폐기하고 감사에 까닭을 남긴다', async () => {
    const a = await addUser('alice');
    const b = await addUser('bob');
    const t1 = await create(a.id, { name: '하나' });
    const t2 = await create(a.id, { name: '둘' });
    const other = await create(b.id);

    bus.revoke(a.id);

    await vi.waitFor(async () => {
      const live = await db.select().from(apiTokens).where(and(eq(apiTokens.userId, a.id), sql`${apiTokens.revokedAt} IS NULL`));
      expect(live).toHaveLength(0);
    });
    expect((await svc.authenticate(t1.token, NOW)).ok).toBe(false);
    expect((await svc.authenticate(t2.token, NOW)).ok).toBe(false);
    expect((await svc.authenticate(other.token, NOW)).ok).toBe(true);
    const rows = await auditRows('api_token.revoke');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.detail as { reason?: string }).reason === 'sessions_revoked')).toBe(true);
  });

  it('로그아웃(그 브라우저의 세션 하나)은 토큰을 건드리지 않는다', async () => {
    const u = await addUser();
    const { token } = await create(u.id);
    bus.revoke(u.id, 'some-session-id');
    await new Promise((r) => setTimeout(r, 50));
    expect((await svc.authenticate(token, NOW)).ok).toBe(true);
  });
});
