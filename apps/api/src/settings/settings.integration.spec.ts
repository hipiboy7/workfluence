import { POLICY_DEFAULTS, SETTINGS_KEYS, type AppEnv, type Principal } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings, users } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { SettingsService } from './settings.service';

/** B등급 (P4_설계서_Admin E절). 실제 PostgreSQL. */

let db: TestDb;
const env = (over: Record<string, unknown> = {}) =>
  ({
    WF_UPLOAD_MAX_MB: 20,
    WF_SESSION_IDLE_MINUTES: 30,
    WF_SESSION_ABSOLUTE_HOURS: 12,
    WF_TRASH_RETENTION_DAYS: 30,
    WF_AUDIT_RETENTION_DAYS: 365,
    ...over,
  }) as unknown as AppEnv;

const svcWith = (over: Record<string, unknown> = {}) => new SettingsService(db, env(over));

async function admin(): Promise<Principal> {
  const [u] = await db.insert(users).values({ username: 'adm', displayName: 'adm', passwordHash: 'x', role: 'admin', status: 'active' }).returning();
  return { id: u.id, role: 'admin' };
}

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('세 겹의 출처 (FR-522·527)', () => {
  it('DB가 비면 환경변수를 쓴다', async () => {
    expect((await svcWith({ WF_UPLOAD_MAX_MB: 42 }).get()).uploadMaxMb).toBe(42);
  });

  it('환경변수가 없는 값은 코드 기본값이다 — DB도 .env도 비어도 기동한다', async () => {
    const p = await svcWith().get();
    expect(p.passwordMinLength).toBe(POLICY_DEFAULTS.passwordMinLength);
    expect(p.allowedExtensions).toEqual(POLICY_DEFAULTS.allowedExtensions);
  });

  it('DB 값이 환경변수를 덮는다', async () => {
    const me = await admin();
    const svc = svcWith({ WF_UPLOAD_MAX_MB: 100 });
    await svc.update({ uploadMaxMb: 5 }, me);
    expect((await svc.get()).uploadMaxMb).toBe(5);
  });

  it('**DB 한 줄이 망가져도 기동한다** — 읽기는 너그럽고 쓰기가 엄격하다', async () => {
    const me = await admin();
    await db.insert(settings).values({ key: SETTINGS_KEYS.policy, value: { uploadMaxMb: 'big', whoKnows: 1 }, updatedBy: me.id });
    const p = await svcWith({ WF_UPLOAD_MAX_MB: 20 }).get();
    expect(p.uploadMaxMb).toBe(20);
  });
});

describe('변경 (FR-523~526)', () => {
  it('바꾸면 **재기동 없이** 다음 읽기부터 먹는다 (NFR-40)', async () => {
    const me = await admin();
    const svc = svcWith();
    expect((await svc.get()).sessionIdleMinutes).toBe(30);
    await svc.update({ sessionIdleMinutes: 90 }, me);
    expect((await svc.get()).sessionIdleMinutes).toBe(90);
  });

  it('바뀐 키의 이전·이후를 돌려준다 — 감사로그에 그대로 들어간다 (FR-525)', async () => {
    const me = await admin();
    const { before, after } = await svcWith().update({ sessionIdleMinutes: 90 }, me);
    expect(before).toEqual({ sessionIdleMinutes: 30 });
    expect(after).toEqual({ sessionIdleMinutes: 90 });
  });

  it('**안 바꾼 키는 이전·이후에 없다** — 감사로그가 전체 덤프가 되면 무엇이 바뀌었는지 안 보인다', async () => {
    const me = await admin();
    const { after } = await svcWith().update({ trashRetentionDays: 7 }, me);
    expect(Object.keys(after)).toEqual(['trashRetentionDays']);
  });

  it('두 번 바꾸면 앞의 것이 남는다 — 통째로 덮어쓰지 않는다', async () => {
    const me = await admin();
    const svc = svcWith();
    await svc.update({ sessionIdleMinutes: 90 }, me);
    await svc.update({ trashRetentionDays: 7 }, me);
    const p = await svc.get();
    expect(p.sessionIdleMinutes).toBe(90);
    expect(p.trashRetentionDays).toBe(7);
  });

  it('범위를 벗어나면 400', async () => {
    const me = await admin();
    await expect(svcWith().update({ uploadMaxMb: 0 }, me)).rejects.toThrow(/uploadMaxMb/);
    await expect(svcWith().update({}, me)).rejects.toThrow(/바꿀 값이 없다/);
  });

  it('**업로드 상한은 이 서버의 천장을 못 넘는다** — 넘으면 multer가 앞에서 자르고 "바꿨는데 안 먹는" 상태가 된다', async () => {
    const me = await admin();
    await expect(svcWith({ WF_UPLOAD_MAX_MB: 20 }).update({ uploadMaxMb: 50 }, me)).rejects.toThrow(/천장/);
  });

  it('누가 바꿨는지 남는다', async () => {
    const me = await admin();
    await svcWith().update({ trashRetentionDays: 7 }, me);
    const row = await db.query.settings.findFirst({ where: eq(settings.key, SETTINGS_KEYS.policy) });
    expect(row?.updatedBy).toBe(me.id);
  });
});
