import type { DocNode, Principal } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommentsService } from '../comments/comments.service';
import { pages, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { InAppChannel, NotificationsService } from './notifications.service';

/** B등급 (P4_설계서_Admin E절). 실제 PostgreSQL. */

let db: TestDb;
let spacesSvc: SpacesService;
let svc: NotificationsService;
let commentsSvc: CommentsService;

const body = (text: string): DocNode => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function user(username: string, role: 'root' | 'admin' | 'member' = 'member'): Promise<Principal> {
  const [u] = await db.insert(users).values({ username, displayName: username, passwordHash: 'x', role, status: 'active' }).returning();
  return { id: u.id, role };
}
async function page(spaceId: string, uid: string): Promise<string> {
  const [p] = await db
    .insert(pages)
    .values({ spaceId, parentId: null, title: 'T', position: 0, currentVersionNo: 1, searchText: '', createdBy: uid, updatedBy: uid })
    .returning();
  return p.id;
}
const eqPage = (id: string) => eq(pages.id, id);
const team = (me: Principal) => spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  svc = new NotificationsService(db, new InAppChannel());
  commentsSvc = new CommentsService(db, spacesSvc, svc);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('멘션 알림 (FR-500~504)', () => {
  it('Crew를 부르면 알림이 간다', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const pid = await page(sp.id, owner.id);

    await commentsSvc.create(pid, { body: body('@mate 확인 부탁') }, owner);

    const list = await svc.list(mate, 20);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'mention', pageId: pid, actorName: 'owner', readAt: null });
    expect(await svc.unreadCount(mate)).toBe(1);
  });

  it('**볼 수 없는 사람은 부를 수 없다** (FR-502) — 알림이 존재를 알려 주면 안 된다', async () => {
    const owner = await user('owner');
    const outsider = await user('outsider');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);

    await commentsSvc.create(pid, { body: body('@outsider 봐 줘') }, owner);
    expect(await svc.list(outsider, 20)).toHaveLength(0);
  });

  it('자기 자신은 부르지 않는다 (FR-503)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await commentsSvc.create(pid, { body: body('@me 메모') }, me);
    expect(await svc.list(me, 20)).toHaveLength(0);
  });

  it('같은 사람을 여러 번 적어도 알림은 하나다 (FR-504)', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const pid = await page(sp.id, owner.id);
    await commentsSvc.create(pid, { body: body('@mate @mate 그리고 @mate') }, owner);
    expect(await svc.list(mate, 20)).toHaveLength(1);
  });

  it('없는 아이디를 적어도 아무 일도 없다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await expect(commentsSvc.create(pid, { body: body('@nobody 있나요') }, me)).resolves.toBeTruthy();
  });

  it('관리자는 Crew가 아니어도 볼 수 있으므로 알림이 간다 — 판정을 공유 함수 한 곳이 한다', async () => {
    const owner = await user('owner');
    const admin = await user('adm', 'admin');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);
    await commentsSvc.create(pid, { body: body('@adm 확인 부탁') }, owner);
    expect(await svc.list(admin, 20)).toHaveLength(1);
  });
});

describe('알림함 (FR-505~508)', () => {
  async function seeded() {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const pid = await page(sp.id, owner.id);
    await commentsSvc.create(pid, { body: body('@mate 하나') }, owner);
    await commentsSvc.create(pid, { body: body('@mate 둘') }, owner);
    return { owner, mate, pid };
  }

  it('읽음 처리하면 안 읽은 수가 준다', async () => {
    const { mate } = await seeded();
    expect(await svc.unreadCount(mate)).toBe(2);
    const [first] = await svc.list(mate, 20);
    await svc.markRead(first.id, mate);
    expect(await svc.unreadCount(mate)).toBe(1);
  });

  it('모두 읽음', async () => {
    const { mate } = await seeded();
    expect(await svc.markAllRead(mate)).toBe(2);
    expect(await svc.unreadCount(mate)).toBe(0);
  });

  it('남의 알림은 읽을 수 없고, 있는지도 알려 주지 않는다 (FR-508)', async () => {
    const { owner, mate } = await seeded();
    const [n] = await svc.list(mate, 20);
    await expect(svc.markRead(n.id, owner)).rejects.toThrow(/찾을 수 없다/);
    expect(await svc.unreadCount(mate)).toBe(2);
  });

  it('**대상이 지워져도 알림은 남는다** (FR-506). 제목만 없어진다', async () => {
    const { mate, pid } = await seeded();
    await svc.markAllRead(mate);
    await db.update(pages).set({ deletedAt: new Date() }).where(eqPage(pid));
    const list = await svc.list(mate, 20);
    expect(list).toHaveLength(2);
    expect(list[0].pageTitle).toBeNull();
    expect(list[0].actorName).toBe('owner');
  });

  it('최신 것이 먼저 나온다', async () => {
    const { mate } = await seeded();
    const list = await svc.list(mate, 20);
    expect(new Date(list[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(list[1].createdAt).getTime());
  });
});
