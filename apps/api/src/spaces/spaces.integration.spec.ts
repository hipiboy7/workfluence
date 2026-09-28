import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, PAGE_POSITION_GAP, PAGE_TREE_MAX_DEPTH, createPageDto, documentSchemaVersion, movePageDto, spaceListQueryDto, type DocNode, type Principal } from '@workfluence/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { UuidPipe } from '../common/uuid.pipe';
import { auditEvents, pageVersions, pages, spaceCategories, spaces, users } from '../db/schema';
import { PagesController } from '../pages/pages.module';
import { PagesService } from '../pages/pages.service';
import { lockTree } from '../pages/tree-lock';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { TEST_POOL_MAX, closeTestDb, openTestDb, resetTables, waitForLockWaiters, type TestDb } from '../test/db';
import { CategoriesController, SpacesController } from './spaces.module';
import { ADMIN_SUSPENDED_MESSAGE, SpacesService } from './spaces.service';

/** B등급 통합 테스트 (P2_설계서_Page 6절). **실제 PostgreSQL**을 쓴다. */

let db: TestDb;
let spacesSvc: SpacesService;
let pagesSvc: PagesService;

const doc = (text: string): DocNode =>
  ({ type: 'doc', schemaVersion: DOCUMENT_SCHEMA_VERSION, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) as DocNode;

type Tx = Parameters<Parameters<TestDb['transaction']>[0]>[0];

/** 트랜잭션 하나를 `fn`까지 하고 **커밋하지 않은 채 붙잡아 둔다** — `release()`하면 커밋한다. 뒤의 일이 그 잠금을 기다리는지 본다 */
async function holdOpen(fn: (tx: Tx) => Promise<unknown>): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const readyNow = new Promise<void>((r) => (ready = r));
  const done = db.transaction(async (tx) => {
    await fn(tx);
    ready();
    await held;
  });
  await Promise.race([readyNow, done]);
  return { release, done };
}
/** 끝난 결과를 값으로 — 성공이면 `'ok'`, 실패면 그 오류 */
const settle = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'ok', (e: unknown) => e);

/**
 * 뒤의 일이 잠금 앞에 선 것(`waiters`개)을 본 뒤에 앞의 일을 커밋한다. **보다가 실패해도 반드시 놓아준다** — 붙잡은 트랜잭션이 남으면 다음 시험의 표 비우기가
 * 그 잠금을 기다려 한 시험의 실패가 파일 전체로 번졌다(좁은 재검토 6)
 */
