import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PAGE_TREE_MAX_DEPTH, type Principal } from '@workfluence/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pages, spaces, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { TrashService } from './trash.service';

/** B등급 (P4_설계서_Admin E절). 실제 PostgreSQL. */

let db: TestDb;
let spacesSvc: SpacesService;
let svc: TrashService;

async function user(username: string, role: 'root' | 'admin' | 'member' = 'member'): Promise<Principal> {
  const [u] = await db.insert(users).values({ username, displayName: username, passwordHash: 'x', role, status: 'active' }).returning();
  return { id: u.id, role };
}
async function page(spaceId: string, uid: string, title = 'T', parentId: string | null = null): Promise<string> {
  const [p] = await db
    .insert(pages)
    .values({ spaceId, parentId, title, position: 0, currentVersionNo: 1, searchText: '', createdBy: uid, updatedBy: uid })
    .returning();
  return p.id;
}
const drop = (id: string) => db.update(pages).set({ deletedAt: new Date() }).where(eq(pages.id, id));
const team = (me: Principal) => spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  svc = new TrashService(db, spacesSvc);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('페이지 휴지통 (FR-510~512)', () => {
  it('지운 페이지가 목록에 나오고 되살아난다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id, '회의록');
    await drop(pid);

    const list = await svc.listPages(me, 50);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: pid, title: '회의록', spaceName: '팀' });

    await db.transaction((tx) => svc.restorePage(pid, me, tx));
    expect(await svc.listPages(me, 50)).toHaveLength(0);
    const back = await db.query.pages.findFirst({ where: eq(pages.id, pid) });
    expect(back?.deletedAt).toBeNull();
  });

  it('**볼 수 없는 스페이스의 것은 목록에 없다** — 가져와서 거르지 않고 질의에서 건다', async () => {
    const owner = await user('owner');
    const outsider = await user('outsider');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);
    await drop(pid);

    expect(await svc.listPages(outsider, 50)).toHaveLength(0);
    await expect(db.transaction((tx) => svc.restorePage(pid, outsider, tx))).rejects.toThrow(/찾을 수 없다/);
  });

  it('viewer는 보지도 되살리지도 못한다 — 되살리기는 쓰기다 (FR-511)', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'viewer', role: 'viewer' }, owner);
    const pid = await page(sp.id, owner.id);
    await drop(pid);

    expect(await svc.listPages(viewer, 50)).toHaveLength(0);
    await expect(db.transaction((tx) => svc.restorePage(pid, viewer, tx))).rejects.toThrow(/쓸 권한/);
  });

  it('**부모가 아직 지워져 있으면 최상위로 올린다** (FR-512)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const parent = await page(sp.id, me.id, '부모');
    const child = await page(sp.id, me.id, '자식', parent);
    await drop(child);
    await drop(parent);

    const { movedToRoot } = await db.transaction((tx) => svc.restorePage(child, me, tx));
    expect(movedToRoot).toBe(true);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, child) }))?.parentId).toBeNull();
  });

  it(`**제자리가 ${PAGE_TREE_MAX_DEPTH}단계를 넘게 됐으면 최상위로 올린다** — 지운 뒤 부모가 더 깊이 옮겨졌다(옮기기는 지운 자식을 세지 않는다 — P14 병합 전 코드 리뷰 7)`, async () => {
    const me = await user('me');
    const sp = await team(me);
    // 부모가 맨 아래(10단계)에 있다 — 자식이 제자리로 돌아가면 11단계
    let parent: string | null = null;
    for (let i = 1; i <= PAGE_TREE_MAX_DEPTH; i++) parent = await page(sp.id, me.id, `L${i}`, parent);
    const child = await page(sp.id, me.id, '자식', parent);
    await drop(child);

    const { movedToRoot } = await db.transaction((tx) => svc.restorePage(child, me, tx));
    expect(movedToRoot).toBe(true);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, child) }))?.parentId).toBeNull();
  });

  it(`${PAGE_TREE_MAX_DEPTH}단계까지는 제자리로 돌아간다`, async () => {
    const me = await user('me');
    const sp = await team(me);
    let parent: string | null = null;
    for (let i = 1; i < PAGE_TREE_MAX_DEPTH; i++) parent = await page(sp.id, me.id, `L${i}`, parent);
    const child = await page(sp.id, me.id, '자식', parent);
    await drop(child);

    const { movedToRoot } = await db.transaction((tx) => svc.restorePage(child, me, tx));
    expect(movedToRoot).toBe(false);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, child) }))?.parentId).toBe(parent);
  });

  it('**되살리기도 트리 잠금을 쓴다** — 앞의 트리 작업을 2초 넘게 기다리면 409 (P14 FR-1503, 반영분 점검 7)', { timeout: 30_000 }, async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await drop(pid);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedNow = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`page-tree:${sp.id}`}))`);
      locked();
      await held;
    });
    await lockedNow;
    try {
      await expect(db.transaction((tx) => svc.restorePage(pid, me, tx))).rejects.toThrow(ConflictException);
    } finally {
      release();
      await holder;
    }
  });

  it('**두 번 눌러도 한 번이다** — 잠근 뒤 다시 읽어, 뒤의 것은 앞의 되살리기를 보고 404 (반영분 점검 1)', { timeout: 30_000 }, async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await drop(pid);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let restored!: () => void;
    const restoredNow = new Promise<void>((r) => (restored = r));
    const first = db.transaction(async (tx) => {
      await svc.restorePage(pid, me, tx);
      restored();
      await held;
    });
    await restoredNow;
    const second = db.transaction((tx) => svc.restorePage(pid, me, tx)).then(
      () => 'ok',
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 300));
    release();
    await first;
    expect(await second).toBeInstanceOf(NotFoundException);
  });

  it('부모가 살아 있으면 제자리로 돌아간다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const parent = await page(sp.id, me.id, '부모');
    const child = await page(sp.id, me.id, '자식', parent);
    await drop(child);

    const { movedToRoot } = await db.transaction((tx) => svc.restorePage(child, me, tx));
    expect(movedToRoot).toBe(false);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, child) }))?.parentId).toBe(parent);
  });

  it('지워진 스페이스의 페이지는 목록에 없다 — 스페이스를 먼저 되살려야 한다', async () => {
    const admin = await user('adm', 'admin');
    const sp = await team(admin);
    const pid = await page(sp.id, admin.id);
    await drop(pid);
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));
    expect(await svc.listPages(admin, 50)).toHaveLength(0);
  });

  it('지우지 않은 페이지는 휴지통에 없다', async () => {
    const me = await user('me');
    const sp = await team(me);
    await page(sp.id, me.id);
    expect(await svc.listPages(me, 50)).toHaveLength(0);
  });
});

describe('스페이스 휴지통 (FR-513 · P15 FR-1630)', () => {
  it('관리자만 보고 되살린다 — 주인도 못 한다', async () => {
    const owner = await user('owner');
    const admin = await user('adm', 'admin');
    const sp = await team(owner);
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));

    await expect(svc.listSpaces(owner, 50)).rejects.toThrow(ForbiddenException);
    expect(await svc.listSpaces(admin, 50)).toHaveLength(1);

    await expect(svc.restoreSpace(sp.id, owner)).rejects.toThrow(ForbiddenException);
    await svc.restoreSpace(sp.id, admin);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, sp.id) }))?.deletedAt).toBeNull();
  });

  it('**스페이스 관리 전체를 받은 member도 보고 되살린다** — 다른 위임(분류 관리·관리자가 건 중지 풀기)은 아니다', async () => {
    const owner = await user('owner');
    const m = await user('ov');
    const sp = await team(owner);
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));
    for (const g of ['category.manage', 'space.unsuspend'] as const) {
      await expect(svc.listSpaces({ ...m, grants: [g] }, 50)).rejects.toThrow(ForbiddenException);
      await expect(svc.restoreSpace(sp.id, { ...m, grants: [g] })).rejects.toThrow(ForbiddenException);
    }
    const overseer: Principal = { ...m, grants: ['space.oversee'] };
    expect((await svc.listSpaces(overseer, 50)).map((v) => v.id)).toEqual([sp.id]);
    await svc.restoreSpace(sp.id, overseer);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, sp.id) }))?.deletedAt).toBeNull();
  });

  it('휴지통에 없는 것은 되살릴 수 없다', async () => {
    const admin = await user('adm', 'admin');
    const sp = await team(admin);
    await expect(svc.restoreSpace(sp.id, admin)).rejects.toThrow(/찾을 수 없다/);
  });
});

describe('NFR-42 — 휴지통 목록 지연', () => {
  it('스페이스당 1,000건에서 p95를 잰다', async () => {
    const me = await user('me');
    const sp = await team(me);

    // 합성 데이터 1,000건. **한 번에 넣는다** — 1,000번 왕복하면 재는 것이 삽입 시간이 된다
    const now = new Date();
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      spaceId: sp.id,
      parentId: null,
      title: `지운 문서 ${i}`,
      position: i,
      currentVersionNo: 1,
      searchText: '',
      createdBy: me.id,
      updatedBy: me.id,
      deletedAt: now,
    }));
    for (let i = 0; i < rows.length; i += 200) await db.insert(pages).values(rows.slice(i, i + 200));

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await svc.listPages(me, 200);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1];
    // 수치를 남긴다 — 검증기록이 이 출력을 인용한다
    console.log(`[NFR-42] 1,000건 휴지통 목록 p50=${samples[9].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${samples[19].toFixed(1)}ms`);
    expect(p95).toBeLessThan(300);
  });
});
