import { DOCUMENT_SCHEMA_VERSION, type DocNode } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { auditEvents } from '../db/schema';
import { MentionMailService } from '../mail/mention-mail.service';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person, teamPage } from '../test/people';
import { CommentUseCases } from './comments.usecases';
import { CommentsService } from './comments.service';

/**
 * 댓글의 유스케이스 (P3_설계서_Content · FR-754 · docs/spinoff/public-api 계획서 7.1절). B등급 — 실제 PostgreSQL.
 * 메일 발송만 대역이다(2절 DIP 표의 알림 발송 축) — **커밋 뒤에 한 번** 나가는지를 본다
 */

let db: TestDb;
let spacesSvc: SpacesService;
let mail: { notify: ReturnType<typeof vi.fn> };
let uc: CommentUseCases;
const META = { ip: '10.0.0.12' };
const body = (t: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  mail = { notify: vi.fn().mockResolvedValue(undefined) };
  const svc = new CommentsService(db, spacesSvc, new NotificationsService(db, new InAppChannel()));
  uc = new CommentUseCases(svc, new AuditService(db), mail as unknown as MentionMailService, db);
});

describe('쓰기', () => {
  it('쓰고 감사에 페이지·부모·IP를 남긴다', async () => {
    const me = await person(db, 'me');
    const { pageId } = await teamPage(db, spacesSvc, me);
    const c = await uc.create(pageId, { body: body('첫 말') }, me, META);
    const [r] = await rows('comment.create');
    expect(r).toMatchObject({ actorId: me.id, targetType: 'comment', targetId: c.id, ip: META.ip, detail: { pageId, parentId: null } });
    expect(mail.notify).not.toHaveBeenCalled();
  });

  it('**멘션이 있으면 커밋 뒤에 메일을 한 번** — 실제 제목과 부른 사람을 넘긴다 (자체 점검 20 · P8 FR-906)', async () => {
    const me = await person(db, 'me');
    await person(db, 'mate', 'member', { email: 'mate@example.internal' });
    const { spaceId, pageId } = await teamPage(db, spacesSvc, me, '주간 회의');
    await spacesSvc.addMember(spaceId, { username: 'mate', role: 'editor' }, me);

    const c = await uc.create(pageId, { body: body('@mate 확인 부탁') }, me, META);

    expect(mail.notify).toHaveBeenCalledTimes(1);
    const [outcome, actorName, title, actorId] = mail.notify.mock.calls[0]!;
    expect(outcome).toMatchObject({ count: 1, pageId, commentId: c.id });
    expect(actorName).toBe(me.displayName);
    expect(title).toBe('주간 회의');
    expect(actorId).toBe(me.id);
  });

  it('막히면 감사도 메일도 없다', async () => {
    const owner = await person(db, 'owner');
    const other = await person(db, 'other');
    await person(db, 'mate', 'member', { email: 'mate@example.internal' });
    const { pageId } = await teamPage(db, spacesSvc, owner);
    await expect(uc.create(pageId, { body: body('@mate') }, other, META)).rejects.toThrow();
    expect(await rows('comment.create')).toHaveLength(0);
    expect(mail.notify).not.toHaveBeenCalled();
  });

  it('메일이 실패해도 댓글은 남는다 — 기다리지 않는다', async () => {
    const me = await person(db, 'me');
    await person(db, 'mate', 'member', { email: 'mate@example.internal' });
    const { spaceId, pageId } = await teamPage(db, spacesSvc, me);
    await spacesSvc.addMember(spaceId, { username: 'mate', role: 'editor' }, me);
    mail.notify.mockRejectedValue(new Error('메일 서버가 죽었다'));
    await expect(uc.create(pageId, { body: body('@mate') }, me, META)).resolves.toBeDefined();
    expect(await rows('comment.create')).toHaveLength(1);
  });
});

describe('고치기·지우기', () => {
  it('고치면 comment.update, 지우면 comment.delete — 둘 다 페이지를 싣는다', async () => {
    const me = await person(db, 'me');
    const { pageId } = await teamPage(db, spacesSvc, me);
    const c = await uc.create(pageId, { body: body('처음') }, me, META);
    await uc.update(c.id, { body: body('나중') }, me, META);
    await uc.remove(c.id, me, META);
    expect((await rows('comment.update'))[0]).toMatchObject({ targetId: c.id, ip: META.ip, detail: { pageId } });
    expect((await rows('comment.delete'))[0]).toMatchObject({ targetId: c.id, ip: META.ip, detail: { pageId } });
  });

  it('남의 댓글은 못 고치고 감사가 남지 않는다', async () => {
    const owner = await person(db, 'owner');
    await person(db, 'mate');
    const { spaceId, pageId } = await teamPage(db, spacesSvc, owner);
    await spacesSvc.addMember(spaceId, { username: 'mate', role: 'editor' }, owner);
    const mate = (await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.username, 'mate') }))!;
    const c = await uc.create(pageId, { body: body('내 말') }, owner, META);
    const asMate = { id: mate.id, username: 'mate', displayName: 'mate', role: 'member' as const, mustChangePassword: false, grants: [], hasPassword: true };
    await expect(uc.update(c.id, { body: body('바꿈') }, asMate, META)).rejects.toThrow(/남의 댓글/);
    expect(await rows('comment.update')).toHaveLength(0);
  });
});
