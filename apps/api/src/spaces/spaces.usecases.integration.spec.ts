import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { auditEvents, spaces } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { CategoryUseCases } from './categories.usecases';
import { SpaceUseCases } from './spaces.usecases';
import { SpacesService } from './spaces.service';

/**
 * 스페이스·Crew·분류의 유스케이스 (P2_설계서_Page 2절 — 쓰기는 감사와 같은 트랜잭션 · P15 C.2·C.3 · P16 · docs/spinoff/public-api 계획서 7.1절).
 * B등급 — 실제 PostgreSQL. 판정·잠금의 세부(중지를 건 사람, Crew 얼림, 분류 잠금)는 `spaces.integration.spec.ts`가 같은 유스케이스로 본다
 */

let db: TestDb;
let spacesSvc: SpacesService;
let uc: SpaceUseCases;
let cats: CategoryUseCases;
const META = { ip: '10.0.0.15' };
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const team = (me: Awaited<ReturnType<typeof person>>, name = '팀') => uc.create({ name, kind: 'team', categoryId: null, description: '' }, me, META);

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  const audit = new AuditService(db);
  uc = new SpaceUseCases(spacesSvc, audit, db);
  cats = new CategoryUseCases(audit, db);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('스페이스 만들기·고치기·지우기', () => {
  it('만들면 화면의 모양으로 돌려주고 감사에 이름·종류·IP가 남는다', async () => {
    const alice = await person(db, 'alice');
    const view = await team(alice, '운영팀');
    expect(view).toMatchObject({ name: '운영팀', kind: 'team', status: 'active' });
    expect((await rows('space.create'))[0]).toMatchObject({ actorId: alice.id, targetType: 'space', targetId: view.id, ip: META.ip, detail: { name: '운영팀', kind: 'team' } });
  });

  it('고치면 받은 내용 그대로 감사에 남고, 지우면 지우기 전의 이름이 남는다', async () => {
    const alice = await person(db, 'alice');
    const s = await team(alice);
    const view = await uc.update(s.id, { name: '새 이름', description: '설명' }, alice, META);
    expect(view).toMatchObject({ name: '새 이름', description: '설명' });
    expect((await rows('space.update'))[0]).toMatchObject({ targetId: s.id, ip: META.ip, detail: { name: '새 이름', description: '설명' } });

    await expect(uc.remove(s.id, alice, META)).resolves.toEqual({ ok: true });
    expect((await rows('space.delete'))[0]).toMatchObject({ targetId: s.id, ip: META.ip, detail: { name: '새 이름' } });
    const [row] = await db.select().from(spaces).where(eq(spaces.id, s.id));
    expect(row!.deletedAt).not.toBeNull();
  });

  it('권한이 없으면 막히고 감사가 남지 않는다', async () => {
    const alice = await person(db, 'alice');
    const bob = await person(db, 'bob');
    const s = await team(alice);
    await expect(uc.update(s.id, { name: 'x' }, bob, META)).rejects.toThrow();
    await expect(uc.remove(s.id, bob, META)).rejects.toThrow();
    expect(await rows('space.update')).toHaveLength(0);
    expect(await rows('space.delete')).toHaveLength(0);
  });
});

describe('상태 바꾸기 (P15 FR-1610)', () => {
  it('중지는 건 사람이 주인이었는지, 다시 쓰기는 풀린 중지가 누구 것이었는지 남기고, 같은 상태를 다시 보내면 감사가 없다', async () => {
    const alice = await person(db, 'alice');
    const s = await team(alice);
    const suspended = await uc.changeStatus(s.id, { status: 'suspended' }, alice, META);
    expect(suspended).toMatchObject({ status: 'suspended', suspendedByOwner: true });
    await uc.changeStatus(s.id, { status: 'suspended' }, alice, META);
    await uc.changeStatus(s.id, { status: 'active' }, alice, META);

    const all = await rows('space.status.change');
    expect(all.map((r) => r.detail)).toEqual([
      { status: 'suspended', byOwner: true },
      { status: 'active', wasByOwner: true },
    ]);
    expect(all[0]).toMatchObject({ actorId: alice.id, targetId: s.id, ip: META.ip });
  });

  it('주인이 건 중지를 관리자가 넘겨받으면 takeover가 남는다', async () => {
    const alice = await person(db, 'alice');
    const admin = await person(db, 'adm', 'admin');
    const s = await team(alice);
    await uc.changeStatus(s.id, { status: 'suspended' }, alice, META);
    const view = await uc.changeStatus(s.id, { status: 'suspended', takeover: true }, admin, META);
    expect(view.suspendedByOwner).toBe(false);
    expect((await rows('space.status.change')).map((r) => r.detail)).toEqual([
      { status: 'suspended', byOwner: true },
      { status: 'suspended', byOwner: false, takeover: true },
    ]);
  });
});

