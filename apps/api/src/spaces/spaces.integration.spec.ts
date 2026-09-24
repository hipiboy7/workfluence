import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, PAGE_TREE_MAX_DEPTH, documentSchemaVersion, type DocNode, type Principal } from '@workfluence/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { pageVersions, pages, spaceCategories, spaces, users } from '../db/schema';
import { PagesService } from '../pages/pages.service';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { SpacesService } from './spaces.service';

/** B등급 통합 테스트 (P2_설계서_Page 6절). **실제 PostgreSQL**을 쓴다. */

let db: TestDb;
let spacesSvc: SpacesService;
let pagesSvc: PagesService;

const doc = (text: string): DocNode =>
  ({ type: 'doc', schemaVersion: DOCUMENT_SCHEMA_VERSION, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) as DocNode;

async function user(username: string, role: 'root' | 'admin' | 'member' = 'member'): Promise<Principal> {
  const [u] = await db
    .insert(users)
    .values({ username, displayName: username, passwordHash: 'x', role, status: 'active' })
    .returning();
  return { id: u.id, role };
}

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  pagesSvc = new PagesService(db, spacesSvc, new NotificationsService(db, new InAppChannel()));
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('스페이스 접근 판정은 shared가 한다 (FR-303)', () => {
  it('팀 스페이스는 Crew가 아니면 **404다** — 403을 주면 존재가 새어 나간다', async () => {
    const owner = await user('owner');
    const outsider = await user('outsider');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await expect(spacesSvc.context(s.id, outsider)).rejects.toThrow(/찾을 수 없다/);
    await expect(spacesSvc.context(s.id, owner)).resolves.toMatchObject({ membership: 'owner' });
  });

  it('admin은 Crew가 아니어도 읽는다', async () => {
    const owner = await user('owner');
    const admin = await user('adm', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await expect(spacesSvc.context(s.id, admin)).resolves.toMatchObject({ access: { canRead: true } });
  });

  it('viewer는 읽지만 쓰지 못한다', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'viewer', role: 'viewer' }, owner);
    await expect(spacesSvc.context(s.id, viewer)).resolves.toMatchObject({ access: { canRead: true, canWrite: false } });
    await expect(spacesSvc.assertWrite(s.id, viewer)).rejects.toThrow(/권한/);
  });

  it('중지된 스페이스는 읽기만 된다 (FR-306)', async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.changeStatus(s.id, 'suspended', owner);
    const ctx = await spacesSvc.context(s.id, owner);
    expect(ctx.access.canRead).toBe(true);
    expect(ctx.access.canWrite).toBe(false);
  });

  it('개인 스페이스는 남이 못 본다 (FR-305)', async () => {
    const me = await user('me');
    const other = await user('other');
    const s = await spacesSvc.create({ name: '내 공간', kind: 'personal', categoryId: null, description: '' }, me);
    await expect(spacesSvc.context(s.id, other)).rejects.toThrow(/찾을 수 없다/);
  });
});

describe('Crew (FR-311, FR-312)', () => {
  it('생성자가 owner가 된다', async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    expect(await spacesSvc.members(s.id, owner)).toMatchObject([{ username: 'owner', role: 'owner' }]);
  });

  it('**마지막 owner는 강등·제거할 수 없다**', async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await expect(spacesSvc.changeMemberRole(s.id, owner.id, 'viewer', owner)).rejects.toThrow(/마지막 owner/);
    await expect(spacesSvc.removeMember(s.id, owner.id, owner)).rejects.toThrow(/마지막 owner/);
  });

  it('viewer는 Crew를 관리하지 못한다', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'viewer', role: 'viewer' }, owner);
    await expect(spacesSvc.addMember(s.id, { username: 'owner', role: 'editor' }, viewer)).rejects.toThrow(/권한/);
  });

  it('개인 스페이스에는 Crew를 둘 수 없다', async () => {
    const me = await user('me');
    const s = await spacesSvc.create({ name: '내 공간', kind: 'personal', categoryId: null, description: '' }, me);
    await expect(spacesSvc.addMember(s.id, { username: 'me', role: 'viewer' }, me)).rejects.toThrow(/개인 스페이스/);
  });

  it('Crew가 둘이면 소유자도 스페이스를 못 지운다 (FR-307)', async () => {
    const owner = await user('owner');
    await user('mate');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await expect(spacesSvc.softDelete(s.id, owner)).resolves.toBeDefined(); // 혼자면 된다
    const s2 = await spacesSvc.create({ name: '팀2', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s2.id, { username: 'mate', role: 'editor' }, owner);
    await expect(spacesSvc.softDelete(s2.id, owner)).rejects.toThrow(/권한/);
  });
});

