import type { Principal } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
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

    await svc.restorePage(pid, me);
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
    await expect(svc.restorePage(pid, outsider)).rejects.toThrow(/찾을 수 없다/);
  });

  it('viewer는 보지도 되살리지도 못한다 — 되살리기는 쓰기다 (FR-511)', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'viewer', role: 'viewer' }, owner);
    const pid = await page(sp.id, owner.id);
    await drop(pid);

    expect(await svc.listPages(viewer, 50)).toHaveLength(0);
    await expect(svc.restorePage(pid, viewer)).rejects.toThrow(/쓸 권한/);
  });

  it('**부모가 아직 지워져 있으면 최상위로 올린다** (FR-512)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const parent = await page(sp.id, me.id, '부모');
    const child = await page(sp.id, me.id, '자식', parent);
    await drop(child);
    await drop(parent);

    const { movedToRoot } = await svc.restorePage(child, me);
    expect(movedToRoot).toBe(true);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, child) }))?.parentId).toBeNull();
  });

  it('부모가 살아 있으면 제자리로 돌아간다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const parent = await page(sp.id, me.id, '부모');
    const child = await page(sp.id, me.id, '자식', parent);
    await drop(child);

    const { movedToRoot } = await svc.restorePage(child, me);
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

describe('스페이스 휴지통 (FR-513)', () => {
  it('관리자만 보고 되살린다', async () => {
    const owner = await user('owner');
    const admin = await user('adm', 'admin');
    const sp = await team(owner);
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));

    await expect(svc.listSpaces(owner, 50)).rejects.toThrow(/관리자만/);
    expect(await svc.listSpaces(admin, 50)).toHaveLength(1);

    await expect(svc.restoreSpace(sp.id, owner)).rejects.toThrow(/관리자만/);
    await svc.restoreSpace(sp.id, admin);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, sp.id) }))?.deletedAt).toBeNull();
  });

  it('휴지통에 없는 것은 되살릴 수 없다', async () => {
    const admin = await user('adm', 'admin');
    const sp = await team(admin);
    await expect(svc.restoreSpace(sp.id, admin)).rejects.toThrow(/찾을 수 없다/);
  });
});
