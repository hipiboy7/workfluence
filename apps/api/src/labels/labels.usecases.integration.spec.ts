import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import { auditEvents, pages } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { LabelUseCases } from './labels.usecases';
import { LabelsService } from './labels.service';

/** 라벨 붙이기·떼기의 유스케이스 (P4_설계서_Admin C절 · docs/spinoff/public-api 계획서 7.1절). B등급 — 실제 PostgreSQL */

let db: TestDb;
let spacesSvc: SpacesService;
let uc: LabelUseCases;
const META = { ip: '10.0.0.8' };

async function pageIn(me: SessionUser): Promise<string> {
  const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);
  const [p] = await db
    .insert(pages)
    .values({ spaceId: sp.id, parentId: null, title: 'T', position: 0, currentVersionNo: 1, searchText: '', createdBy: me.id, updatedBy: me.id })
    .returning();
  return p!.id;
}
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  uc = new LabelUseCases(new LabelsService(db, spacesSvc), new AuditService(db), db);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('붙이기', () => {
  it('붙인 라벨을 돌려주고 감사에 페이지·라벨 이름·IP를 남긴다', async () => {
    const me = await person(db, 'me');
    const pid = await pageIn(me);
    const label = await uc.attach(pid, ' Report ', me, META);
    expect(label.name).toBe('report');
    const [r] = await rows('label.attach');
    expect(r).toMatchObject({ actorId: me.id, targetType: 'page', targetId: pid, ip: META.ip, detail: { label: 'report' } });
  });

  it('볼 수 없는 페이지면 막히고 감사가 남지 않는다', async () => {
    const owner = await person(db, 'owner');
    const other = await person(db, 'other');
    const pid = await pageIn(owner);
    await expect(uc.attach(pid, 'x', other, META)).rejects.toThrow();
    expect(await rows('label.attach')).toHaveLength(0);
  });
});

describe('떼기', () => {
  it('떼고 감사에 라벨 id를 남긴다', async () => {
    const me = await person(db, 'me');
    const pid = await pageIn(me);
    const label = await uc.attach(pid, '회의록', me, META);
    await uc.detach(pid, label.id, me, META);
    const [r] = await rows('label.detach');
    expect(r).toMatchObject({ actorId: me.id, targetType: 'page', targetId: pid, ip: META.ip, detail: { labelId: label.id } });
  });

  it('남의 페이지에서는 막히고 감사가 남지 않는다', async () => {
    const owner = await person(db, 'owner');
    const other = await person(db, 'other');
    const pid = await pageIn(owner);
    const label = await uc.attach(pid, '회의록', owner, META);
    await expect(uc.detach(pid, label.id, other, META)).rejects.toThrow();
    expect(await rows('label.detach')).toHaveLength(0);
  });
});
