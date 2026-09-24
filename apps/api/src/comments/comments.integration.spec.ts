import { emptyDocument, type DocNode, type Principal, DOCUMENT_SCHEMA_VERSION } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { comments, pages, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { CommentsService } from './comments.service';

/** B등급 (P3_설계서_Content 5절). 실제 PostgreSQL. */

let db: TestDb;
let spacesSvc: SpacesService;
let svc: CommentsService;

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
const team = (me: Principal) => spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  // 알림은 실제 구현을 쓴다 — 댓글 저장이 알림을 만드는 것까지가 이 모듈의 동작이다
  svc = new CommentsService(db, spacesSvc, new NotificationsService(db, new InAppChannel()));
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('작성·수정 (FR-420)', () => {
  it('댓글을 달면 목록에 시간 순으로 나온다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);

    await svc.create(pid, { body: body('첫 번째') }, me);
    await svc.create(pid, { body: body('두 번째') }, me);

    const list = await svc.list(pid, me);
    expect(list.map((c) => (c.body.content?.[0].content?.[0] as { text: string }).text)).toEqual(['첫 번째', '두 번째']);
    expect(list[0].createdByName).toBe('me');
  });

  it('서버가 schemaVersion을 찍는다 — 클라이언트가 빠뜨려도 정본에는 남는다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const c = await svc.create(pid, { body: body('내용') }, me);
    const row = await db.query.comments.findFirst({ where: eq(comments.id, c.id) });
    expect((row!.bodyJson as DocNode).attrs?.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
  });

  it('본문이 빈 문서여도 받는다 — 내용 검증은 문서 스키마가 한다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await expect(svc.create(pid, { body: emptyDocument() }, me)).resolves.toBeTruthy();
  });

  it('남의 댓글은 고칠 수 없다', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const pid = await page(sp.id, owner.id);
    const c = await svc.create(pid, { body: body('내 말') }, owner);
    await expect(svc.update(c.id, { body: body('바꿈') }, mate)).rejects.toThrow(/남의 댓글/);
  });
});

describe('대댓글은 한 단계까지 (FR-421)', () => {
  it('댓글에는 답할 수 있다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const parent = await svc.create(pid, { body: body('원글') }, me);
    const child = await svc.create(pid, { parentId: parent.id, body: body('답') }, me);
    expect(child.parentId).toBe(parent.id);
  });

  it('대댓글에는 다시 답할 수 없다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const parent = await svc.create(pid, { body: body('원글') }, me);
    const child = await svc.create(pid, { parentId: parent.id, body: body('답') }, me);
    await expect(svc.create(pid, { parentId: child.id, body: body('답의 답') }, me)).rejects.toThrow(/다시 답할 수 없다/);
  });

  it('다른 페이지의 댓글에는 답할 수 없다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const a = await page(sp.id, me.id);
    const b = await page(sp.id, me.id);
    const parent = await svc.create(a, { body: body('원글') }, me);
    await expect(svc.create(b, { parentId: parent.id, body: body('답') }, me)).rejects.toThrow(/원 댓글/);
  });
});

describe('삭제 권한 (FR-422)', () => {
  it('작성자 본인은 지운다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const c = await svc.create(pid, { body: body('내 말') }, me);
    await svc.remove(c.id, me);
    expect(await svc.list(pid, me)).toHaveLength(0);
  });

  it('스페이스에 쓸 수 있는 사람은 남의 댓글도 지운다', async () => {
    const owner = await user('owner');
    const mate = await user('mate');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'mate', role: 'editor' }, owner);
    const pid = await page(sp.id, owner.id);
    const c = await svc.create(pid, { body: body('mate의 말') }, mate);
    await svc.remove(c.id, owner);
    expect(await svc.list(pid, owner)).toHaveLength(0);
  });

  it('중지된 스페이스에서는 작성자도 지우지 못한다 (자체 점검 #4)', async () => {
    const admin = await user('adm', 'admin');
    const sp = await team(admin);
    const pid = await page(sp.id, admin.id);
    const c = await svc.create(pid, { body: body('내 말') }, admin);
    await spacesSvc.changeStatus(sp.id, 'suspended', admin);
    await expect(svc.remove(c.id, admin)).rejects.toThrow(/쓸 권한/);
    // 읽기는 된다
    expect(await svc.list(pid, admin)).toHaveLength(1);
  });

  it('viewer는 남의 댓글을 지우지 못하고 canDelete도 false다', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'viewer', role: 'viewer' }, owner);
    const pid = await page(sp.id, owner.id);
    const c = await svc.create(pid, { body: body('owner의 말') }, owner);

    const [seen] = await svc.list(pid, viewer);
    expect(seen.canDelete).toBe(false);
    await expect(svc.remove(c.id, viewer)).rejects.toThrow(/권한/);
  });
});

describe('읽기 권한 (FR-423)', () => {
  it('볼 수 없는 스페이스의 댓글은 없는 것이다', async () => {
    const owner = await user('owner');
    const other = await user('other');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);
    await svc.create(pid, { body: body('비밀') }, owner);
    await expect(svc.list(pid, other)).rejects.toThrow(/찾을 수 없다/);
  });

  it('지워진 페이지의 댓글은 보이지 않는다 (FR-427)', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await svc.create(pid, { body: body('내용') }, me);
    await db.update(pages).set({ deletedAt: new Date() }).where(eq(pages.id, pid));
    await expect(svc.list(pid, me)).rejects.toThrow(/페이지를 찾을 수 없다/);
  });
});
