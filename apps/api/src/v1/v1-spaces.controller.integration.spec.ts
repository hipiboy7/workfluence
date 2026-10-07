import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v1AddMemberDto, v1CategoryDto, v1CreateSpaceDto, v1MemberRoleDto, v1SpaceListQuery, v1SpaceStatusDto, v1UpdateSpaceDto } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import { auditEvents } from '../db/schema';
import { CategoryUseCases } from '../spaces/categories.usecases';
import { SpaceUseCases } from '../spaces/spaces.usecases';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { V1CategoriesController, V1SpacesController } from './v1-spaces.controller';

/**
 * 공개 API v1의 스페이스·Crew·분류 (docs/spinoff/public-api 설계서 3.3·3.5절 · FR-2210·2223). B등급 — 실제 PostgreSQL. 컨트롤러는 화면용과 같은
 * 유스케이스를 부르는 얇은 층이고, 여기서 보는 것은 **에이전트용 단순 계약**이다 — 이름만으로 만들기, 분류는 이름으로 고르기, Crew는 사용자 이름으로
 * 다루기, 기본 역할은 editor.
 */

let db: TestDb;
let spacesSvc: SpacesService;
let spaces: V1SpacesController;
let categories: V1CategoriesController;
const req = { ip: '10.0.0.18' } as never;
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  const audit = new AuditService(db);
  const cats = new CategoryUseCases(audit, db);
  spaces = new V1SpacesController(spacesSvc, new SpaceUseCases(spacesSvc, audit, db), cats);
  categories = new V1CategoriesController(cats);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

const create = (dto: Record<string, unknown>) => v1CreateSpaceDto.parse(dto);
const query = (q: Record<string, unknown> = {}) => v1SpaceListQuery.parse(q);
const codeOf = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body: Record<string, unknown> }> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(HttpException);
  const h = e as HttpException;
  const body = (typeof h.getResponse() === 'string' ? { message: h.getResponse() } : h.getResponse()) as Record<string, unknown>;
  return { status: h.getStatus(), code: body.code as string | undefined, body };
};

describe('스페이스 만들기 — 이름만으로 (FR-2223)', () => {
  it('이름만 주면 내가 주인인 활성 팀 스페이스가 된다', async () => {
    const owner = await person(db, 'owner');
    const s = await spaces.create(create({ name: '장애 보고' }), owner, req);
    expect(s).toMatchObject({ name: '장애 보고', kind: 'team', status: 'active', description: '', category: null, myRole: 'owner', canWrite: true, canManageMembers: true, memberCount: 1 });
    expect((await rows('space.create'))[0]).toMatchObject({ actorId: owner.id, targetId: s.id, ip: '10.0.0.18', detail: { name: '장애 보고', kind: 'team' } });
  });

  it('**분류를 이름으로 고른다**', async () => {
    const owner = await person(db, 'owner');
    await categories.create(v1CategoryDto.parse({ name: '운영' }), owner, req);
    const s = await spaces.create(create({ name: 's', category: '운영' }), owner, req);
    expect(s.category).toBe('운영');
    expect(s.categoryId).toEqual(expect.any(String));
  });

  it('없는 분류는 404 CATEGORY_NOT_FOUND — 고를 수 있는 이름을 알려 준다', async () => {
    const owner = await person(db, 'owner');
    await categories.create(v1CategoryDto.parse({ name: '운영' }), owner, req);
    await categories.create(v1CategoryDto.parse({ name: '개발' }), owner, req);
    const r = await codeOf(spaces.create(create({ name: 's', category: '없는 분류' }), owner, req));
    expect(r).toMatchObject({ status: 404, code: 'CATEGORY_NOT_FOUND' });
    expect((r.body.details as { available: string[] }).available.sort()).toEqual(['개발', '운영']);
    expect(await rows('space.create')).toHaveLength(0);
  });

  it('분류 이름의 대소문자·빈칸은 정확히 맞는 것이 없을 때만 무시한다', async () => {
    const owner = await person(db, 'owner');
    await categories.create(v1CategoryDto.parse({ name: 'Ops' }), owner, req);
    expect((await spaces.create(create({ name: 's', category: ' ops ' }), owner, req)).category).toBe('Ops');
  });
});

