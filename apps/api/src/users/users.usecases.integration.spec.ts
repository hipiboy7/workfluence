import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { RevocationBus } from '../common/revocation.bus';
import { loadEnv } from '../config/config.module';
import { auditEvents, spaces, users } from '../db/schema';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { UserUseCases } from './users.usecases';
import { UsersService } from './users.service';

/**
 * 사용자 관리의 유스케이스 (P1_설계서_Auth 5절 — 모든 쓰기는 감사와 같은 트랜잭션, FR-236 · docs/spinoff/public-api 계획서 7.1절).
 * B등급 — 실제 PostgreSQL. 순서(해시는 트랜잭션 밖·끊는 통지는 커밋 뒤)는 `auth.integration.spec.ts`가 같은 유스케이스로 본다
 */

let db: TestDb;
let bus: RevocationBus;
let usersSvc: UsersService;
let spacesSvc: SpacesService;
let uc: UserUseCases;
const META = { ip: '10.0.0.14' };
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const personalOf = (userId: string) => db.select().from(spaces).where(and(eq(spaces.kind, 'personal'), eq(spaces.createdBy, userId)));

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  bus = new RevocationBus();
  const settings = new SettingsService(db, loadEnv());
  usersSvc = new UsersService(db, settings, bus);
  spacesSvc = new SpacesService(db);
  uc = new UserUseCases(usersSvc, new AuditService(db), spacesSvc, new NotificationsService(db, new InAppChannel()), bus, db);
});

describe('만들기·승인 — 개인 스페이스와 같은 트랜잭션 (FR-309)', () => {
  it('만들면 활성 계정과 개인 스페이스가 생기고 감사에 아이디·역할이 남는다', async () => {
    const root = await person(db, 'sys', 'root');
    const view = await uc.create({ username: 'made', displayName: '만듦', email: 'made@example.internal', password: 'Made-pw-2026', role: 'member' }, root, META);
    expect(view).toMatchObject({ username: 'made', status: 'active' });
    expect(await personalOf(view.id)).toHaveLength(1);
    expect((await rows('user.create'))[0]).toMatchObject({ actorId: root.id, targetId: view.id, ip: META.ip, detail: { username: 'made', role: 'member' } });
  });

  it('승인하면 개인 스페이스가 생기고 감사에 남는다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const [p] = await db.insert(users).values({ username: 'wait', displayName: '대기', passwordHash: 'x', status: 'pending' }).returning();
    const view = await uc.approve(p!.id, admin, META);
    expect(view.status).toBe('active');
    expect(await personalOf(p!.id)).toHaveLength(1);
    expect((await rows('user.approve'))[0]).toMatchObject({ actorId: admin.id, targetId: p!.id, ip: META.ip, detail: { username: 'wait' } });
  });
});

describe('잠금 해제·정지·해제·강제 종료', () => {
  it('각각 감사에 남고, 정지·강제 종료는 그 사람의 세션 끊기를 알린다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const alice = await person(db, 'alice');
    const notified: string[] = [];
    bus.onRevoke((userId, sid) => {
      if (sid === undefined) notified.push(userId);
    });

    await uc.unlock(alice.id, admin, META);
    const suspended = await uc.suspend(alice.id, admin, META);
    expect(suspended.status).toBe('suspended');
    await uc.unsuspend(alice.id, admin, META);
    const { count } = await uc.terminateSessions(alice.id, admin, META);
    expect(count).toBe(0);

    expect((await rows('user.unlock'))[0]).toMatchObject({ actorId: admin.id, targetId: alice.id, ip: META.ip });
    expect((await rows('user.suspend'))[0]!.detail).toEqual({ username: 'alice', before: 'active' });
    expect((await rows('user.unsuspend'))[0]!.detail).toEqual({ username: 'alice' });
    expect((await rows('user.sessions.terminate'))[0]!.detail).toEqual({ count: 0 });
    expect(notified).toEqual([alice.id, alice.id]);
  });

  it('막히면(자기 자신 정지) 감사도 통지도 없다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const spy = vi.fn();
    bus.onRevoke(spy);
    await expect(uc.suspend(admin.id, admin, META)).rejects.toThrow();
    expect(await rows('user.suspend')).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('비밀번호 초기화 (FR-209·238)', () => {
  it('임시 비밀번호는 응답에만 — 감사에 싣지 않고, 변경을 강제하고, 세션 끊기를 알린다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const alice = await person(db, 'alice');
    const spy = vi.fn();
    bus.onRevoke(spy);
    const { user, temporaryPassword } = await uc.resetPassword(alice.id, admin, META);
    expect(temporaryPassword.length).toBeGreaterThan(7);
    expect(user.mustChangePassword).toBe(true);
    const [r] = await rows('user.password.reset');
    expect(r).toMatchObject({ actorId: admin.id, targetId: alice.id, ip: META.ip });
    expect(JSON.stringify(r)).not.toContain(temporaryPassword);
    expect(spy).toHaveBeenCalledWith(alice.id, undefined);
  });
});

describe('역할·위임', () => {
  it('역할을 바꾸면 감사에 새 역할이 남는다', async () => {
    const root = await person(db, 'sys', 'root');
    const alice = await person(db, 'alice');
    const view = await uc.changeRole(alice.id, 'admin', root, META);
    expect(view.role).toBe('admin');
    expect((await rows('user.role.change'))[0]!.detail).toEqual({ role: 'admin' });
  });

  it('관리자가 아니게 되어 사라진 위임은 같은 감사 행에 남는다 (P11 FR-1205)', async () => {
    const root = await person(db, 'sys', 'root');
    const adm = await person(db, 'adm2', 'admin', { grants: ['llm.manage'] });
    await uc.changeRole(adm.id, 'member', root, META);
    expect((await rows('user.role.change'))[0]!.detail).toEqual({ role: 'member', clearedGrants: ['llm.manage'] });
  });

  it('위임을 주면 이전·이후가 남고, **같은 목록을 다시 보내면 남기지 않는다**', async () => {
    const admin = await person(db, 'adm', 'admin');
    const alice = await person(db, 'alice');
    await uc.changeGrants(alice.id, { grants: ['category.manage'] }, admin, META);
    await uc.changeGrants(alice.id, { grants: ['category.manage'] }, admin, META);
    const all = await rows('user.grants.change');
    expect(all).toHaveLength(1);
    expect(all[0]!.detail).toEqual({ username: 'alice', before: [], after: ['category.manage'] });
  });
});
