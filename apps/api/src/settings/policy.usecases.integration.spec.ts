import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AppEnv } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import { auditEvents, users } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { PolicyUseCases } from './policy.usecases';
import { SettingsService } from './settings.service';

/**
 * 운영 정책값의 유스케이스 (P4_설계서_Admin C절 · docs/spinoff/public-api 계획서 7.1절). 화면용 경로와 공개 API가 **같은 것**을 부른다.
 * B등급 — 실제 PostgreSQL.
 */

let db: TestDb;
let svc: SettingsService;
let uc: PolicyUseCases;
const META = { ip: '10.0.0.7' };

const env = { WF_UPLOAD_MAX_MB: 20, WF_SESSION_IDLE_MINUTES: 30, WF_SESSION_ABSOLUTE_HOURS: 12, WF_TRASH_RETENTION_DAYS: 30, WF_AUDIT_RETENTION_DAYS: 365 } as unknown as AppEnv;

async function person(role: 'member' | 'admin' | 'root'): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ username: role, displayName: role, passwordHash: 'x', role, status: 'active' }).returning();
  return { id: u!.id, username: role, displayName: role, role, mustChangePassword: false, grants: [], hasPassword: true };
}

const changes = () => db.select().from(auditEvents).where(eq(auditEvents.action, 'settings.update'));

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  svc = new SettingsService(db, env);
  uc = new PolicyUseCases(svc, new AuditService(db, svc), db);
});

describe('읽기', () => {
  it('일반 사용자에게는 지켜야 할 것만 준다 — 잠금·세션 값은 주지 않는다', async () => {
    const p = await uc.read(await person('member'));
    expect(Object.keys(p).sort()).toEqual(['allowedExtensions', 'passwordMinCharClasses', 'passwordMinLength', 'uploadCeilingMb', 'uploadMaxMb']);
    expect(p.uploadCeilingMb).toBe(20);
  });

  it('settings.manage가 있으면 전부와 서버 천장을 준다', async () => {
    const p = await uc.read(await person('admin'));
    expect(p).toMatchObject({ lockoutThreshold: expect.any(Number), sessionIdleMinutes: expect.any(Number), auditLevel: 3, uploadCeilingMb: 20 });
  });
});

describe('바꾸기', () => {
  it('바꾸고, 바뀐 키의 이전·이후와 IP를 감사에 남기고, 커밋 뒤에 캐시를 버린다', async () => {
    const me = await person('admin');
    await svc.get();
    expect(svc.peek()).not.toBeNull();

    await uc.update({ trashRetentionDays: 40 }, me, META);

    expect(svc.peek()).toBeNull();
    expect((await svc.get()).trashRetentionDays).toBe(40);
    const [row] = await changes();
    expect(row).toMatchObject({ actorId: me.id, targetType: 'settings', targetId: 'policy', ip: META.ip });
    expect(row!.detail).toEqual({ before: { trashRetentionDays: 30 }, after: { trashRetentionDays: 40 } });
  });

  it('**감사 기록 단계는 시스템 관리자만** — 관리자는 403, 값도 감사도 그대로', async () => {
    const me = await person('admin');
    await expect(uc.update({ auditLevel: 1 }, me, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await svc.get()).auditLevel).toBe(3);
    expect(await changes()).toHaveLength(0);
  });

  it('시스템 관리자는 단계를 바꾼다', async () => {
    const root = await person('root');
    await uc.update({ auditLevel: 1 }, root, META);
    expect((await svc.get()).auditLevel).toBe(1);
    expect((await changes())[0]!.detail).toEqual({ before: { auditLevel: 3 }, after: { auditLevel: 1 } });
  });

  it('범위 밖의 값은 400이고 감사가 남지 않는다', async () => {
    const me = await person('admin');
    await expect(uc.update({ passwordMinLength: 7 }, me, META)).rejects.toBeInstanceOf(BadRequestException);
    await expect(uc.update({ uploadMaxMb: 21 }, me, META)).rejects.toBeInstanceOf(BadRequestException);
    expect(await changes()).toHaveLength(0);
  });
});
