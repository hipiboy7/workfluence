import type { DocNode, Principal } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommentsService } from '../comments/comments.service';
import { PagesService } from '../pages/pages.service';
import { comments, notifications, pages, spaceMembers, spaces, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { InAppChannel, NotificationsService } from './notifications.service';

/** B등급 (P4_설계서_Admin E절). 실제 PostgreSQL. */

let db: TestDb;
let spacesSvc: SpacesService;
let svc: NotificationsService;
let commentsSvc: CommentsService;
let pagesSvc: PagesService;

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
  pagesSvc = new PagesService(db, spacesSvc, svc);
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

describe('페이지 본문의 멘션 (FR-500 — 자체 점검 1)', () => {
  it('**본문에 적은 @아이디도 알림을 만든다.** 댓글만 되던 것을 고쳤다', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);

    const created = await pagesSvc.create(
      { spaceId: sp.id, parentId: null, title: '회의록', content: body('@mate 확인 부탁') },
      owner,
      db,
    );

    const list = await svc.list(mate, 20);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pageId: created.id, commentId: null, actorName: 'owner' });
  });

  it('**새 페이지도 부른 사람들을 호출부에 넘긴다** — 메일은 그것으로 커밋 뒤에 보낸다 (P8 자체 점검 6)', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    await db.update(users).set({ email: 'mate@example.internal' }).where(eq(users.id, mate.id));
    const got: { count: number; recipients: unknown[] }[] = [];
    await pagesSvc.create({ spaceId: sp.id, parentId: null, title: 'T', content: body('@mate 확인') }, owner, db, (m) => got.push(m));
    expect(got).toHaveLength(1);
    expect(got[0].count).toBe(1);
    expect(got[0].recipients).toHaveLength(1);
  });

  it('**같은 사람을 저장할 때마다 다시 부르지 않는다** (코드 리뷰 6)', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const created = await pagesSvc.create({ spaceId: sp.id, parentId: null, title: 'T', content: body('@mate 확인') }, owner, db);
    expect(await svc.list(mate, 20)).toHaveLength(1);

    // 오타 고치듯 두 번 더 저장한다. 멘션은 그대로다
    let v = created.currentVersionNo;
    for (const t of ['@mate 확인 부탁', '@mate 확인 부탁드립니다']) {
      const r = await pagesSvc.update(created.id, { title: 'T', content: body(t), baseVersionNo: v }, owner, db);
      v = r.currentVersionNo;
    }
    expect(await svc.list(mate, 20)).toHaveLength(1);
  });

  it('저장(수정)에서도 만든다', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const created = await pagesSvc.create({ spaceId: sp.id, parentId: null, title: 'T', content: body('내용') }, owner, db);
    expect(await svc.list(mate, 20)).toHaveLength(0);

    await pagesSvc.update(created.id, { title: 'T', content: body('@mate 다시 봐 줘'), baseVersionNo: created.currentVersionNo }, owner, db);
    expect(await svc.list(mate, 20)).toHaveLength(1);
  });
});

describe('대상이 사라진 알림 (FR-506 — 자체 점검 9)', () => {
  async function mentioned() {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const pid = await page(sp.id, owner.id);
    const c = await commentsSvc.create(pid, { body: body('@mate 확인') }, owner);
    return { mate, sp, pid, cid: c.id };
  }

  it('**댓글이 지워지면** 갈 곳이 없다고 알린다', async () => {
    const { mate, cid } = await mentioned();
    expect((await svc.list(mate, 20))[0].pageTitle).not.toBeNull();
    await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, cid));
    expect((await svc.list(mate, 20))[0].pageTitle).toBeNull();
  });

  it('**스페이스가 통째로 지워져도** 마찬가지다 — 링크가 404로 가면 안 된다', async () => {
    const { mate, sp } = await mentioned();
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));
    expect((await svc.list(mate, 20))[0].pageTitle).toBeNull();
  });
});

describe('권한이 회수되면 제목이 가려진다 (보안 검토 3)', () => {
  it('**Crew에서 빠진 뒤에는 바뀐 제목이 흘러나가지 않는다**', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const pid = await page(sp.id, owner.id);
    await commentsSvc.create(pid, { body: body('@mate 확인') }, owner);

    // Crew일 때는 제목이 보인다
    expect((await svc.list(mate, 20))[0].pageTitle).toBe('T');

    // Crew에서 빠지고, 그 뒤 제목이 바뀐다
    await db.delete(spaceMembers).where(eq(spaceMembers.spaceId, sp.id));
    await db.update(pages).set({ title: '3분기 감사 지적사항' }).where(eq(pages.id, pid));

    const after = await svc.list(mate, 20);
    expect(after).toHaveLength(1); // 알림 행은 남는다 (FR-506)
    expect(after[0].pageTitle).toBeNull(); // 제목은 가려진다
    expect(after[0].actorName).toBe('owner');
  });

  it('관리자는 Crew가 아니어도 제목을 본다 — 판정을 공유 함수가 한다', async () => {
    const owner = await user('owner');
    const admin = await user('adm', 'admin');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);
    await commentsSvc.create(pid, { body: body('@adm 확인') }, owner);
    expect((await svc.list(admin, 20))[0].pageTitle).toBe('T');
  });

  it('개인 스페이스의 생성자는 계속 본다', async () => {
    const me = await user('me');
    const other = await user('other', 'admin');
    const [sp] = await db
      .insert(spaces)
      .values({ key: 'PERS01', name: '내 공간', kind: 'personal', status: 'active', description: '', createdBy: me.id })
      .returning();
    const pid = await page(sp.id, me.id);
    await commentsSvc.create(pid, { body: body('@me 메모') }, other);
    expect((await svc.list(me, 20))[0].pageTitle).toBe('T');
  });
});