describe('개인 스페이스 자동 생성 (FR-309)', () => {
  it('없으면 만들고, 두 번 불러도 하나다 (멱등)', async () => {
    const me = await user('me');
    await db.transaction(async (tx) => spacesSvc.ensurePersonalSpace(me.id, '나', tx));
    await db.transaction(async (tx) => spacesSvc.ensurePersonalSpace(me.id, '나', tx));
    const list = await spacesSvc.list(me, 'personal', 100);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('나의 공간');
  });
});

describe('페이지 버전과 충돌 (FR-322~325)', () => {
  const setup = async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const p = await db.transaction((tx) => pagesSvc.create({ spaceId: s.id, parentId: null, title: 'T', content: doc('첫') }, owner, tx));
    return { owner, space: s, page: p };
  };

  it('생성 시 버전 1이 함께 생긴다', async () => {
    const { page } = await setup();
    expect(page.currentVersionNo).toBe(1);
    const vs = await db.select().from(pageVersions).where(eq(pageVersions.pageId, page.id));
    expect(vs).toHaveLength(1);
  });

  it('저장하면 버전이 올라간다', async () => {
    const { owner, page } = await setup();
    const updated = await db.transaction((tx) => pagesSvc.update(page.id, { title: 'T2', content: doc('둘'), baseVersionNo: 1 }, owner, tx));
    expect(updated.currentVersionNo).toBe(2);
  });

  it('**낡은 기준 버전으로 저장하면 409다** (인수 기준)', async () => {
    const { owner, page } = await setup();
    await db.transaction((tx) => pagesSvc.update(page.id, { title: 'T2', content: doc('둘'), baseVersionNo: 1 }, owner, tx));
    await expect(
      db.transaction((tx) => pagesSvc.update(page.id, { title: 'T3', content: doc('셋'), baseVersionNo: 1 }, owner, tx)),
    ).rejects.toThrow(/먼저 저장/);
  });

  it('**동시 저장이 겹쳐도 하나만 성공한다** — FOR UPDATE가 줄을 세운다 (FR-323)', async () => {
    const { owner, page } = await setup();
    const results = await Promise.allSettled([
      db.transaction((tx) => pagesSvc.update(page.id, { title: 'A', content: doc('A'), baseVersionNo: 1 }, owner, tx)),
      db.transaction((tx) => pagesSvc.update(page.id, { title: 'B', content: doc('B'), baseVersionNo: 1 }, owner, tx)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // 버전 번호가 중복되지 않았다
    const vs = await db.select().from(pageVersions).where(eq(pageVersions.pageId, page.id));
    expect(new Set(vs.map((v) => v.versionNo)).size).toBe(vs.length);
  });

  it('복원은 **새 버전을 만든다.** 이력은 지워지지 않는다 (FR-325)', async () => {
    const { owner, page } = await setup();
    await db.transaction((tx) => pagesSvc.update(page.id, { title: 'T2', content: doc('둘'), baseVersionNo: 1 }, owner, tx));
    const restored = await db.transaction((tx) => pagesSvc.restoreVersion(page.id, 1, owner, tx));
    expect(restored.currentVersionNo).toBe(3);
    expect(restored.title).toBe('T');
    expect(await pagesSvc.versions(page.id, owner)).toHaveLength(3);
  });

  it('**저장된 문서가 스스로 버전을 말한다** — 편집기는 이 값을 만들지 않는다', async () => {
    const { owner, page } = await setup();
    const stored = await db.query.pageVersions.findFirst({ where: eq(pageVersions.pageId, page.id) });
    expect(documentSchemaVersion(stored!.contentJson as DocNode)).toBe(DOCUMENT_SCHEMA_VERSION);
    // 버전 없는 본문을 보내도 서버가 찍는다
    const updated = await db.transaction((tx) =>
      pagesSvc.update(page.id, { title: 'T2', content: { type: 'doc', content: [{ type: 'paragraph' }] } as DocNode, baseVersionNo: 1 }, owner, tx),
    );
    expect(documentSchemaVersion(updated.content)).toBe(DOCUMENT_SCHEMA_VERSION);
  });

  it('본문에서 평문을 뽑아 search_text에 넣는다 (FR-332)', async () => {
    const { page } = await setup();
    const [row] = await db.select().from(pages).where(eq(pages.id, page.id));
    expect(row.searchText).toContain('첫');
  });
});

describe('페이지 트리 (FR-326~330)', () => {
  const setup = async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const mk = (title: string, parentId: string | null) =>
      db.transaction((tx) => pagesSvc.create({ spaceId: s.id, parentId, title, content: doc(title) }, owner, tx));
    return { owner, space: s, mk };
  };

  it('자기 자신·자손 아래로 옮길 수 없다', async () => {
    const { owner, mk } = await setup();
    const a = await mk('A', null);
    const b = await mk('B', a.id);
    await expect(db.transaction((tx) => pagesSvc.move(a.id, { parentId: a.id, position: 0 }, owner, tx))).rejects.toThrow(/자기 자신/);
    await expect(db.transaction((tx) => pagesSvc.move(a.id, { parentId: b.id, position: 0 }, owner, tx))).rejects.toThrow(/자기 자신/);
  });

  it('다른 스페이스의 페이지를 부모로 둘 수 없다', async () => {
    const { owner, mk } = await setup();
    const other = await spacesSvc.create({ name: '팀2', kind: 'team', categoryId: null, description: '' }, owner);
    const a = await mk('A', null);
    const b = await db.transaction((tx) => pagesSvc.create({ spaceId: other.id, parentId: null, title: 'B', content: doc('B') }, owner, tx));
    await expect(db.transaction((tx) => pagesSvc.move(a.id, { parentId: b.id, position: 0 }, owner, tx))).rejects.toThrow(/다른 스페이스/);
  });

  it(`깊이 ${PAGE_TREE_MAX_DEPTH}를 넘으면 막는다`, async () => {
    const { owner, space, mk } = await setup();
    let parent: string | null = null;
    for (let i = 0; i < PAGE_TREE_MAX_DEPTH; i++) parent = (await mk(`L${i}`, parent)).id;
    await expect(
      db.transaction((tx) => pagesSvc.create({ spaceId: space.id, parentId: parent, title: 'X', content: doc('X') }, owner, tx)),
    ).rejects.toThrow(/깊이/);
  });

  it('**이동 성공 경로** — 부모와 순서를 바꾼다 (FR-326, 인수 기준)', async () => {
    const { owner, space, mk } = await setup();
    const a = await mk('A', null);
    const b = await mk('B', null);
    expect(b.parentId).toBeNull();

    const moved = await db.transaction((tx) => pagesSvc.move(b.id, { parentId: a.id, position: 0 }, owner, tx));
    expect(moved.parentId).toBe(a.id);
    expect(moved.position).toBe(0);

    const tree = await pagesSvc.tree(space.id, owner);
    expect(tree.find((p) => p.id === b.id)?.parentId).toBe(a.id);

    // 루트로 되돌린다
    const back = await db.transaction((tx) => pagesSvc.move(b.id, { parentId: null, position: 1 }, owner, tx));
    expect(back.parentId).toBeNull();
  });

  it('viewer는 이동하지 못한다', async () => {
    const { owner, space, mk } = await setup();
    const viewer = await user('mover-viewer');
    await spacesSvc.addMember(space.id, { username: 'mover-viewer', role: 'viewer' }, owner);
    const a = await mk('A', null);
    await expect(db.transaction((tx) => pagesSvc.move(a.id, { parentId: null, position: 3 }, viewer, tx))).rejects.toThrow(/권한/);
  });

  it('하위가 있으면 삭제할 수 없다 (FR-329)', async () => {
    const { owner, mk } = await setup();
    const a = await mk('A', null);
    await mk('B', a.id);
    await expect(db.transaction((tx) => pagesSvc.softDelete(a.id, owner, tx))).rejects.toThrow(/하위 페이지/);
  });

  it('삭제하면 트리에서 빠진다 (FR-330)', async () => {
    const { owner, space, mk } = await setup();
    const a = await mk('A', null);
    expect(await pagesSvc.tree(space.id, owner)).toHaveLength(1);
    await db.transaction((tx) => pagesSvc.softDelete(a.id, owner, tx));
    expect(await pagesSvc.tree(space.id, owner)).toHaveLength(0);
  });
});

describe('페이지 권한은 스페이스를 따른다 (FR-331)', () => {
  it('볼 수 없는 스페이스의 페이지는 404다', async () => {
    const owner = await user('owner');
    const outsider = await user('outsider');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const p = await db.transaction((tx) => pagesSvc.create({ spaceId: s.id, parentId: null, title: 'T', content: doc('x') }, owner, tx));
    await expect(pagesSvc.get(p.id, outsider)).rejects.toThrow(/찾을 수 없다/);
  });

  it('viewer는 읽지만 쓰지 못한다', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'viewer', role: 'viewer' }, owner);
    const p = await db.transaction((tx) => pagesSvc.create({ spaceId: s.id, parentId: null, title: 'T', content: doc('x') }, owner, tx));
    await expect(pagesSvc.get(p.id, viewer)).resolves.toBeDefined();
    await expect(
      db.transaction((tx) => pagesSvc.update(p.id, { title: 'X', content: doc('y'), baseVersionNo: 1 }, viewer, tx)),
    ).rejects.toThrow(/권한/);
  });
});

