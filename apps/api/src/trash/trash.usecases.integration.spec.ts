import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { auditEvents, pages, spaces } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { TrashUseCases } from './trash.usecases';
import { TrashService } from './trash.service';

/** 휴지통 되살리기의 유스케이스 (P4_설계서_Admin C절, FR-514 · docs/spinoff/public-api 계획서 7.1절). B등급 — 실제 PostgreSQL */

let db: TestDb;
let spacesSvc: SpacesService;
let uc: TrashUseCases;
const META = { ip: '10.0.0.9' };
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  uc = new TrashUseCases(new TrashService(db, spacesSvc), new AuditService(db), db);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('페이지 되살리기', () => {
  it('되살리고 감사에 제목·뿌리로 옮겼는지·IP를 남긴다', async () => {
    const me = await person(db, 'me');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);
    const [p] = await db
      .insert(pages)
      .values({ spaceId: sp.id, parentId: null, title: '회의록', position: 0, currentVersionNo: 1, searchText: '', createdBy: me.id, updatedBy: me.id, deletedAt: new Date() })
      .returning();

    expect(await uc.restorePage(p!.id, me, META)).toEqual({ ok: true, movedToRoot: false });
    expect((await db.query.pages.findFirst({ where: eq(pages.id, p!.id) }))?.deletedAt).toBeNull();
    const [r] = await rows('page.restore.trash');
    expect(r).toMatchObject({ actorId: me.id, targetType: 'page', targetId: p!.id, ip: META.ip, detail: { title: '회의록', movedToRoot: false } });
  });
});

describe('스페이스 되살리기', () => {
  it('관리자가 되살리면 감사에 이름을 남긴다', async () => {
    const owner = await person(db, 'owner');
    const admin = await person(db, 'adm', 'admin');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));

    await uc.restoreSpace(sp.id, admin, META);
    const [r] = await rows('space.restore');
    expect(r).toMatchObject({ actorId: admin.id, targetType: 'space', targetId: sp.id, ip: META.ip, detail: { name: '팀' } });
  });

  it('주인은 못 하고 감사가 남지 않는다', async () => {
    const owner = await person(db, 'owner');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));
    await expect(uc.restoreSpace(sp.id, owner, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await rows('space.restore')).toHaveLength(0);
  });
});