describe('목록·읽기', () => {
  it('내가 읽을 수 있는 스페이스만 — 이름으로 찾고 limit로 자른다', async () => {
    const owner = await person(db, 'owner');
    const other = await person(db, 'other');
    await spaces.create(create({ name: '장애 보고' }), owner, req);
    await spaces.create(create({ name: '인사 규정' }), owner, req);
    await spaces.create(create({ name: '남의 공간' }), other, req);
    expect((await spaces.list(query(), owner)).items.map((s) => s.name).sort()).toEqual(['인사 규정', '장애 보고']);
    expect((await spaces.list(query({ q: '장애' }), owner)).items.map((s) => s.name)).toEqual(['장애 보고']);
    expect((await spaces.list(query({ limit: '1' }), owner)).items).toHaveLength(1);
  });

  it('id로 읽는다 — 볼 수 없으면 404', async () => {
    const owner = await person(db, 'owner');
    const mallory = await person(db, 'mallory');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    expect((await spaces.get(s.id, owner)).id).toBe(s.id);
    await expect(spaces.get(s.id, mallory)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('응답은 에이전트가 쓸 것만 — 내부 열쇠·만든 사람 정보는 없다', async () => {
    const owner = await person(db, 'owner');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    for (const k of ['key', 'access', 'createdBy', 'createdByUsername', 'suspendedByOwner']) expect(s).not.toHaveProperty(k);
  });
});

describe('고치기·상태·지우기', () => {
  it('고칠 것만 고친다 — 분류는 null이면 지운다', async () => {
    const owner = await person(db, 'owner');
    await categories.create(v1CategoryDto.parse({ name: '운영' }), owner, req);
    const s = await spaces.create(create({ name: '옛 이름', description: '설명', category: '운영' }), owner, req);
    const a = await spaces.update(s.id, v1UpdateSpaceDto.parse({ name: '새 이름' }), owner, req);
    expect(a).toMatchObject({ name: '새 이름', description: '설명', category: '운영' });
    const b = await spaces.update(s.id, v1UpdateSpaceDto.parse({ category: null }), owner, req);
    expect(b).toMatchObject({ name: '새 이름', category: null, categoryId: null });
    expect((await rows('space.update')).length).toBe(2);
  });

  it('없는 분류로 고치면 404 CATEGORY_NOT_FOUND', async () => {
    const owner = await person(db, 'owner');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    expect(await codeOf(spaces.update(s.id, v1UpdateSpaceDto.parse({ category: '없음' }), owner, req))).toMatchObject({ status: 404, code: 'CATEGORY_NOT_FOUND' });
  });

  it('주인이 아니면 고치지 못한다(403)', async () => {
    const owner = await person(db, 'owner');
    const bob = await person(db, 'bob');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    await spaces.addMember(s.id, v1AddMemberDto.parse({ username: 'bob' }), owner, req);
    await expect(spaces.update(s.id, v1UpdateSpaceDto.parse({ name: 'x' }), bob, req)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('중지하고 다시 쓴다', async () => {
    const owner = await person(db, 'owner');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    expect((await spaces.changeStatus(s.id, v1SpaceStatusDto.parse({ status: 'suspended' }), owner, req)).status).toBe('suspended');
    expect((await spaces.changeStatus(s.id, v1SpaceStatusDto.parse({ status: 'active' }), owner, req)).status).toBe('active');
    expect(await rows('space.status.change')).toHaveLength(2);
  });

  it('지우면 읽히지 않는다 — 휴지통으로 간다', async () => {
    const owner = await person(db, 'owner');
    const s = await spaces.create(create({ name: '지울 곳' }), owner, req);
    await expect(spaces.remove(s.id, owner, req)).resolves.toEqual({ ok: true });
    await expect(spaces.get(s.id, owner)).rejects.toBeInstanceOf(NotFoundException);
    expect((await rows('space.delete'))[0]).toMatchObject({ detail: { name: '지울 곳' } });
  });
});

describe('Crew — 사용자 이름으로, 기본은 editor', () => {
  it('이름만 주면 editor로 들어오고 목록은 아이디·표시 이름·역할을 준다', async () => {
    const owner = await person(db, 'owner');
    await person(db, 'bob', 'member', { displayName: '밥' });
    const s = await spaces.create(create({ name: 's' }), owner, req);
    const list = await spaces.addMember(s.id, v1AddMemberDto.parse({ username: 'bob' }), owner, req);
    expect(list.find((m) => m.username === 'bob')).toMatchObject({ displayName: '밥', role: 'editor' });
    expect(list.find((m) => m.username === 'bob')).not.toHaveProperty('createdAt');
    expect((await spaces.members(s.id, owner)).map((m) => m.username).sort()).toEqual(['bob', 'owner']);
    expect((await rows('space.member.add'))[0]).toMatchObject({ ip: '10.0.0.18' });
  });

  it('자리를 바꾸고 뺀다 — **사용자 이름으로도 id로도**', async () => {
    const owner = await person(db, 'owner');
    const bob = await person(db, 'bob');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    await spaces.addMember(s.id, v1AddMemberDto.parse({ username: 'bob' }), owner, req);
    const viewer = await spaces.changeMemberRole(s.id, 'bob', v1MemberRoleDto.parse({ role: 'viewer' }), owner, req);
    expect(viewer.find((m) => m.username === 'bob')?.role).toBe('viewer');
    const back = await spaces.changeMemberRole(s.id, bob.id, v1MemberRoleDto.parse({ role: 'editor' }), owner, req);
    expect(back.find((m) => m.username === 'bob')?.role).toBe('editor');
    const after = await spaces.removeMember(s.id, 'BOB', owner, req);
    expect(after.map((m) => m.username)).toEqual(['owner']);
  });

  it('Crew에 없는 사람은 404 MEMBER_NOT_FOUND', async () => {
    const owner = await person(db, 'owner');
    await person(db, 'carol');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    expect(await codeOf(spaces.removeMember(s.id, 'carol', owner, req))).toMatchObject({ status: 404, code: 'MEMBER_NOT_FOUND' });
    expect(await codeOf(spaces.changeMemberRole(s.id, 'nobody', v1MemberRoleDto.parse({ role: 'viewer' }), owner, req))).toMatchObject({ code: 'MEMBER_NOT_FOUND' });
  });

  it('주인이 아니면 넣지 못한다(403)', async () => {
    const owner = await person(db, 'owner');
    const bob = await person(db, 'bob');
    await person(db, 'carol');
    const s = await spaces.create(create({ name: 's' }), owner, req);
    await spaces.addMember(s.id, v1AddMemberDto.parse({ username: 'bob' }), owner, req);
    await expect(spaces.addMember(s.id, v1AddMemberDto.parse({ username: 'carol' }), bob, req)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('분류', () => {
  it('만들기는 이름만이고 같은 이름이면 있던 것이다(멱등)', async () => {
    const owner = await person(db, 'owner');
    const a = await categories.create(v1CategoryDto.parse({ name: '운영' }), owner, req);
    const b = await categories.create(v1CategoryDto.parse({ name: '운영' }), owner, req);
    expect(a.id).toBe(b.id);
    expect(a).toEqual({ id: a.id, name: '운영', canRename: true, canDelete: true });
  });

  it('목록·이름 바꾸기·지우기', async () => {
    const owner = await person(db, 'owner');
    const c = await categories.create(v1CategoryDto.parse({ name: '옛' }), owner, req);
    expect((await categories.list(owner)).map((x) => x.name)).toEqual(['옛']);
    expect((await categories.rename(c.id, v1CategoryDto.parse({ name: '새' }), owner, req)).name).toBe('새');
    await expect(categories.remove(c.id, owner, req)).resolves.toEqual({ ok: true });
    expect(await categories.list(owner)).toEqual([]);
  });

  it('남의 공간이 쓰는 분류는 만든 사람도 지우지 못한다(403) — 화면용과 같은 규칙', async () => {
    const owner = await person(db, 'owner');
    const other = await person(db, 'other');
    const c = await categories.create(v1CategoryDto.parse({ name: '공용' }), owner, req);
    await spaces.create(create({ name: '남의 공간', category: '공용' }), other, req);
    await expect(categories.remove(c.id, owner, req)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