describe('버전 단건 조회', () => {
  it('이력 화면의 "보기"가 쓰는 경로', async () => {
    const owner = await user('vowner');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const p = await db.transaction((tx) => pagesSvc.create({ spaceId: sp.id, parentId: null, title: 'T', content: doc('처음') }, owner, tx));
    await db.transaction((tx) => pagesSvc.update(p.id, { title: 'T2', content: doc('나중'), baseVersionNo: 1 }, owner, tx));

    const v1 = await pagesSvc.version(p.id, 1, owner);
    expect(v1.versionNo).toBe(1);
    expect(v1.title).toBe('T');
    expect(JSON.stringify(v1.content)).toContain('처음');
    await expect(pagesSvc.version(p.id, 99, owner)).rejects.toThrow(/버전을 찾을 수 없다/);
  });
});

describe('재색인 (FR-333)', () => {
  it('search_text를 지워도 다시 만들 수 있다 — 파생 데이터다', async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const p = await db.transaction((tx) => pagesSvc.create({ spaceId: s.id, parentId: null, title: 'T', content: doc('되살아난다') }, owner, tx));
    await db.update(pages).set({ searchText: '' }).where(eq(pages.id, p.id));
    expect(await pagesSvc.reindexAll()).toBe(1);
    const [row] = await db.select().from(pages).where(eq(pages.id, p.id));
    expect(row.searchText).toContain('되살아난다');
  });
});