/**
 * 실시간 편집 저장의 멘션 귀속 (P8_설계서_Mention C.4절, FR-900~902·905).
 *
 * 여기서는 `mentionedBy`(이름마다·나온 곳마다 만든 사람)를 **직접** 넘긴다. 그 표를 게이트웨이가 어떻게 만드는지는
 * `collab.gateway.integration.spec.ts`가 본다.
 */
describe('멘션을 만든 사람 — `mentionedBy` (P8)', () => {
  /** 이름마다, 나온 곳마다 그 멘션을 만든 사람 (게이트웨이가 만드는 모양) */
  const by = (entries: Record<string, (string | null)[]>): ReadonlyMap<string, readonly (string | null)[]> => new Map(Object.entries(entries));

  it('**부른 사람은 저장한 사람이 아니라 그 멘션을 만든 사람이다** (FR-900)', async () => {
    const { mate, typist, sp, pid } = await setup();
    // 저장한 사람(마지막으로 키를 누른 사람)은 mate 자신이다 — 예전에는 이것이 "부른 사람"이 됐다
    const r = await svc.notifyMentions({ doc: body('@mate 확인'), pageId: pid, spaceId: sp.id, actorId: mate.id, mentionedBy: by({ mate: [typist.id] }) });

    expect(r.count).toBe(1);
    const list = await svc.list(mate, 20);
    expect(list[0].actorName).toBe('typist');
    // 메일도 받는 사람별로 그 이름을 싣고 간다 (FR-905)
    expect(r.recipients).toEqual([{ email: 'mate@example.internal', displayName: 'mate', calledBy: 'typist', calledById: typist.id }]);
  });

  it('**만든 사람을 모르면 비운다** — 알림은 가고, 목록에서 사라지지 않는다 (FR-901)', async () => {
    const { mate, typist, sp, pid } = await setup();
    const r = await svc.notifyMentions({ doc: body('@mate 확인'), pageId: pid, spaceId: sp.id, actorId: typist.id, mentionedBy: by({ mate: [null] }) });

    expect(r.count).toBe(1);
    const [row] = await db.select().from(notifications).where(eq(notifications.userId, mate.id));
    expect(row.actorId).toBeNull();
    // `innerJoin`이었으면 여기서 0건이다
    const list = await svc.list(mate, 20);
    expect(list).toHaveLength(1);
    expect(list[0].actorName).toBeNull();
    expect(r.recipients[0].calledBy).toBeNull();
  });

  it('**표에서 그 이름을 못 찾으면 모름이다** — 저장한 사람으로 대신하지 않는다', async () => {
    const { mate, typist, sp, pid } = await setup();
    await svc.notifyMentions({ doc: body('@mate 확인'), pageId: pid, spaceId: sp.id, actorId: typist.id, mentionedBy: by({}) });
    const [row] = await db.select().from(notifications).where(eq(notifications.userId, mate.id));
    expect(row.actorId).toBeNull();
  });

  it('**스스로를 부른 것이 확실하면** 알림을 만들지 않는다 (FR-902)', async () => {
    const { mate, typist, sp, pid } = await setup();
    const r = await svc.notifyMentions({ doc: body('@mate 메모'), pageId: pid, spaceId: sp.id, actorId: typist.id, mentionedBy: by({ mate: [mate.id] }) });
    expect(r.count).toBe(0);
  });

  it('**저장한 사람이 불린 사람이어도 만든 사람이 남이면 알림이 간다** — Phase 7 전에는 여기서 사라졌다', async () => {
    const { owner, mate, sp, pid } = await setup();
    const r = await svc.notifyMentions({ doc: body('@mate 확인'), pageId: pid, spaceId: sp.id, actorId: mate.id, mentionedBy: by({ mate: [owner.id] }) });
    expect(r.count).toBe(1);
    expect((await svc.list(mate, 20))[0].actorName).toBe('owner');
  });

  it('**스스로 부른 곳이 앞에 있어도 남이 부른 곳이 있으면 알림이 간다** (P8 코드 리뷰 2)', async () => {
    const { mate, typist, sp, pid } = await setup();
    // mate가 앞에서 `@mate`를 스스로 적고, typist가 뒤에서 `@mate`를 불렀다
    const r = await svc.notifyMentions({ doc: body('@mate @mate'), pageId: pid, spaceId: sp.id, actorId: mate.id, mentionedBy: by({ mate: [mate.id, typist.id] }) });
    expect(r.count).toBe(1);
    expect((await svc.list(mate, 20))[0].actorName).toBe('typist');
    expect(r.recipients[0]).toMatchObject({ calledBy: 'typist', calledById: typist.id });
  });

  it('REST 경로(`mentionedBy` 없음)는 그대로 요청한 사람이 부른 사람이고, 메일 이름은 호출부가 준다', async () => {
    const { owner, mate, sp, pid } = await setup();
    const r = await svc.notifyMentions({ doc: body('@mate 확인'), pageId: pid, spaceId: sp.id, actorId: owner.id });
    expect((await svc.list(mate, 20))[0].actorName).toBe('owner');
    expect(r.recipients[0].calledBy).toBeNull();
  });
});
