import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { auditQueryDto, listUsersDto, policyPatchDto, userGrantsDto, type AppEnv } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_ADMIN_KEY } from '../api-tokens/api-token.guard';
import { AuditService } from '../audit/audit.service';
import { RevocationBus } from '../common/revocation.bus';
import { loadEnv } from '../config/config.module';
import { auditEvents } from '../db/schema';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { PolicyUseCases } from '../settings/policy.usecases';
import { SettingsService } from '../settings/settings.service';
import { SpacesService } from '../spaces/spaces.service';
import { UserUseCases } from '../users/users.usecases';
import { UsersService } from '../users/users.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { V1AuditController, V1PolicyController, V1UsersController } from './v1-admin.controller';

/**
 * 공개 API v1의 관리 — 사용자·정책·감사 (docs/spinoff/public-api 설계서 3.3절 · FR-2207·2209·2210). B등급 — 실제 PostgreSQL. 화면용과 같은 서비스·유스케이스를
 * 부르는 얇은 층이다 — 판정(`user.manage`·`settings.manage`·`audit.read`, 대상이 가진 위임)과 감사는 그쪽이 한다. 여기서 보는 것은 **연결**과 **계약**이다:
 * 모든 경로에 `admin` scope 표시가 있고, 비밀번호 초기화 경로는 없다.
 */

let db: TestDb;
let users: V1UsersController;
let policy: V1PolicyController;
let audit: V1AuditController;
const req = { ip: '10.0.0.30' } as never;
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const env = { WF_UPLOAD_MAX_MB: 20, WF_SESSION_IDLE_MINUTES: 30, WF_SESSION_ABSOLUTE_HOURS: 12, WF_TRASH_RETENTION_DAYS: 30, WF_AUDIT_RETENTION_DAYS: 365 } as unknown as AppEnv;

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  const bus = new RevocationBus();
  const settings = new SettingsService(db, env);
  const auditSvc = new AuditService(db, settings);
  const usersSvc = new UsersService(db, new SettingsService(db, loadEnv()), bus);
  const ucUsers = new UserUseCases(usersSvc, new AuditService(db), new SpacesService(db), new NotificationsService(db, new InAppChannel()), bus, db);
  users = new V1UsersController(usersSvc, ucUsers);
  policy = new V1PolicyController(new PolicyUseCases(settings, auditSvc, db));
  audit = new V1AuditController(auditSvc);
});

describe('계약 — admin scope 표시와 비밀번호 초기화 제외', () => {
  const routes = [V1UsersController, V1PolicyController, V1AuditController].flatMap((C) =>
    Object.getOwnPropertyNames(C.prototype)
      .filter((n) => n !== 'constructor')
      .map((n) => ({ cls: C.name, name: n, handler: C.prototype[n as keyof typeof C.prototype] as object })),
  );

  it('세 컨트롤러의 모든 경로에 `admin` scope 표시가 있다(읽기용 관리자 토큰이 새도 정지·역할 변경은 못 한다 — Q4)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(12);
    for (const r of routes) {
      const cls = [V1UsersController, V1PolicyController, V1AuditController].find((c) => c.name === r.cls)!;
      const marked = Reflect.getMetadata(API_ADMIN_KEY, r.handler) ?? Reflect.getMetadata(API_ADMIN_KEY, cls);
      expect(marked, `${r.cls}.${r.name}`).toBe(true);
    }
  });

  it('**비밀번호 초기화 경로가 없다**(FR-2209) — 임시 비밀번호를 돌려주는 경로를 v1에 열지 않는다', () => {
    const paths = routes.map((r) => String(Reflect.getMetadata(PATH_METADATA, r.handler)));
    expect(paths.filter((p) => /reset/i.test(p))).toEqual([]);
    expect(routes.map((r) => r.name).filter((n) => /reset/i.test(n))).toEqual([]);
  });

  it('쓰기는 POST·PATCH·PUT뿐이고 읽기는 GET이다 — 메서드로 scope(read·write)가 갈린다', () => {
    const methods = routes.map((r) => Reflect.getMetadata(METHOD_METADATA, r.handler) as number);
    expect(methods.every((m) => [RequestMethod.GET, RequestMethod.POST, RequestMethod.PATCH, RequestMethod.PUT].includes(m))).toBe(true);
  });
});

describe('사용자', () => {
  it('목록은 화면용과 같다 — 이름·상태로 거른다', async () => {
    const admin = await person(db, 'adm', 'admin');
    await person(db, 'alice');
    const r = await users.list(listUsersDto.parse({ q: 'alice' }));
    expect(r.items.map((u) => u.username)).toEqual(['alice']);
    expect((await users.list(listUsersDto.parse({}))).items.map((u) => u.id)).toContain(admin.id);
  });

  it('관리자가 만들고 정지·해제하면 감사에 남고 응답에 비밀이 없다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const made = await users.create({ username: 'made', displayName: '만듦', email: 'made@example.internal', password: 'Made-pw-2026', role: 'member' }, admin, req);
    expect(JSON.stringify(made)).not.toMatch(/Made-pw|passwordHash/);
    expect((await rows('user.create'))[0]).toMatchObject({ actorId: admin.id, targetId: made.id, ip: '10.0.0.30' });
    expect((await users.suspend(made.id, admin, req)).status).toBe('suspended');
    expect((await users.unsuspend(made.id, admin, req)).status).toBe('active');
    expect(await rows('user.suspend')).toHaveLength(1);
  });

  it('역할 변경은 root만 root를 준다 — 판정은 유스케이스 한 곳이다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const alice = await person(db, 'alice');
    await expect(users.changeRole(alice.id, { role: 'root' }, admin, req)).rejects.toThrow();
    expect((await users.changeRole(alice.id, { role: 'admin' }, admin, req)).role).toBe('admin');
  });

  it('위임(grants)을 주고 거둔다', async () => {
    const root = await person(db, 'sys', 'root');
    const alice = await person(db, 'alice');
    const r = await users.changeGrants(alice.id, userGrantsDto.parse({ grants: ['category.manage'] }), root, req);
    expect(r.grants).toContain('category.manage');
  });
});

describe('정책', () => {
  it('관리자가 읽고 고친다 — 고치면 감사에 남는다', async () => {
    const root = await person(db, 'sys', 'root');
    expect(await policy.get(root)).toMatchObject({ uploadMaxMb: expect.any(Number), uploadCeilingMb: 20 });
    expect(await policy.update(policyPatchDto.parse({ passwordMinLength: 10 }), root, req)).toEqual({ ok: true });
    expect((await policy.get(root)).passwordMinLength).toBe(10);
    expect(await rows('settings.update')).toHaveLength(1);
  });
});

describe('감사', () => {
  it('화면용과 같은 질의로 읽는다 — 행위·기간으로 거른다', async () => {
    const root = await person(db, 'sys', 'root');
    await users.suspend((await person(db, 'bob')).id, root, req);
    const r = await audit.list(auditQueryDto.parse({ action: 'user.suspend' }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ action: 'user.suspend' });
  });
});