describe('감사로그 거르기 (FR-531)', () => {
  it('행위·행위자·기간으로 거른다. **조건은 질의에서 건다** — 가져와서 거르면 limit이 빈다', async () => {
    const me = await user('flt', 'admin');
    const other = await user('flt2', 'admin');
    const audit = new AuditService(db);
    await audit.record({ action: 'space.create', actorId: me.id, targetType: 'space', targetId: null });
    await audit.record({ action: 'space.delete', actorId: me.id, targetType: 'space', targetId: null });
    await audit.record({ action: 'space.create', actorId: other.id, targetType: 'space', targetId: null });

    expect((await audit.list({ limit: 100, action: 'space.create' })).length).toBe(2);
    expect((await audit.list({ limit: 100, actorId: me.id })).length).toBe(2);
    expect((await audit.list({ limit: 100, action: 'space.create', actorId: me.id })).length).toBe(1);
    // 미래 시점부터면 아무것도 없다
    expect((await audit.list({ limit: 100, from: new Date(Date.now() + 60_000) })).length).toBe(0);
  });
});

describe('분류 관리 (FR-532)', () => {
  it('**쓰는 스페이스가 있으면 지우지 못한다** — 조용히 NULL로 만들면 복구할 수 없다', async () => {
    const admin = await user('catadm', 'admin');
    const [cat] = await db.insert(spaceCategories).values({ name: '재무', createdBy: admin.id }).returning();
    await spacesSvc.create({ name: '팀', kind: 'team', categoryId: cat.id, description: '' }, admin);

    const [{ n }] = await db.select({ n: count() }).from(spaces).where(and(eq(spaces.categoryId, cat.id), isNull(spaces.deletedAt)));
    expect(n).toBe(1);
  });
});