async function releaseAfter(hold: { release: () => void; done: Promise<void> }, waiters: number): Promise<void> {
  let failed: unknown;
  try {
    await waitForLockWaiters(waiters);
  } catch (e) {
    failed = e;
  }
  hold.release();
  await hold.done;
  if (failed) throw failed;
}
/** 이만큼 기다려도 끝나지 않으면 `'기다리는 중'` — 잠금 앞에 서지 않고 곧바로 끝나야 하는 일을 본다 */
const within = (p: Promise<unknown>, ms = 1500): Promise<unknown> => Promise.race([settle(p), new Promise((r) => setTimeout(() => r('기다리는 중'), ms))]);

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
    // **없는 것과 같게 답한다** (P14 병합 전 보안 검토 4) — 따로 답하면 아는 페이지 id가 살아 있는지를 알려 준다
    await expect(db.transaction((tx) => pagesSvc.move(a.id, { parentId: b.id, position: 0 }, owner, tx))).rejects.toThrow(NotFoundException);
    await expect(db.transaction((tx) => pagesSvc.move(a.id, { parentId: b.id, position: 0 }, owner, tx))).rejects.toThrow(/부모 페이지를 찾을 수 없다/);
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

    const moved = (await db.transaction((tx) => pagesSvc.move(b.id, { parentId: a.id, position: 0 }, owner, tx))).page;
    expect(moved.parentId).toBe(a.id);
    expect(moved.position).toBe(0);

    const tree = await pagesSvc.tree(space.id, owner);
    expect(tree.find((p) => p.id === b.id)?.parentId).toBe(a.id);

    // 루트로 되돌린다
    const back = (await db.transaction((tx) => pagesSvc.move(b.id, { parentId: null, position: 1 }, owner, tx))).page;
    expect(back.parentId).toBeNull();
  });

  /** 트리 화면의 순서(자리, 만든 시각)대로 제목을 늘어놓는다 */
  const titles = async (spaceId: string, owner: Principal, parentId: string | null = null) =>
    (await pagesSvc.tree(spaceId, owner)).filter((p) => p.parentId === parentId).map((p) => p.title);
  const positions = async (ids: string[]) =>
    Object.fromEntries((await db.select({ id: pages.id, position: pages.position }).from(pages)).filter((r) => ids.includes(r.id)).map((r) => [r.id, r.position]));
  const move = (id: string, parentId: string | null, position: number, who: Principal) =>
    db.transaction((tx) => pagesSvc.move(id, { parentId, position }, who, tx));

  it('**자리는 형제 가운데 몇 번째다** — 앞·가운데·뒤, 형제 수보다 크면 맨 뒤, 같은 부모 안에서도, 다른 부모 아래로도 (P14 FR-1502)', async () => {
    const { owner, space, mk } = await setup();
    const [a, b, c, d] = [await mk('A', null), await mk('B', null), await mk('C', null), await mk('D', null)];
    await move(d.id, null, 1, owner);
    expect(await titles(space.id, owner)).toEqual(['A', 'D', 'B', 'C']);
    await move(a.id, null, 3, owner);
    expect(await titles(space.id, owner)).toEqual(['D', 'B', 'C', 'A']);
    await move(b.id, null, 99, owner);
    expect(await titles(space.id, owner)).toEqual(['D', 'C', 'A', 'B']);
    await move(b.id, null, 0, owner);
    expect(await titles(space.id, owner)).toEqual(['B', 'D', 'C', 'A']);
    // 다른 부모 아래로 — 그 부모의 형제 사이에 끼운다
    await mk('C1', c.id);
    await mk('C2', c.id);
    await move(a.id, c.id, 1, owner);
    expect(await titles(space.id, owner, c.id)).toEqual(['C1', 'A', 'C2']);
    expect(await titles(space.id, owner)).toEqual(['B', 'D', 'C']);
  });

  it('**틈이 있으면 옮긴 한 줄만 고친다** — 새 페이지는 간격을 두고 생기고, 형제의 자리 값은 그대로다 (보안 검토 1)', async () => {
    const { owner, mk } = await setup();
    const made = [await mk('A', null), await mk('B', null), await mk('C', null)];
    expect(Object.values(await positions(made.map((p) => p.id)))).toEqual([0, PAGE_POSITION_GAP, 2 * PAGE_POSITION_GAP]);
    const before = await positions([made[0].id, made[1].id]);
    await move(made[2].id, null, 1, owner);
    expect(await positions([made[0].id, made[1].id])).toEqual(before);
    expect((await positions([made[2].id]))[made[2].id]).toBe(PAGE_POSITION_GAP / 2);
  });

  it('**틈이 없으면 한 번에 다시 매긴다** — 붙은 자리도, 옛 API가 남긴 겹친 자리도 바로잡는다', async () => {
    const { owner, space, mk } = await setup();
    const [a, b, c] = [await mk('A', null), await mk('B', null), await mk('C', null)];
    await db.update(pages).set({ position: 0 }).where(eq(pages.spaceId, space.id));
    await move(c.id, null, 1, owner);
    expect(await titles(space.id, owner)).toEqual(['A', 'C', 'B']);
    expect(await positions([a.id, b.id, c.id])).toEqual({ [a.id]: 0, [c.id]: PAGE_POSITION_GAP, [b.id]: 2 * PAGE_POSITION_GAP });
  });

  it('**형제는 자리만 고친다** — 다시 매겨도 고친 사람·시각은 옮긴 페이지만 바뀐다(형제를 "최근에 고친 문서"에 올리지 않는다)', async () => {
    const { owner, space, mk } = await setup();
    const [, b, c] = [await mk('A', null), await mk('B', null), await mk('C', null)];
    await db.update(pages).set({ position: 0 }).where(eq(pages.spaceId, space.id)); // 틈이 없다 — 가운데로 옮기면 다시 매긴다
    const mover = await user('mover');
    await spacesSvc.addMember(space.id, { username: 'mover', role: 'editor' }, owner);
    const before = await db.query.pages.findFirst({ where: eq(pages.id, b.id) });
    await move(c.id, null, 1, mover);
    const after = await db.query.pages.findFirst({ where: eq(pages.id, b.id) });
    expect(after!.position).toBe(2 * PAGE_POSITION_GAP); // 다시 매겨졌다
    expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString());
    expect(after!.updatedBy).toBe(owner.id);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, c.id) }))!.updatedBy).toBe(mover.id);
  });

  it('**다른 스페이스의 형제와 지운 형제는 세지 않는다** — 맨 위로 옮겨도 남의 스페이스 맨 위 페이지는 그대로다 (자체 점검 4)', async () => {
    const { owner, space, mk } = await setup();
    const other = await spacesSvc.create({ name: '팀2', kind: 'team', categoryId: null, description: '' }, owner);
    const q = await db.transaction((tx) => pagesSvc.create({ spaceId: other.id, parentId: null, title: 'Q', content: doc('Q') }, owner, tx));
    const r = await db.transaction((tx) => pagesSvc.create({ spaceId: other.id, parentId: null, title: 'R', content: doc('R') }, owner, tx));
    await db.update(pages).set({ position: 0 }).where(eq(pages.spaceId, other.id));
    await mk('A', null);
    const gone = await mk('지울 것', null);
    await mk('B', null);
    await db.transaction((tx) => pagesSvc.softDelete(gone.id, owner, tx));
    await db.update(pages).set({ position: 0 }).where(eq(pages.spaceId, space.id)); // 다시 매기게 한다
    // 지운 것을 빼면 형제는 A·B — 1은 "A 다음"이다
    const x = await mk('X', null);
    await move(x.id, null, 1, owner);
    expect(await titles(space.id, owner)).toEqual(['A', 'X', 'B']);
    expect(await positions([q.id, r.id])).toEqual({ [q.id]: 0, [r.id]: 0 }); // 남의 스페이스는 건드리지 않았다
    expect((await positions([gone.id]))[gone.id]).toBe(0); // 지운 형제는 다시 매기지 않았다
  });

  it(`**한 스페이스의 옮기기는 줄을 선다** — 시험 풀의 두 배(${TEST_POOL_MAX * 2})를 동시에 옮겨도 자리가 겹치지 않는다 (P14 FR-1503)`, async () => {
    const { owner, space, mk } = await setup();
    const made = [];
    for (let i = 0; i < TEST_POOL_MAX * 2; i++) made.push(await mk(`P${i}`, null));
    await db.update(pages).set({ position: 0 }).where(eq(pages.spaceId, space.id)); // 다시 매기는 길로 겹치게 한다
    // 409(잠금을 2초 넘게 기다렸다)면 사람처럼 다시 한다 — 시험 DB를 다른 실행과 나눠 쓰면 늦을 수 있다(반영분 점검 15)
    const again = async (id: string, position: number): Promise<unknown> => {
      for (let i = 0; ; i++) {
        try {
          return await move(id, null, position, owner);
        } catch (e) {
          if (!(e instanceof ConflictException) || i >= 5) throw e;
        }
      }
    };
    await Promise.all(made.map((p, i) => again(p.id, (i * 5) % made.length)));
    const got = (await pagesSvc.tree(space.id, owner)).map((p) => p.position);
    expect(new Set(got).size).toBe(made.length);
  });

  it('**다시 매긴 뒤에 실패해도 아무것도 바뀌지 않는다** — 한 트랜잭션이다 (P14 NFR-140, 코드 리뷰 — 판정 전에 거절되는 경우만 보던 시험을 바꿨다)', async () => {
    const { owner, space, mk } = await setup();
    const [a, b, c] = [await mk('A', null), await mk('B', null), await mk('C', null)];
    await db.update(pages).set({ position: 0 }).where(eq(pages.spaceId, space.id));
    const before = await positions([a.id, b.id, c.id]);
    // 형제를 다시 매긴 뒤의 마지막 쓰기(옮긴 페이지)에서 실패하게 한다
    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION p14_fail_move() RETURNS trigger AS $$ BEGIN IF NEW.id = '${c.id}' THEN RAISE EXCEPTION 'p14 시험: 마지막 쓰기 실패'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`),
    );
    await db.execute(sql.raw('CREATE TRIGGER p14_fail_move BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION p14_fail_move()'));
    try {
      // drizzle은 DB의 오류를 `cause`에 싣는다
      await expect(move(c.id, null, 1, owner)).rejects.toSatisfy((e) => String((e as { cause?: { message?: string } }).cause?.message).includes('마지막 쓰기 실패'));
    } finally {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS p14_fail_move ON pages'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS p14_fail_move()'));
    }
    expect(await positions([a.id, b.id, c.id])).toEqual(before);
  });

  it('**잠금이 부모 판정보다 먼저다** — X를 Y 아래로, Y를 X 아래로 동시에 옮기면 뒤의 것은 앞의 결과를 보고 순환으로 거절된다 (자체 점검 4·17)', { timeout: 30_000 }, async () => {
    const { owner, mk } = await setup();
    const x = await mk('X', null);
    const y = await mk('Y', null);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let movedNow!: () => void;
    const moved = new Promise<void>((r) => (movedNow = r));
    // 앞의 옮기기는 X를 Y 아래로 옮긴 채 커밋하지 않고 잠금을 쥐고 있다
    const first = db.transaction(async (tx) => {
      await pagesSvc.move(x.id, { parentId: y.id, position: 0 }, owner, tx);
      movedNow();
      await held;
    });
    await moved;
    // 뒤의 옮기기가 잠금을 기다린다. 판정이 잠금보다 먼저면 커밋 전의 트리(X가 맨 위)를 보고 통과해 X → Y → X 고리가 생긴다
    const second = move(y.id, x.id, 0, owner);
    const settled = second.then(
      () => 'ok',
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 300));
    release();
    await first;
    expect(await settled).toBeInstanceOf(BadRequestException);
    expect(((await settled) as Error).message).toBe('페이지를 자기 자신이나 자손 아래로 옮길 수 없다');
    const rows = await db.select({ id: pages.id, parentId: pages.parentId }).from(pages).where(inArray(pages.id, [x.id, y.id]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.parentId]))).toEqual({ [x.id]: y.id, [y.id]: null });
  });

  it('**잠근 뒤 다시 읽는다** — 옮기려는 페이지를 앞사람이 지웠으면 404다. 휴지통의 페이지를 옮겨 "지운 사람"을 바꾸지 않는다 (반영분 점검 1)', { timeout: 30_000 }, async () => {
    const { owner, mk } = await setup();
    const a = await mk('A', null);
    const m = await mk('M', null);
    const first = await holdOpen((tx) => pagesSvc.softDelete(m.id, owner, tx));
    const second = settle(move(m.id, a.id, 0, owner));
    await releaseAfter(first, 1);
    expect(await second).toBeInstanceOf(NotFoundException);
    const row = await db.query.pages.findFirst({ where: eq(pages.id, m.id) });
    expect([row?.parentId, row?.deletedAt === null]).toEqual([null, false]);
  });

  it('**두 번 지워도 한 번이다** — 잠근 뒤 다시 읽어, 뒤의 지우기는 앞의 것을 보고 404 (반영분 점검 1)', { timeout: 30_000 }, async () => {
    const { owner, mk } = await setup();
    const m = await mk('M', null);
    const first = await holdOpen((tx) => pagesSvc.softDelete(m.id, owner, tx));
    const second = settle(db.transaction((tx) => pagesSvc.softDelete(m.id, owner, tx)));
    await releaseAfter(first, 1);
    expect(await second).toBeInstanceOf(NotFoundException);
  });

  it('**권한 없는 사람은 줄에 서지 않는다** — 트리 잠금이 잡혀 있어도 곧바로 거절된다(2초를 기다려 409가 아니라 — 반영분 점검 12)', { timeout: 30_000 }, async () => {
    const { space, mk } = await setup();
    const a = await mk('A', null);
    const outsider = await user('outsider');
    const holder = await holdOpen((tx) => lockTree(tx, space.id));
    try {
      const started = Date.now();
      await expect(db.transaction((tx) => pagesSvc.create({ spaceId: space.id, parentId: null, title: 'N', content: doc('N') }, outsider, tx))).rejects.toThrow(NotFoundException);
      await expect(move(a.id, null, 0, outsider)).rejects.toThrow(NotFoundException);
      await expect(db.transaction((tx) => pagesSvc.softDelete(a.id, outsider, tx))).rejects.toThrow(NotFoundException);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  it('**옮긴 곳의 "어디서"는 잠근 뒤의 자리다** — 앞사람이 먼저 옮겼으면 그 결과에서 옮긴 것으로 적힌다 (반영분 점검 1)', { timeout: 30_000 }, async () => {
    const { owner, mk } = await setup();
    const a = await mk('A', null);
    const b = await mk('B', null);
    const m = await mk('M', null);
    const first = await holdOpen((tx) => pagesSvc.move(m.id, { parentId: a.id, position: 0 }, owner, tx));
    const second = move(m.id, b.id, 0, owner);
    await releaseAfter(first, 1);
    expect((await second).from.parentId).toBe(a.id);
  });

  it('**만들기도 잠근 뒤 맨 뒤를 읽는다** — 앞사람이 만들고 커밋하기 전에 만들어도 자리가 겹치지 않는다 (반영분 점검 7)', { timeout: 30_000 }, async () => {
    const { owner, space, mk } = await setup();
    await mk('A', null);
    const make = (title: string) => (tx: Tx) => pagesSvc.create({ spaceId: space.id, parentId: null, title, content: doc(title) }, owner, tx);
    const first = await holdOpen(make('B'));
    const second = db.transaction(make('C'));
    await releaseAfter(first, 1);
    await second;
    const got = await pagesSvc.tree(space.id, owner);
    expect(got.map((p) => p.title)).toEqual(['A', 'B', 'C']);
    expect(new Set(got.map((p) => p.position)).size).toBe(3);
  });

  it('**지우기도 잠근 뒤 자식을 센다** — 앞사람이 그 아래로 옮기는 중이면 뒤의 지우기는 "하위 페이지가 있다"로 막힌다(고아를 만들지 않는다 — 반영분 점검 7)', { timeout: 30_000 }, async () => {
    const { owner, mk } = await setup();
    const p = await mk('P', null);
    const x = await mk('X', null);
    const first = await holdOpen((tx) => pagesSvc.move(x.id, { parentId: p.id, position: 0 }, owner, tx));
    const second = settle(db.transaction((tx) => pagesSvc.softDelete(p.id, owner, tx)));
    await releaseAfter(first, 1);
    const r = await second;
    expect(r).toBeInstanceOf(BadRequestException);
    expect((r as Error).message).toMatch(/하위 페이지가 있는 페이지는 삭제할 수 없다/);
  });

  it('**대문자 식별자로 보내도 자기 아래로는 못 옮기고, 대문자 스페이스로 만들어도 부모를 찾는다** — 경계(`UuidPipe`·DTO)가 소문자로 맞춘다 (반영분 점검 2)', async () => {
    const { owner, space, mk } = await setup();
    const m = await mk('M', null);
    const c = await mk('C', m.id);
    const id = new UuidPipe().transform(m.id.toUpperCase());
    await expect(
      db.transaction((tx) => pagesSvc.move(id, movePageDto.parse({ parentId: c.id.toUpperCase(), position: 0 }), owner, tx)),
    ).rejects.toThrow('페이지를 자기 자신이나 자손 아래로 옮길 수 없다');
    const made = await db.transaction((tx) =>
      pagesSvc.create(createPageDto.parse({ spaceId: space.id.toUpperCase(), parentId: m.id.toUpperCase(), title: 'D', content: doc('D') }), owner, tx),
    );
    expect(made.parentId).toBe(m.id);
  });

  it('**트리 잠금은 트랜잭션 밖에서 부르면 막는다** — 밖에서는 잠금이 그 문장으로 끝나 줄 세우기가 오류 없이 사라진다. 잠근 뒤 잠금 대기 한도는 원래대로 (반영분 점검 10)', async () => {
    const { space } = await setup();
    await expect(lockTree(db, space.id)).rejects.toThrow('lockTree는 트랜잭션 안에서 부른다');
    const after = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '7s'`);
      await lockTree(tx, space.id);
      return (await tx.execute<{ lock_timeout: string }>(sql`SELECT current_setting('lock_timeout') AS lock_timeout`)).rows[0].lock_timeout;
    });
    expect(after).toBe('7s');
  });

  it('**트리 잠금은 오래 기다리지 않는다** — 옮기기·만들기·지우기가 잠금을 기다리다 한도를 넘으면 409 (보안 검토 1, 코드 리뷰 6)', { timeout: 30_000 }, async () => {
    const { owner, space, mk } = await setup();
    const a = await mk('A', null);
    const b = await mk('B', null);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedNow = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`page-tree:${space.id}`}))`);
      locked();
      await held;
    });
    await lockedNow;
    try {
      await expect(move(a.id, null, 1, owner)).rejects.toThrow(ConflictException);
      await expect(db.transaction((tx) => pagesSvc.create({ spaceId: space.id, parentId: null, title: 'N', content: doc('N') }, owner, tx))).rejects.toThrow(/다른 사람이 바꾸는 중이다/);
      await expect(db.transaction((tx) => pagesSvc.softDelete(b.id, owner, tx))).rejects.toThrow(ConflictException);
    } finally {
      release();
      await holder;
    }
    // 잠금이 풀리면 곧바로 된다
    await expect(move(a.id, null, 1, owner)).resolves.toMatchObject({ page: { id: a.id } });
  });

  it('**감사에 어디서 어디로를 남긴다** — 형제 수로 잘린 실제 자리와 옛 부모 (코드 리뷰 8·보안 검토 6)', async () => {
    const { owner, mk } = await setup();
    const a = await mk('A', null);
    const b = await mk('B', null);
    const ctrl = new PagesController(pagesSvc, new AuditService(db), {} as never, {} as never, spacesSvc, db);
    await ctrl.move(b.id, { parentId: a.id, position: 99 }, owner as never, { ip: '127.0.0.1' } as never);
    const rows = await db.execute<{ detail: unknown }>(sql`SELECT detail FROM audit_events WHERE action = 'page.move' AND target_id = ${b.id}`);
    expect(rows.rows[0].detail).toEqual({ from: { parentId: null, position: PAGE_POSITION_GAP }, to: { parentId: a.id, position: 0, index: 0 } });
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

/** **모든 스페이스는 DB가 찾고 거른다** (P14 FR-1514) — 자르기(limit) 전에 거른다. `q`는 이름·키의 부분 일치, `%`·`_`는 글자 그대로 */
describe('스페이스 목록의 찾기·상태 (P14 FR-1514)', () => {
  it('관리자의 모든 스페이스 — 이름·키로 찾고 상태로 거른다. 자르기 전에 걸러 상한 밖도 찾는다', async () => {
    const admin = await user('boss', 'admin');
    const owner = await user('owner');
    const made = [];
    for (const name of ['가 운영팀', '나 개발팀', '다 운영 지원', '100%_완료']) {
      made.push(await spacesSvc.create({ name, kind: 'team', categoryId: null, description: '' }, owner));
    }
    await spacesSvc.changeStatus(made[2].id, 'suspended', owner);
    const names = (views: { name: string }[]) => views.map((v) => v.name);
    expect(names(await spacesSvc.list(admin, 'all', 500, { q: '운영' }))).toEqual(['가 운영팀', '다 운영 지원']);
    expect(names(await spacesSvc.list(admin, 'all', 500, { q: '운영', status: 'suspended' }))).toEqual(['다 운영 지원']);
    expect(names(await spacesSvc.list(admin, 'all', 500, { status: 'active' }))).toEqual(['100%_완료', '가 운영팀', '나 개발팀']);
    // 키로도 찾는다 — 대소문자를 가리지 않는다
    expect(names(await spacesSvc.list(admin, 'all', 500, { q: made[1].key.toLowerCase() }))).toEqual(['나 개발팀']);
    // `%`·`_`는 와일드카드가 아니다
    expect(names(await spacesSvc.list(admin, 'all', 500, { q: '%' }))).toEqual(['100%_완료']);
    expect(names(await spacesSvc.list(admin, 'all', 500, { q: '_' }))).toEqual(['100%_완료']);
    // **상한 1이어도 찾는 것은 찾아진다** — 걸러서 자른다
    expect(names(await spacesSvc.list(admin, 'all', 1, { q: '개발' }))).toEqual(['나 개발팀']);
  });

  it('**컨트롤러가 조건을 넘긴다** — 쿼리의 `q`·`status`가 서비스까지 간다(배선을 서비스 시험만으로는 보지 못한다)', async () => {
    const admin = await user('boss', 'admin');
    const owner = await user('owner');
    await spacesSvc.create({ name: '운영팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.create({ name: '개발팀', kind: 'team', categoryId: null, description: '' }, owner);
    const ctrl = new SpacesController(spacesSvc, new AuditService(db), db);
    const views = await ctrl.list(spaceListQueryDto.parse({ scope: 'all', q: '운영', status: 'active' }), admin as never);
    expect(views.map((v) => v.name)).toEqual(['운영팀']);
  });

  it('찾기는 볼 수 있는 것 안에서만 — 일반 사용자의 팀 목록에도 먹는다', async () => {
    const owner = await user('owner');
    const outsider = await user('outsider');
    await spacesSvc.create({ name: '운영팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.create({ name: '개발팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.create({ name: '운영 비밀', kind: 'team', categoryId: null, description: '' }, outsider);
    expect((await spacesSvc.list(owner, 'team', 200)).map((v) => v.name)).toEqual(['개발팀', '운영팀']);
    expect((await spacesSvc.list(owner, 'team', 200, { q: '운영' })).map((v) => v.name)).toEqual(['운영팀']);
  });

  it('**모든 스페이스는 관리자만** — 일반 사용자가 부르면 403 (자체 점검 5 — 관리 콘솔 전체의 방어선이다)', async () => {
    const owner = await user('owner');
    await expect(spacesSvc.list(owner, 'all', 500)).rejects.toThrow(ForbiddenException);
    const ctrl = new SpacesController(spacesSvc, new AuditService(db), db);
    await expect(ctrl.list(spaceListQueryDto.parse({ scope: 'all' }), owner as never)).rejects.toThrow(ForbiddenException);
  });

  it('모든 스페이스는 SQL에서 자른다 — 상한만큼만 돌려준다(코드 리뷰 3)', async () => {
    const admin = await user('boss', 'admin');
    const owner = await user('owner');
    for (const name of ['가', '나', '다']) await spacesSvc.create({ name, kind: 'team', categoryId: null, description: '' }, owner);
    // 결과는 JS로 잘라도 같다 — **보기를 상한만큼만 만드는지**를 센다(한 번에, 두 줄)
    const toViews = vi.spyOn(spacesSvc as unknown as { toViews: (rows: unknown[], ...a: unknown[]) => unknown }, 'toViews');
    try {
      expect((await spacesSvc.list(admin, 'all', 2)).map((v) => v.name)).toEqual(['가', '나']);
      expect(toViews).toHaveBeenCalledTimes(1);
      expect(toViews.mock.calls[0][0]).toHaveLength(2);
    } finally {
      toViews.mockRestore();
    }
  });

  it('**보기는 한꺼번에 만든다** — 줄 수와 무관하게 한 번(질의 넷). 줄마다의 Crew 수·내 자리·분류·만든 사람이 섞이지 않는다 (반영분 점검 8)', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const [cat] = await db.insert(spaceCategories).values({ name: '운영', createdBy: owner.id }).returning();
    const a = await spacesSvc.create({ name: '가팀', kind: 'team', categoryId: cat.id, description: '' }, owner);
    await spacesSvc.create({ name: '나팀', kind: 'team', categoryId: null, description: '' }, mate);
    await spacesSvc.addMember(a.id, { username: 'mate', role: 'viewer' }, owner);
    const toViews = vi.spyOn(spacesSvc as unknown as { toViews: (...a: unknown[]) => unknown }, 'toViews');
    try {
      const views = await spacesSvc.list(mate, 'team', 200);
      expect(toViews).toHaveBeenCalledTimes(1);
      expect(views.map((v) => [v.name, v.memberCount, v.myRole, v.categoryName, v.createdByUsername, v.access.canWrite])).toEqual([
        ['가팀', 2, 'viewer', '운영', 'owner', false],
        ['나팀', 1, 'owner', null, 'mate', true],
      ]);
    } finally {
      toViews.mockRestore();
    }
  });
});

describe('분류 관리 (FR-532)', () => {
  it('**같은 새 이름을 동시에 만들어도 하나다** — 앞사람이 넣고 커밋하기 전에 만들면 그 분류를 돌려받는다. 먼저 찾고 넣으면 뒤의 것이 유일 제약에 걸려 500이었다 (FR-308, 반영분 점검 11)', { timeout: 30_000 }, async () => {
    const admin = await user('catadm', 'admin');
    const ctrl = new CategoriesController(new AuditService(db), db);
    // 앞사람의 만들기 — 넣었지만 아직 커밋하지 않았다(두 번 누른 앞의 요청)
    const first = await holdOpen((tx) => tx.insert(spaceCategories).values({ name: '새 분류', createdBy: admin.id }));
    // 값이나 오류를 그대로 받는다 — 옛 코드는 유일 제약 위반을 던졌다
    const second = ctrl.create({ name: '새 분류' }, admin as never, { ip: '127.0.0.1' } as never).then(
      (v) => v,
      (e: unknown) => e,
    );
    await releaseAfter(first, 1);
    const got = await second;
    const [row] = await db.select().from(spaceCategories).where(eq(spaceCategories.name, '새 분류'));
    expect(got).toMatchObject({ id: row.id, name: '새 분류' });
  });

});

const REQ = { ip: '127.0.0.1' } as never;
const withGrants = (p: Principal, grants: Principal['grants']): Principal => ({ ...p, grants });

describe('관리자가 건 중지 (P15 C.2, 보류 32)', () => {
  it('**주인이 건 중지는 주인이 푼다** — 건 사람이 주인인지 적고 보기에 싣는다 (FR-1610·1612)', async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const { row } = await spacesSvc.changeStatus(s.id, 'suspended', owner);
    expect([row.status, row.suspendedBy, row.suspendedByOwner]).toEqual(['suspended', owner.id, true]);
    expect((await spacesSvc.get(s.id, owner)).suspendedByOwner).toBe(true);
    const back = await spacesSvc.changeStatus(s.id, 'active', owner);
    expect([back.row.status, back.row.suspendedBy, back.row.suspendedByOwner]).toEqual(['active', null, false]);
    expect((await spacesSvc.get(s.id, owner)).suspendedByOwner).toBe(false);
  });

  it('**관리자가 건 중지는 권한을 받은 주인만 푼다** — 받지 않은 주인은 403이고 까닭을 듣는다. 개인 공간도 같다 (FR-1611)', async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const team = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const mine = await spacesSvc.create({ name: '내 공간', kind: 'personal', categoryId: null, description: '' }, owner);
    for (const s of [team, mine]) {
      const { row } = await spacesSvc.changeStatus(s.id, 'suspended', admin);
      expect(row.suspendedByOwner).toBe(false);
      await expect(spacesSvc.changeStatus(s.id, 'active', owner)).rejects.toThrow(ADMIN_SUSPENDED_MESSAGE);
      // 다른 위임은 풀지 못한다 — 분류 관리
      await expect(spacesSvc.changeStatus(s.id, 'active', withGrants(owner, ['category.manage']))).rejects.toThrow(ForbiddenException);
      await expect(spacesSvc.changeStatus(s.id, 'active', withGrants(owner, ['space.unsuspend']))).resolves.toMatchObject({ changed: true, row: { status: 'active' } });
    }
    // 관리자는 언제나 푼다
    await spacesSvc.changeStatus(team.id, 'suspended', admin);
    await expect(spacesSvc.changeStatus(team.id, 'active', admin)).resolves.toMatchObject({ changed: true });
  });

  it('**권한을 받아도 주인이 아니면 못 푼다** — editor에게 관리자가 건 중지 풀기가 있어도 그 공간은 그의 것이 아니다', async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const ed = await user('ed');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'ed', role: 'editor' }, owner);
    await spacesSvc.changeStatus(s.id, 'suspended', admin);
    await expect(spacesSvc.changeStatus(s.id, 'active', withGrants(ed, ['space.unsuspend']))).rejects.toThrow('상태를 바꿀 권한이 없다');
  });

  it('**같은 상태를 다시 보내면 쓰지 않는다** — 권한을 받은 주인이 관리자가 건 중지를 제가 건 것으로 바꿔 두지 못한다. 감사 행도 없다', async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.changeStatus(s.id, 'suspended', admin);
    const again = await spacesSvc.changeStatus(s.id, 'suspended', withGrants(owner, ['space.unsuspend']));
    expect([again.changed, again.row.suspendedBy, again.row.suspendedByOwner]).toEqual([false, admin.id, false]);
    // 권한을 거두면 다시 못 푼다 — 바꿔 두었다면 풀렸다
    await expect(spacesSvc.changeStatus(s.id, 'active', owner)).rejects.toThrow(ADMIN_SUSPENDED_MESSAGE);

    const ctrl = new SpacesController(spacesSvc, new AuditService(db), db);
    await ctrl.changeStatus(s.id, { status: 'suspended' }, admin as never, REQ);
    await ctrl.changeStatus(s.id, { status: 'active' }, admin as never, REQ);
    await ctrl.changeStatus(s.id, { status: 'suspended' }, owner as never, REQ);
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'space.status.change'));
    expect(rows.map((r) => r.detail)).toEqual([{ status: 'active', wasByOwner: false }, { status: 'suspended', byOwner: true }]);
  });

  it('**동시에 바꾸면 뒤의 것은 409다** — 앞의 것이 커밋하기 전에 읽은 상태로 덮지 않는다', { timeout: 30_000 }, async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const first = await holdOpen((tx) => spacesSvc.changeStatus(s.id, 'suspended', owner, tx));
    const second = settle(spacesSvc.changeStatus(s.id, 'suspended', admin));
    await releaseAfter(first, 1);
    expect(await second).toBeInstanceOf(ConflictException);
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) });
    // 주인이 건 중지로 남는다 — 관리자의 요청이 판정 없이 "관리자가 건 것"으로 덮지 않았다
    expect([row?.suspendedBy, row?.suspendedByOwner]).toEqual([owner.id, true]);
  });

  it('**주인이 제 중지를 다시 걸면 아무것도 바뀌지 않는다** — 넘겨받기는 주인이 아닐 때만. 두 번 누른 주인이 제 중지를 "관리자가 건 것"으로 만들지 않는다 (좁은 재검토 3)', async () => {
    const owner = await user('owner');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const ctrlS = new SpacesController(spacesSvc, new AuditService(db), db);
    await ctrlS.changeStatus(s.id, { status: 'suspended' }, owner as never, REQ);
    await expect(spacesSvc.changeStatus(s.id, 'suspended', owner)).resolves.toMatchObject({ changed: false, takeover: false });
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) });
    expect([row?.suspendedBy, row?.suspendedByOwner]).toEqual([owner.id, true]);
    // 주인이 넘겨받겠다고 보내면 400 — 그 중지는 주인의 것이다
    await expect(ctrlS.changeStatus(s.id, { status: 'suspended', takeover: true }, owner as never, REQ)).rejects.toBeInstanceOf(BadRequestException);
    // 주인이 풀면 감사에 풀린 중지가 주인의 것이었다고 남는다
    await ctrlS.changeStatus(s.id, { status: 'active' }, owner as never, REQ);
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'space.status.change'));
    expect(rows.map((r) => r.detail)).toEqual([{ status: 'suspended', byOwner: true }, { status: 'active', wasByOwner: true }]);
  });

  it('**넘겨받기는 화면이 본 상태를 확인한다** — 그 사이 주인이 풀었으면 새 중지로 만들지 않고 409 (좁은 재검토 12)', async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.changeStatus(s.id, 'suspended', owner);
    // 관리자가 "주인이 걸었다"를 본 뒤 주인이 풀었다
    await spacesSvc.changeStatus(s.id, 'active', owner);
    const ctrlS = new SpacesController(spacesSvc, new AuditService(db), db);
    await expect(ctrlS.changeStatus(s.id, { status: 'suspended', takeover: true }, admin as never, REQ)).rejects.toThrow('주인이 건 중지가 아니다');
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) }))?.status).toBe('active');
    // 주인이 건 중지면 넘겨받는다 — 화면이 보내는 모양 그대로
    await spacesSvc.changeStatus(s.id, 'suspended', owner);
    await expect(ctrlS.changeStatus(s.id, { status: 'suspended', takeover: true }, admin as never, REQ)).resolves.toMatchObject({ suspendedByOwner: false });
  });

  it('**관리자 둘이 동시에 중지하면 뒤의 것은 409** — 상태만 바뀌고 건 사람(주인인가)은 그대로인 경합. 건 사람이 앞사람으로 남는다', { timeout: 30_000 }, async () => {
    const owner = await user('owner');
    const a1 = await user('boss1', 'admin');
    const a2 = await user('boss2', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const first = await holdOpen((tx) => spacesSvc.changeStatus(s.id, 'suspended', a1, tx));
    const second = settle(spacesSvc.changeStatus(s.id, 'suspended', a2));
    await releaseAfter(first, 1);
    expect(await second).toBeInstanceOf(ConflictException);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) }))?.suspendedBy).toBe(a1.id);
  });

  it('**주인이 건 중지도 주인이 아닌 Crew는 못 푼다** — editor (병합 전 코드 리뷰 1)', async () => {
    const owner = await user('owner');
    const ed = await user('ed');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'ed', role: 'editor' }, owner);
    await spacesSvc.changeStatus(s.id, 'suspended', owner);
    await expect(spacesSvc.changeStatus(s.id, 'active', ed)).rejects.toThrow('상태를 바꿀 권한이 없다');
    await expect(spacesSvc.changeStatus(s.id, 'active', withGrants(ed, ['space.unsuspend']))).rejects.toThrow('상태를 바꿀 권한이 없다');
  });

  it('**관리자는 주인이 건 중지를 넘겨받는다** — 다시 중지하면 관리자가 건 중지가 되고 감사에 남는다. 거꾸로는 안 된다 (병합 전 보안 검토 1)', async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const { row: first } = await spacesSvc.changeStatus(s.id, 'suspended', owner);
    const ctrlS = new SpacesController(spacesSvc, new AuditService(db), db);
    const view = await ctrlS.changeStatus(s.id, { status: 'suspended' }, admin as never, REQ);
    expect([view.status, view.suspendedByOwner]).toEqual(['suspended', false]);
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) });
    // 건 사람이 바뀌고, 중지된 때는 그대로다 — 읽기만 된 것은 주인이 건 때부터다
    expect([row?.suspendedBy, row?.suspendedByOwner, row?.suspendedAt?.toISOString()]).toEqual([admin.id, false, first.suspendedAt?.toISOString()]);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'space.status.change'));
    expect(audit.detail).toEqual({ status: 'suspended', byOwner: false, takeover: true });
    // 이제 주인은 권한이 있어야 푼다
    await expect(spacesSvc.changeStatus(s.id, 'active', owner)).rejects.toThrow(ADMIN_SUSPENDED_MESSAGE);
    // 관리자가 건 중지를 다시 걸면 쓰지 않는다. 주인이 다시 걸어 "주인이 건 것"으로 바꾸지 못한다 — 푸는 것과 같은 권한이 든다
    await expect(spacesSvc.changeStatus(s.id, 'suspended', admin)).resolves.toMatchObject({ changed: false });
    await expect(spacesSvc.changeStatus(s.id, 'suspended', owner)).rejects.toThrow('상태를 바꿀 권한이 없다');
    // 풀면 감사에 풀린 중지가 누구 것이었는지 남는다
    await ctrlS.changeStatus(s.id, { status: 'active' }, admin as never, REQ);
    const all = await db.select().from(auditEvents).where(eq(auditEvents.action, 'space.status.change'));
    expect(all.map((r) => r.detail)).toContainEqual({ status: 'active', wasByOwner: false });
  });

  it('**판정한 상태에서만 쓴다(ABA)** — 주인이 "주인이 건 중지"로 판정한 풀기는, 그 사이 관리자가 다시 쓰기 → 중지로 넘겨받았으면 409다 (병합 전 검토)', { timeout: 30_000 }, async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.changeStatus(s.id, 'suspended', owner);
    // 관리자가 다시 쓰기 → 중지를 한 트랜잭션에서 하고 커밋하기 전에, 주인이 옛 상태(주인이 건 중지)로 판정한 풀기를 보낸다
    const admins = await holdOpen(async (tx) => {
      await spacesSvc.changeStatus(s.id, 'active', admin, tx);
      await spacesSvc.changeStatus(s.id, 'suspended', admin, tx);
    });
    const resume = settle(spacesSvc.changeStatus(s.id, 'active', owner));
    await releaseAfter(admins, 1);
    expect(await resume).toBeInstanceOf(ConflictException);
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) });
    expect([row?.status, row?.suspendedByOwner]).toEqual(['suspended', false]);
  });
});

describe('스페이스 관리 전체 (P15 C.4, A.1-1)', () => {
  it('**Crew가 아닌 공간도 중지·다시 쓰기·중지된 것 지우기를 한다** — 내용은 읽지 못하고, 돌려받는 보기에 설명이 없다 (FR-1630·1631)', async () => {
    const owner = await user('owner');
    const overseer = withGrants(await user('ov'), ['space.oversee']);
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '비밀 설명' }, owner);
    await expect(spacesSvc.context(s.id, overseer)).rejects.toThrow(NotFoundException);
    await expect(spacesSvc.get(s.id, overseer)).rejects.toThrow(NotFoundException);

    const ctrl = new SpacesController(spacesSvc, new AuditService(db), db);
    const view = await ctrl.changeStatus(s.id, { status: 'suspended' }, overseer as never, REQ);
    expect([view.status, view.suspendedByOwner, view.description, view.access.canRead]).toEqual(['suspended', false, '', false]);
    // 주인은 이제 권한이 있어야 푼다 — 관리자가 건 것과 같다
    await expect(spacesSvc.changeStatus(s.id, 'active', owner)).rejects.toThrow(ADMIN_SUSPENDED_MESSAGE);
    await expect(spacesSvc.changeStatus(s.id, 'active', overseer)).resolves.toMatchObject({ changed: true });
    // 활성인 공간은 지우지 못한다 — 중지된 것만
    await expect(spacesSvc.softDelete(s.id, overseer)).rejects.toThrow(ForbiddenException);
    await spacesSvc.changeStatus(s.id, 'suspended', overseer);
    await expect(ctrl.remove(s.id, overseer as never, REQ)).resolves.toEqual({ ok: true });
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) }))?.deletedAt).not.toBeNull();
  });

  it('**받지 않았으면 404다** — Crew가 아닌 공간이 있는지도 드러나지 않는다. 다른 위임도 마찬가지', async () => {
    const owner = await user('owner');
    const m = await user('m');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    for (const p of [m, withGrants(m, ['category.manage']), withGrants(m, ['space.unsuspend'])]) {
      await expect(spacesSvc.changeStatus(s.id, 'suspended', p)).rejects.toThrow(NotFoundException);
      await expect(spacesSvc.softDelete(s.id, p)).rejects.toThrow(NotFoundException);
      await expect(spacesSvc.getManaged(s.id, p)).rejects.toThrow(NotFoundException);
    }
  });

  it('**이름·설명·분류는 바꾸지 않는다** — editor로 있는 공간도 (A.1-1)', async () => {
    const owner = await user('owner');
    const ov = await user('ov');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'ov', role: 'editor' }, owner);
    await expect(spacesSvc.update(s.id, { name: '바뀐 이름' }, withGrants(ov, ['space.oversee']))).rejects.toThrow('스페이스 정보를 바꿀 권한이 없다');
    await expect(spacesSvc.update(s.id, { name: '바뀐 이름' }, owner)).resolves.toMatchObject({ name: '바뀐 이름' });
  });

  it('**모든 스페이스 목록** — 읽지 못하는 공간도 보이고 설명은 빈다. 받지 않은 member는 403 (FR-1630)', async () => {
    const owner = await user('owner');
    const ov = await user('ov');
    const a = await spacesSvc.create({ name: '가팀', kind: 'team', categoryId: null, description: '가 설명' }, owner);
    await spacesSvc.create({ name: '나 공간', kind: 'personal', categoryId: null, description: '나 설명' }, owner);
    await spacesSvc.addMember(a.id, { username: 'ov', role: 'viewer' }, owner);
    const overseer = withGrants(ov, ['space.oversee']);
    const views = await spacesSvc.list(overseer, 'all', 500);
    expect(views.map((v) => [v.name, v.description, v.access.canRead, v.access.canChangeStatus])).toEqual([
      ['가팀', '가 설명', true, true],
      ['나 공간', '', false, true],
      // ov의 개인 공간은 없다 — 사용자를 DB에 바로 넣었다
    ]);
    await expect(spacesSvc.list(withGrants(ov, ['category.manage']), 'all', 500)).rejects.toThrow(ForbiddenException);
  });
});

describe('관리자가 건 중지 동안 Crew는 관리자만 바꾼다 (P16, 보류 35)', () => {
  // 서버의 문구는 글자 그대로 견준다 — 같은 상수로 견주면 글자가 바뀌어도 시험은 초록이고, 그 글자를 옮겨 적은 문서만 조용히 어긋난다(T-069)
  const FROZEN = '관리자가 중지한 스페이스다 — Crew는 관리자가 바꾼다';
  /** 막힌 주인의 거절 — 403(ForbiddenException)이고 그 까닭이다 (FR-1700) */
  async function frozen(p: Promise<unknown>): Promise<void> {
    const e = await settle(p);
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as Error).message).toBe(FROZEN);
  }

  async function setup() {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const mate = await user('mate');
    await user('newbie');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'mate', role: 'editor' }, owner);
    return { owner, admin, mate, s };
  }
  const crewOf = async (spaceId: string, viewer: Principal) => (await spacesSvc.members(spaceId, viewer)).map((m) => [m.username, m.role]);

  it('**관리자가 건 중지면 주인은 넣지도 빼지도 자리를 바꾸지도 못한다** — 403과 까닭. 관리자가 건 중지 풀기를 받았어도 (FR-1700)', async () => {
    const { owner, admin, mate, s } = await setup();
    await spacesSvc.changeStatus(s.id, 'suspended', admin);
    for (const actor of [owner, withGrants(owner, ['space.unsuspend'])]) {
      await frozen(spacesSvc.addMember(s.id, { username: 'newbie', role: 'viewer' }, actor));
      await frozen(spacesSvc.changeMemberRole(s.id, mate.id, 'viewer', actor));
      await frozen(spacesSvc.removeMember(s.id, mate.id, actor));
    }
    // Crew 목록은 그대로 본다 — 읽기는 중지와 무관하다. 막힌 셋이 아무것도 바꾸지 않았다
    expect(await crewOf(s.id, owner)).toEqual([
      ['mate', 'editor'],
      ['owner', 'owner'],
    ]);
  });

  it('**관리자는 언제나 바꾼다**(넣기·자리 바꾸기·빼기), 주인이 스스로 건 중지와 다시 쓰게 한 뒤에는 주인이 바꾼다 (FR-1701)', async () => {
    const { owner, admin, mate, s } = await setup();
    await spacesSvc.changeStatus(s.id, 'suspended', admin);
    await spacesSvc.addMember(s.id, { username: 'newbie', role: 'viewer' }, admin);
    await spacesSvc.changeMemberRole(s.id, mate.id, 'viewer', admin);
    const newbie = (await db.query.users.findFirst({ where: eq(users.username, 'newbie') }))!;
    await spacesSvc.removeMember(s.id, newbie.id, admin);
    expect(await crewOf(s.id, admin)).toEqual([
      ['mate', 'viewer'],
      ['owner', 'owner'],
    ]);
    // 다시 쓰게 한 뒤 — 주인이 바꾼다
    await spacesSvc.changeStatus(s.id, 'active', admin);
    await spacesSvc.changeMemberRole(s.id, mate.id, 'editor', owner);
    // 주인이 스스로 건 중지 — 주인이 바꾼다
    await spacesSvc.changeStatus(s.id, 'suspended', owner);
    await expect(spacesSvc.removeMember(s.id, mate.id, owner)).resolves.toBeUndefined();
    expect((await spacesSvc.members(s.id, owner)).map((m) => m.username)).toEqual(['owner']);
  });

  it('**Crew의 owner로 든 사람도** 관리자가 건 중지 동안은 못 바꾼다 — 보기의 `canManageMembers`가 거짓이고 `crewFrozen`이 참이다', async () => {
    const { owner, admin, mate, s } = await setup();
    await spacesSvc.changeMemberRole(s.id, mate.id, 'owner', owner);
    await spacesSvc.changeStatus(s.id, 'suspended', admin);
    await frozen(spacesSvc.addMember(s.id, { username: 'newbie', role: 'editor' }, mate));
    const seen = (await spacesSvc.get(s.id, mate)).access;
    expect([seen.canManageMembers, seen.crewFrozen]).toEqual([false, true]);
    const boss = (await spacesSvc.get(s.id, admin)).access;
    expect([boss.canManageMembers, boss.crewFrozen]).toEqual([true, false]);
  });
});

describe('Crew 쓰기도 판정한 상태에서만 (P16 A.1-5, 병합 전 검토 — T-072)', () => {
  const FROZEN = '관리자가 중지한 스페이스다 — Crew는 관리자가 바꾼다';

  async function setup() {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const mate = await user('mate');
    await user('newbie');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.addMember(s.id, { username: 'mate', role: 'editor' }, owner);
    return { owner, admin, mate, s };
  }

  type Act = (spaceId: string, owner: Principal, mateId: string, tx: Tx) => Promise<void>;
  const acts: [string, Act][] = [
    ['넣기', (spaceId, owner, _mateId, tx) => spacesSvc.addMember(spaceId, { username: 'newbie', role: 'viewer' }, owner, tx)],
    ['자리 바꾸기', (spaceId, owner, mateId, tx) => spacesSvc.changeMemberRole(spaceId, mateId, 'viewer', owner, tx)],
    ['빼기', (spaceId, owner, mateId, tx) => spacesSvc.removeMember(spaceId, mateId, owner, tx)],
  ];
  for (const [name, act] of acts) {
    it(`**관리자의 중지가 커밋되기 전에 온 주인의 ${name}는 기다렸다가 새 상태로 판정한다** — 403, Crew가 그대로다(잠그지 않으면 얼린 뒤에 들어갔다)`, { timeout: 30_000 }, async () => {
      const { owner, admin, mate, s } = await setup();
      const suspending = await holdOpen((tx) => spacesSvc.changeStatus(s.id, 'suspended', admin, tx));
      // 화면이 부르는 길과 같게 — 컨트롤러가 트랜잭션을 열고 그 안에서 부른다
      const acting = settle(db.transaction((tx) => act(s.id, owner, mate.id, tx)));
      await releaseAfter(suspending, 1);
      const e = await acting;
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as Error).message).toBe(FROZEN);
      expect((await spacesSvc.members(s.id, owner)).map((m) => [m.username, m.role])).toEqual([
        ['mate', 'editor'],
        ['owner', 'owner'],
      ]);
    });
  }

  it('**주인의 넣기가 커밋되기 전에 온 관리자의 중지는 기다린다** — 둘 다 되고, 끝 상태는 "넣고 나서 얼렸다"다', { timeout: 30_000 }, async () => {
    const { owner, admin, s } = await setup();
    const adding = await holdOpen((tx) => spacesSvc.addMember(s.id, { username: 'newbie', role: 'viewer' }, owner, tx));
    const suspending = settle(spacesSvc.changeStatus(s.id, 'suspended', admin));
    await releaseAfter(adding, 1);
    expect(await suspending).not.toBeInstanceOf(Error);
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) });
    expect([row?.status, row?.suspendedByOwner]).toEqual(['suspended', false]);
    expect((await spacesSvc.members(s.id, admin)).map((m) => m.username)).toEqual(['mate', 'newbie', 'owner']);
  });

  it('트랜잭션 없이 불러도 스스로 열어 그 안에서 한다 — 잠금이 문장 하나로 끝나지 않는다', async () => {
    const { owner, s } = await setup();
    await expect(spacesSvc.addMember(s.id, { username: 'newbie', role: 'viewer' }, owner)).resolves.toBeUndefined();
    expect((await spacesSvc.members(s.id, owner)).map((m) => m.username)).toEqual(['mate', 'newbie', 'owner']);
  });
});

describe('지우기도 판정한 상태에서만 (P15 병합 전 검토)', () => {
  it('**이름을 바꾸는 사이 관리자가 중지하면 409** — 중지된 공간의 이름이 바뀌지 않는다 (좁은 재검토 13)', { timeout: 30_000 }, async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const suspending = await holdOpen((tx) => spacesSvc.changeStatus(s.id, 'suspended', admin, tx));
    const renaming = settle(spacesSvc.update(s.id, { name: '바뀐 이름' }, owner));
    await releaseAfter(suspending, 1);
    expect(await renaming).toBeInstanceOf(ConflictException);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) }))?.name).toBe('팀');
  });

  it('**주인의 지우기(활성으로 판정)와 관리자의 중지가 겹치면 409** — 중지된 공간을 주인이 지우지 않는다', { timeout: 30_000 }, async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    const suspending = await holdOpen((tx) => spacesSvc.changeStatus(s.id, 'suspended', admin, tx));
    const removing = settle(spacesSvc.softDelete(s.id, owner));
    await releaseAfter(suspending, 1);
    expect(await removing).toBeInstanceOf(ConflictException);
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) });
    expect([row?.status, row?.deletedAt]).toEqual(['suspended', null]);
  });

  it('**두 번 지우면 뒤의 것은 409, 지워지는 사이 다시 쓰게 해도 409** — 감사가 두 줄 남거나 지운 공간의 상태가 바뀌지 않는다', { timeout: 30_000 }, async () => {
    const owner = await user('owner');
    const admin = await user('boss', 'admin');
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await spacesSvc.changeStatus(s.id, 'suspended', admin);
    const first = await holdOpen((tx) => spacesSvc.softDelete(s.id, admin, tx));
    const second = settle(spacesSvc.softDelete(s.id, admin));
    const resume = settle(spacesSvc.changeStatus(s.id, 'active', admin));
    await releaseAfter(first, 2);
    expect(await second).toBeInstanceOf(ConflictException);
    expect(await resume).toBeInstanceOf(ConflictException);
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, s.id) });
    expect(row?.status).toBe('suspended');
    expect(row?.deletedAt).not.toBeNull();
  });
});

describe('분류 — 누구나 만들고, 이름 바꾸기·지우기는 만든 사람과 관리자 (P15 C.3, 보류 33)', () => {
  const ctrl = () => new CategoriesController(new AuditService(db), db);
  const viewOf = async (me: Principal, id: string) => (await ctrl().list(me as never)).find((c) => c.id === id)!;

  it('**목록이 할 수 있는 일과 쓰임을 싣는다** — 휴지통의 공간도, Crew의 owner로 있는 공간은 자기 것으로 센다 (FR-1623)', async () => {
    const a = await user('a');
    const b = await user('b');
    const admin = await user('boss', 'admin');
    const cat = await ctrl().create({ name: '운영' }, a as never, REQ);
    expect([cat.createdBy, cat.usage, cat.access]).toEqual([a.id, { spaces: 0, otherSpaces: 0 }, { canRename: true, canDelete: true }]);
    expect((await viewOf(b, cat.id)).access).toEqual({ canRename: false, canDelete: false });
    // 바꿀 수 없는 사람에게는 쓰임을 싣지 않는다 — 남의 비공개 공간·휴지통까지 센 수다 (병합 전 검토)
    expect((await viewOf(b, cat.id)).usage).toBeNull();

    await spacesSvc.create({ name: 'a 공간', kind: 'personal', categoryId: cat.id, description: '' }, a);
    // b가 만든 팀이지만 a가 owner로 있다 — a의 공간이다
    const shared = await spacesSvc.create({ name: '같이', kind: 'team', categoryId: cat.id, description: '' }, b);
    await spacesSvc.addMember(shared.id, { username: 'a', role: 'editor' }, b);
    await spacesSvc.changeMemberRole(shared.id, a.id, 'owner', b);
    expect((await viewOf(a, cat.id)).usage).toEqual({ spaces: 2, otherSpaces: 0 });
    expect((await viewOf(a, cat.id)).access).toEqual({ canRename: true, canDelete: true });

    // b 혼자의 팀이 쓰고 휴지통으로 갔다 — 그래도 남의 공간이다
    const theirs = await spacesSvc.create({ name: 'b 팀', kind: 'team', categoryId: cat.id, description: '' }, b);
    await spacesSvc.softDelete(theirs.id, b);
    expect((await viewOf(a, cat.id)).usage).toEqual({ spaces: 3, otherSpaces: 1 });
    // 만든 사람은 바꿀 수 없어도 쓰임을 본다 — 왜 못 지우는지
    expect((await viewOf(a, cat.id)).access).toEqual({ canRename: false, canDelete: false });
    expect((await viewOf(admin, cat.id)).access).toEqual({ canRename: true, canDelete: true });
    expect((await viewOf(withGrants(b, ['category.manage']), cat.id)).access).toEqual({ canRename: true, canDelete: true });
    expect((await viewOf(withGrants(b, ['space.oversee']), cat.id)).access).toEqual({ canRename: false, canDelete: false });
    expect((await viewOf(withGrants(b, ['space.oversee']), cat.id)).usage).toBeNull();
    expect((await viewOf(admin, cat.id)).usage).toEqual({ spaces: 3, otherSpaces: 1 });
  });

  it('**만든 사람은 자기 공간만 쓰면 지운다** — 그 공간은 분류 없음이 되고 감사에 남는다 (FR-1621·1622)', async () => {
    const a = await user('a');
    const cat = await ctrl().create({ name: '운영' }, a as never, REQ);
    const mine = await spacesSvc.create({ name: 'a 공간', kind: 'personal', categoryId: cat.id, description: '' }, a);
    await expect(ctrl().remove(cat.id, a as never, REQ)).resolves.toEqual({ ok: true });
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, mine.id) }))?.categoryId).toBeNull();
    expect(await db.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, cat.id) })).toBeUndefined();
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'category.delete'));
    expect(audit.detail).toEqual({ name: '운영', cleared: [{ id: mine.id, name: 'a 공간', deleted: false }] });
  });

  it('**남의 공간이 쓰면 만든 사람도 이름을 못 바꾸고 못 지운다** — 관리자와 분류 관리를 받은 사람은 한다. 휴지통의 공간도 분류 없음이 된다', async () => {
    const a = await user('a');
    const b = await user('b');
    const c = await user('c');
    const admin = await user('boss', 'admin');
    const cat = await ctrl().create({ name: '운영' }, a as never, REQ);
    const theirs = await spacesSvc.create({ name: 'b 팀', kind: 'team', categoryId: cat.id, description: '' }, b);
    await spacesSvc.softDelete(theirs.id, b);

    await expect(ctrl().remove(cat.id, a as never, REQ)).rejects.toThrow(/남의 공간이 쓰는 분류는/);
    await expect(ctrl().rename(cat.id, { name: '운영2' }, a as never, REQ)).rejects.toThrow(/남의 공간이 쓰는 분류는/);
    await expect(ctrl().remove(cat.id, c as never, REQ)).rejects.toThrow(/만든 사람과 관리자가/);
    await expect(ctrl().rename(cat.id, { name: '운영2' }, withGrants(c, ['category.manage']) as never, REQ)).resolves.toMatchObject({ name: '운영2' });
    await expect(ctrl().remove(cat.id, admin as never, REQ)).resolves.toEqual({ ok: true });
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, theirs.id) }))?.categoryId).toBeNull();
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'category.delete'));
    expect(audit.detail).toEqual({ name: '운영2', cleared: [{ id: theirs.id, name: 'b 팀', deleted: true }] });
  });

  it('**이름이 겹치면 409** — 이미 있는 이름, 그리고 확인과 쓰기 사이에 누가 같은 이름을 만들었을 때(유일 제약 — 500이 아니다) (병합 전 자체 점검 2)', { timeout: 30_000 }, async () => {
    const admin = await user('boss', 'admin');
    const cat = await ctrl().create({ name: '운영' }, admin as never, REQ);
    await ctrl().create({ name: '재무' }, admin as never, REQ);
    await expect(ctrl().rename(cat.id, { name: '재무' }, admin as never, REQ)).rejects.toThrow(ConflictException);
    // 같은 이름을 넣고 커밋하기 전에 이름을 바꾼다 — 앞의 확인에는 보이지 않고, 쓰기가 유일 제약에서 기다렸다가 부딪힌다
    const inserting = await holdOpen((tx) => tx.insert(spaceCategories).values({ name: '인사', createdBy: admin.id }));
    const renaming = settle(ctrl().rename(cat.id, { name: '인사' }, admin as never, REQ));
    await releaseAfter(inserting, 1);
    const got = await renaming;
    expect(got).toBeInstanceOf(ConflictException);
    expect((got as Error).message).toBe('같은 이름의 분류가 이미 있다');
    expect((await db.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, cat.id) }))?.name).toBe('운영');
  });

  it('**권한 없는 사람은 줄에 서지 않는다** — 분류 행이 잠겨 있어도 만든 사람도 분류 관리도 아니면 곧바로 403 (병합 전 보안 검토 후보 c)', { timeout: 30_000 }, async () => {
    const a = await user('a');
    const stranger = await user('stranger');
    const cat = await ctrl().create({ name: '운영' }, a as never, REQ);
    const locked = await holdOpen((tx) => tx.select().from(spaceCategories).where(eq(spaceCategories.id, cat.id)).for('update'));
    try {
      expect(await within(ctrl().remove(cat.id, stranger as never, REQ))).toBeInstanceOf(ForbiddenException);
      expect(await within(ctrl().rename(cat.id, { name: '바꿈' }, stranger as never, REQ))).toBeInstanceOf(ForbiddenException);
    } finally {
      locked.release();
      await locked.done;
    }
  });

  it('**남이 붙이는 사이 만든 사람이 지우면 기다렸다가 다시 센다** — 분류 행을 잠그므로 붙이기가 끝난 뒤의 쓰임으로 판정한다(403) (D.4)', { timeout: 30_000 }, async () => {
    const a = await user('a');
    const b = await user('b');
    const cat = await ctrl().create({ name: '곧 남의 것' }, a as never, REQ);
    const theirs = await spacesSvc.create({ name: 'b 팀', kind: 'team', categoryId: null, description: '' }, b);
    // b가 분류를 붙이고 아직 커밋하지 않았다 — 외래 키 검사가 분류 행을 잡고 있다
    const attaching = await holdOpen((tx) => tx.update(spaces).set({ categoryId: cat.id }).where(eq(spaces.id, theirs.id)));
    const removing = settle(ctrl().remove(cat.id, a as never, REQ));
    // 지우기가 분류 행의 잠금 앞에 선 뒤에 푼다 — 먼저 풀면 잠금이 없어도 붙이기가 끝난 뒤에 세어 403이 된다
    await releaseAfter(attaching, 1);
    // 잠그지 않고 세면 쓰임 0(커밋 전)으로 판정하고 지우려다 외래 키로 터진다 — 거절이 아니라 오류였다
    expect(await removing).toBeInstanceOf(ForbiddenException);
    expect(await db.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, cat.id) })).toBeTruthy();
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, theirs.id) }))?.categoryId).toBe(cat.id);
  });

  it('**다른 외래 키가 깨진 것은 "없는 분류다"로 바꾸지 않는다** — 분류 외래 키의 이름만 본다 (병합 전 코드 리뷰 12)', async () => {
    // 없는 사람으로 만든다 — 만든 사람의 외래 키가 깨진다. 분류와는 상관이 없다
    const ghost: Principal = { id: '00000000-0000-4000-8000-00000000abcd', role: 'member' };
    const got = await settle(spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, ghost));
    expect(got).toBeInstanceOf(Error);
    expect(got).not.toBeInstanceOf(BadRequestException);
    expect(inspect(got, { depth: 6 })).toMatch(/spaces_created_by_users_id_fk|created_by/);
  });

  it('**지우는 사이 공간에 그 분류를 붙이면 400이다** — 분류 행의 잠금 뒤에 줄을 서고, 지워진 분류를 만난다(500이 아니다) (D.4)', { timeout: 30_000 }, async () => {
    const admin = await user('boss', 'admin');
    const owner = await user('owner');
    const [cat] = await db.insert(spaceCategories).values({ name: '곧 지움', createdBy: admin.id }).returning();
    const s = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    // 분류 지우기와 같은 순서 — 잠그고, 쓰던 공간을 비우고, 지운다. 커밋하기 전에 붙이기와 만들기가 온다
    const deleting = await holdOpen(async (tx) => {
      await tx.select().from(spaceCategories).where(eq(spaceCategories.id, cat.id)).for('update');
      await tx.update(spaces).set({ categoryId: null }).where(eq(spaces.categoryId, cat.id));
      await tx.delete(spaceCategories).where(eq(spaceCategories.id, cat.id));
    });
    const attach = settle(spacesSvc.update(s.id, { categoryId: cat.id }, owner));
    const create = settle(spacesSvc.create({ name: '새 팀', kind: 'team', categoryId: cat.id, description: '' }, owner));
    // 둘 다 외래 키 검사가 분류 행의 잠금 앞에 선 뒤에 푼다 — 먼저 풀면 앞단의 확인이 400을 내어 23503 길을 거치지 않는다
    await releaseAfter(deleting, 2);
    for (const got of [await attach, await create]) {
      expect(got).toBeInstanceOf(BadRequestException);
      expect((got as Error).message).toBe('없는 분류다');
    }
  });
});
