import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v1PageQuery, v1TemplateDto, v1TemplateUpdateDto } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import { auditEvents, notifications, pages, spaces } from '../db/schema';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { SpacesService } from '../spaces/spaces.service';
import { TemplatesService } from '../templates/templates.service';
import { TemplateUseCases } from '../templates/templates.usecases';
import { TrashService } from '../trash/trash.service';
import { TrashUseCases } from '../trash/trash.usecases';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { V1NotificationsController, V1TemplatesController, V1TrashController } from './v1-misc.controller';

/**
 * 공개 API v1의 템플릿·휴지통·알림 (docs/spinoff/public-api 설계서 3.3·3.5절 · FR-2210·2223). B등급 — 실제 PostgreSQL. 화면용과 같은 서비스·유스케이스를
 * 부르는 얇은 층이다 — 권한(템플릿은 관리자, 되살리기는 주인·관리자, 알림은 자기 것만)과 감사는 그쪽이 한다. 여기서 보는 것은 에이전트용 단순 계약이다.
 */

let db: TestDb;
let spacesSvc: SpacesService;
let templates: V1TemplatesController;
let trash: V1TrashController;
let notes: V1NotificationsController;
const req = { ip: '10.0.0.20' } as never;
const md = v1PageQuery.parse({});
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  const audit = new AuditService(db);
  templates = new V1TemplatesController(new TemplatesService(db), new TemplateUseCases(new TemplatesService(db), audit, db));
  trash = new V1TrashController(new TrashService(db, spacesSvc), new TrashUseCases(new TrashService(db, spacesSvc), audit, db));
  notes = new V1NotificationsController(new NotificationsService(db, new InAppChannel()));
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

const dto = (x: Record<string, unknown>) => v1TemplateDto.parse(x);

describe('템플릿 — 이름과 본문으로', () => {
  it('관리자가 이름·마크다운 본문만으로 만들고, 읽을 때 마크다운으로 나온다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const t = await templates.create(dto({ name: '회의록', body: '## 안건\n- 하나' }), md, admin, req);
    expect(t).toMatchObject({ name: '회의록', description: null, format: 'markdown', body: '## 안건\n\n- 하나' });
    expect((await rows('template.create'))[0]).toMatchObject({ actorId: admin.id, targetId: t.id, ip: '10.0.0.20' });
  });

  it('목록은 누구나 본다 — 형식을 고른다', async () => {
    const admin = await person(db, 'adm', 'admin');
    const member = await person(db, 'mem');
    await templates.create(dto({ name: 'A', body: '가' }), md, admin, req);
    const list = await templates.list(md, member);
    expect(list.items.map((t) => [t.name, t.body])).toEqual([['A', '가']]);
    expect((await templates.list(v1PageQuery.parse({ format: 'json' }), member)).items[0]!.body).toMatchObject({ type: 'doc' });
  });

  it('고치고 지운다 — 고칠 것만', async () => {
    const admin = await person(db, 'adm', 'admin');
    const t = await templates.create(dto({ name: '옛', body: '본문', description: '쓰임' }), md, admin, req);
    const a = await templates.update(t.id, v1TemplateUpdateDto.parse({ name: '새' }), md, admin, req);
    expect(a).toMatchObject({ name: '새', body: '본문', description: '쓰임' });
    const b = await templates.update(t.id, v1TemplateUpdateDto.parse({ body: '바뀐 본문', description: null }), md, admin, req);
    expect(b).toMatchObject({ name: '새', body: '바뀐 본문', description: null });
    await expect(templates.remove(t.id, admin, req)).resolves.toEqual({ ok: true });
    expect((await templates.list(md, admin)).items).toEqual([]);
  });

  it('**관리자가 아니면 만들지 못한다(403)** — 에이전트도 사람의 권한을 넘지 못한다', async () => {
    const member = await person(db, 'mem');
    await expect(templates.create(dto({ name: 'a', body: 'b' }), md, member, req)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await rows('template.create')).toHaveLength(0);
  });
});

describe('휴지통', () => {
  const trashed = async (me: Awaited<ReturnType<typeof person>>, title = '회의록') => {
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);
    const [p] = await db
      .insert(pages)
      .values({ spaceId: sp.id, parentId: null, title, position: 0, currentVersionNo: 1, searchText: '', createdBy: me.id, updatedBy: me.id, deletedAt: new Date(), deletedBy: me.id })
      .returning();
    return { space: sp, page: p! };
  };

  it('지운 페이지를 보고 되살린다', async () => {
    const me = await person(db, 'me');
    const { page } = await trashed(me);
    const list = await trash.pages({ limit: 100 }, me);
    expect(list.items.map((x) => x.id)).toEqual([page.id]);
    await expect(trash.restorePage(page.id, me, req)).resolves.toEqual({ ok: true, movedToRoot: false });
    expect((await trash.pages({ limit: 100 }, me)).items).toEqual([]);
    expect((await rows('page.restore.trash'))[0]).toMatchObject({ targetId: page.id, ip: '10.0.0.20' });
  });

  it('남의 휴지통은 보이지 않고 되살리지도 못한다', async () => {
    const owner = await person(db, 'owner');
    const mallory = await person(db, 'mallory');
    const { page } = await trashed(owner);
    expect((await trash.pages({ limit: 100 }, mallory)).items).toEqual([]);
    await expect(trash.restorePage(page.id, mallory, req)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('스페이스는 관리자만 되살린다(주인은 403) — 화면용과 같다', async () => {
    const owner = await person(db, 'owner');
    const admin = await person(db, 'adm', 'admin');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await db.update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, sp.id));
    await expect(trash.restoreSpace(sp.id, owner, req)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await trash.spaces({ limit: 100 }, admin)).items.map((s) => s.id)).toEqual([sp.id]);
    await expect(trash.restoreSpace(sp.id, admin, req)).resolves.toEqual({ ok: true });
  });
});

describe('알림 — 자기 것만', () => {
  const note = (userId: string, over: Partial<typeof notifications.$inferInsert> = {}) => db.insert(notifications).values({ userId, kind: 'mention', ...over }).returning();

  it('목록·안 읽은 수·읽음', async () => {
    const me = await person(db, 'me');
    const other = await person(db, 'other');
    const [a] = await note(me.id);
    await note(me.id);
    await note(other.id);
    expect((await notes.list({ limit: 100 }, me)).items).toHaveLength(2);
    expect(await notes.unread(me)).toEqual({ count: 2 });
    await expect(notes.read(a!.id, me)).resolves.toEqual({ ok: true });
    expect(await notes.unread(me)).toEqual({ count: 1 });
    await expect(notes.readAll(me)).resolves.toEqual({ count: 1 });
    expect(await notes.unread(me)).toEqual({ count: 0 });
    expect(await notes.unread(other)).toEqual({ count: 1 });
  });

  it('남의 알림은 읽음으로 만들지 못한다 — 없는 것과 같다', async () => {
    const me = await person(db, 'me');
    const other = await person(db, 'other');
    const [theirs] = await note(other.id);
    const e = await notes.read(theirs!.id, me).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(404);
    expect(await notes.unread(other)).toEqual({ count: 1 });
  });
});