describe('Crew', () => {
  it('넣기·자리 바꾸기·빼기가 각각 감사에 남고 바뀐 Crew 목록을 돌려준다', async () => {
    const alice = await person(db, 'alice');
    const bob = await person(db, 'bob');
    const s = await team(alice);

    const added = await uc.addMember(s.id, { username: 'bob', role: 'editor' }, alice, META);
    expect(added.find((m) => m.userId === bob.id)).toMatchObject({ role: 'editor' });
    const changed = await uc.changeMemberRole(s.id, bob.id, 'viewer', alice, META);
    expect(changed.find((m) => m.userId === bob.id)).toMatchObject({ role: 'viewer' });
    const removed = await uc.removeMember(s.id, bob.id, alice, META);
    expect(removed.some((m) => m.userId === bob.id)).toBe(false);

    expect((await rows('space.member.add'))[0]).toMatchObject({ targetId: s.id, ip: META.ip, detail: { username: 'bob', role: 'editor' } });
    expect((await rows('space.member.role.change'))[0]!.detail).toEqual({ userId: bob.id, role: 'viewer' });
    expect((await rows('space.member.remove'))[0]!.detail).toEqual({ userId: bob.id });
  });

  it('관리자가 건 중지 동안 주인이 넣으면 막히고 감사가 남지 않는다 (P16)', async () => {
    const alice = await person(db, 'alice');
    const admin = await person(db, 'adm', 'admin');
    await person(db, 'bob');
    const s = await team(alice);
    await uc.changeStatus(s.id, { status: 'suspended' }, admin, META);
    await expect(uc.addMember(s.id, { username: 'bob', role: 'editor' }, alice, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await rows('space.member.add')).toHaveLength(0);
  });
});

describe('분류 (FR-532 · P15 C.3)', () => {
  it('만들면 감사에 남고, 같은 이름을 다시 만들면 있던 것을 돌려주며 감사를 더 남기지 않는다', async () => {
    const alice = await person(db, 'alice');
    const a = await cats.create({ name: '운영' }, alice, META);
    const b = await cats.create({ name: '운영' }, alice, META);
    expect(b.id).toBe(a.id);
    const all = await rows('category.create');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ actorId: alice.id, targetType: 'category', targetId: a.id, ip: META.ip, detail: { name: '운영' } });
  });

  it('이름을 바꾸면 이전·이후가, 지우면 분류 없음이 된 공간이 감사에 남는다', async () => {
    const alice = await person(db, 'alice');
    const c = await cats.create({ name: '운영' }, alice, META);
    const s = await uc.create({ name: 'a 공간', kind: 'team', categoryId: c.id, description: '' }, alice, META);
    await expect(cats.rename(c.id, { name: '운영2' }, alice, META)).resolves.toMatchObject({ name: '운영2' });
    expect((await rows('category.update'))[0]).toMatchObject({ targetId: c.id, ip: META.ip, detail: { before: '운영', after: '운영2' } });

    await expect(cats.remove(c.id, alice, META)).resolves.toEqual({ ok: true });
    expect((await rows('category.delete'))[0]).toMatchObject({ ip: META.ip, detail: { name: '운영2', cleared: [{ id: s.id, name: 'a 공간', deleted: false }] } });
    expect((await cats.list(alice)).some((x) => x.id === c.id)).toBe(false);
  });

  it('만든 사람이 아니면 막히고 감사가 남지 않는다', async () => {
    const alice = await person(db, 'alice');
    const bob = await person(db, 'bob');
    const c = await cats.create({ name: '운영' }, alice, META);
    await expect(cats.rename(c.id, { name: 'x' }, bob, META)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(cats.remove(c.id, bob, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await rows('category.update')).toHaveLength(0);
    expect(await rows('category.delete')).toHaveLength(0);
  });
});
