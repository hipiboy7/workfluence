import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v1CreatePageDto, v1MovePageDto, v1PageQuery, v1UpdatePageDto } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import { auditEvents, pages } from '../db/schema';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { PagesService } from '../pages/pages.service';
import { PageUseCases } from '../pages/pages.usecases';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { V1PagesController } from './v1-pages.controller';

/**
 * 공개 API v1의 페이지 (docs/spinoff/public-api 설계서 3.5절 · FR-2210·2215~2217·2223~2225). B등급 — 실제 PostgreSQL. 토큰 가드는 `api-token.guard.spec.ts`가
 * 보고, 여기서는 **컨트롤러가 화면용과 같은 유스케이스를 부르면서 에이전트용 단순 계약을 지키는가**를 본다 — 필수 입력만으로 성공하는가, 기본값이
 * 응답에 보이는가, 편집 중이면 409인가.
 */

let db: TestDb;
let spacesSvc: SpacesService;
let ctrl: V1PagesController;
const live = { hasLiveEditors: vi.fn() };
const notify = vi.fn();
const req = { ip: '10.0.0.17' } as never;
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  const pagesSvc = new PagesService(db, spacesSvc, new NotificationsService(db, new InAppChannel()));
  const uc = new PageUseCases(pagesSvc, new AuditService(db), {} as never, { notify } as never, spacesSvc, db);
  ctrl = new V1PagesController(pagesSvc, uc, spacesSvc, live);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  live.hasLiveEditors.mockReset().mockReturnValue(false);
  notify.mockReset();
});

const md = v1PageQuery.parse({});
const create = (dto: Record<string, unknown>) => v1CreatePageDto.parse(dto);

const setup = async () => {
  const owner = await person(db, 'owner');
  const sp = await spacesSvc.create({ name: '장애 보고', kind: 'team', categoryId: null, description: '' }, owner);
  return { owner, space: sp, mk: (title: string, parentId: string | null = null) => ctrl.create(create({ space: sp.id, title, body: `${title} 본문`, parentId }), md, owner, req) };
};
const codeOf = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body: Record<string, unknown> }> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(HttpException);
  const h = e as HttpException;
  const body = (typeof h.getResponse() === 'string' ? { message: h.getResponse() } : h.getResponse()) as Record<string, unknown>;
  return { status: h.getStatus(), code: body.code as string | undefined, body };
};

describe('만들기 — 스페이스·제목·본문만으로 된다 (FR-2223)', () => {
  it('스페이스 **이름**·제목·마크다운 본문만 주면 만들어지고, 서버가 채운 값이 응답에 보인다 (FR-2225)', async () => {
    const { owner, space } = await setup();
    const view = await ctrl.create(create({ space: '장애 보고', title: '10/7 장애', body: '## 증상\n- 로그인 **지연**' }), md, owner, req);
    expect(view).toMatchObject({
      spaceId: space.id,
      parentId: null,
      title: '10/7 장애',
      currentVersionNo: 1,
      format: 'markdown',
      body: '## 증상\n\n- 로그인 **지연**',
      ancestors: [],
    });
    expect(typeof view.id).toBe('string');
    expect(typeof view.position).toBe('number');
  });

  it('스페이스 id로도 된다', async () => {
    const { owner, space } = await setup();
    expect((await ctrl.create(create({ space: space.id, title: 't', body: 'b' }), md, owner, req)).spaceId).toBe(space.id);
  });

  it('**화면용과 같은 유스케이스를 부른다** — 감사에 같은 행위·IP가 남고, 멘션 메일도 같은 길이다 (FR-2210)', async () => {
    const { owner } = await setup();
    const v = await ctrl.create(create({ space: '장애 보고', title: '감사', body: '글' }), md, owner, req);
    expect((await rows('page.create'))[0]).toMatchObject({ actorId: owner.id, targetId: v.id, ip: '10.0.0.17', detail: { title: '감사' } });
  });

  it('부모를 주면 그 아래에 만들고 조상 경로가 뿌리부터 온다 (G4)', async () => {
    const { owner, mk } = await setup();
    const a = await mk('A');
    const b = await mk('B', a.id);
    const c = await mk('C', b.id);
    expect(c.parentId).toBe(b.id);
    expect(c.ancestors).toEqual([
      { id: a.id, title: 'A' },
      { id: b.id, title: 'B' },
    ]);
    expect((await ctrl.get(c.id, md, owner)).ancestors).toHaveLength(2);
  });

  it('**맨 끝에 붙는다** — 같은 부모에 둘을 만들면 나중 것이 뒤다', async () => {
    const { owner, space, mk } = await setup();
    const first = await mk('첫째');
    const second = await mk('둘째');
    expect(second.position).toBeGreaterThan(first.position);
    expect((await ctrl.list(space.id, undefined, owner)).items.map((p) => p.title)).toEqual(['첫째', '둘째']);
  });

  it('format: json이면 본문을 문서로 받는다', async () => {
    const { owner } = await setup();
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '직접 만든 문서' }] }] };
    const v = await ctrl.create(create({ space: '장애 보고', title: 'j', body: doc, format: 'json' }), md, owner, req);
    expect(v.body).toContain('직접 만든 문서');
  });
});

describe('스페이스 고르기', () => {
  it('**이름이 겹치면 임의로 고르지 않고 409 SPACE_AMBIGUOUS와 후보를 준다**', async () => {
    const { owner } = await setup();
    await spacesSvc.create({ name: '장애 보고', kind: 'team', categoryId: null, description: '' }, owner);
    const r = await codeOf(ctrl.create(create({ space: '장애 보고', title: 't', body: 'b' }), md, owner, req));
    expect(r).toMatchObject({ status: 409, code: 'SPACE_AMBIGUOUS' });
    expect((r.body.details as { candidates: unknown[] }).candidates).toHaveLength(2);
    expect(await rows('page.create')).toHaveLength(0);
  });

  it('없는 이름은 404 SPACE_NOT_FOUND', async () => {
    const { owner } = await setup();
    expect(await codeOf(ctrl.create(create({ space: '없는 곳', title: 't', body: 'b' }), md, owner, req))).toMatchObject({ status: 404, code: 'SPACE_NOT_FOUND' });
  });

  it('**볼 수 없는 스페이스는 이름으로 찾아지지 않는다** — 있는지도 말하지 않는다', async () => {
    await setup();
    const mallory = await person(db, 'mallory');
    expect(await codeOf(ctrl.create(create({ space: '장애 보고', title: 't', body: 'b' }), md, mallory, req))).toMatchObject({ status: 404, code: 'SPACE_NOT_FOUND' });
  });

  it('남의 스페이스의 id로 부르면 스페이스를 찾을 수 없다(404) — 권한은 사람의 것이다', async () => {
    const { space } = await setup();
    const mallory = await person(db, 'mallory');
    await expect(ctrl.create(create({ space: space.id, title: 't', body: 'b' }), md, mallory, req)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('읽기만 하는 사람(viewer)은 쓰지 못한다(403)', async () => {
    const { owner, space } = await setup();
    const bob = await person(db, 'bob');
    await spacesSvc.addMember(space.id, { username: 'bob', role: 'viewer' }, owner);
    await expect(ctrl.create(create({ space: '장애 보고', title: 't', body: 'b' }), md, bob, req)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('읽기 — 마크다운이 기본 (FR-2215)', () => {
  it('기본은 마크다운, `format`으로 json·text', async () => {
    const { owner, mk } = await setup();
    const p = await ctrl.create(create({ space: '장애 보고', title: '형식', body: '**굵게** 글' }), md, owner, req);
    expect(await ctrl.get(p.id, md, owner)).toMatchObject({ format: 'markdown', body: '**굵게** 글' });
    const json = await ctrl.get(p.id, v1PageQuery.parse({ format: 'json' }), owner);
    expect(json.format).toBe('json');
    expect((json.body as { type: string }).type).toBe('doc');
    const text = await ctrl.get(p.id, v1PageQuery.parse({ format: 'text' }), owner);
    expect(text).toMatchObject({ format: 'text', body: expect.stringContaining('굵게') });
    await mk('다른');
  });

  it('없는 페이지·볼 수 없는 페이지는 404', async () => {
    const { mk } = await setup();
    const p = await mk('x');
    const mallory = await person(db, 'mallory');
    await expect(ctrl.get(p.id, md, mallory)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.get('00000000-0000-4000-8000-000000000000', md, mallory)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('목록은 스페이스의 트리를 이름이나 id로 준다 — 본문 없이', async () => {
    const { owner, space, mk } = await setup();
    const a = await mk('A');
    await mk('B', a.id);
    const byName = await ctrl.list('장애 보고', undefined, owner);
    expect(byName.space).toMatchObject({ id: space.id, name: '장애 보고' });
    expect(byName.items.map((p) => [p.title, p.parentId])).toEqual([
      ['A', null],
      ['B', a.id],
    ]);
    expect(byName.items[0]).not.toHaveProperty('body');
  });

  it('목록은 limit로 자른다', async () => {
    const { owner, space, mk } = await setup();
    await mk('1');
    await mk('2');
    await mk('3');
    expect((await ctrl.list(space.id, 2, owner)).items).toHaveLength(2);
  });
});

describe('고치기 — 고칠 것만 (FR-2223)', () => {
  it('본문만 주면 제목은 그대로고, 기준 버전은 서버가 지금 버전을 쓴다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('제목 유지');
    const v2 = await ctrl.update(p.id, v1UpdatePageDto.parse({ body: '새 본문' }), md, owner, req);
    expect(v2).toMatchObject({ title: '제목 유지', currentVersionNo: 2, body: '새 본문' });
    expect((await rows('page.update'))[0]).toMatchObject({ targetId: p.id, ip: '10.0.0.17', detail: { versionNo: 2 } });
  });

  it('제목만 주면 본문은 그대로다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('옛 제목');
    const v2 = await ctrl.update(p.id, v1UpdatePageDto.parse({ title: '새 제목' }), md, owner, req);
    expect(v2).toMatchObject({ title: '새 제목', body: '옛 제목 본문', currentVersionNo: 2 });
  });

  it('**기준 버전을 주면 지킨다** — 어긋나면 409(VERSION_CONFLICT가 될 응답에 지금 버전)', async () => {
    const { owner, mk } = await setup();
    const p = await mk('충돌');
    await ctrl.update(p.id, v1UpdatePageDto.parse({ body: '둘째' }), md, owner, req);
    const r = await codeOf(ctrl.update(p.id, v1UpdatePageDto.parse({ body: '셋째', baseVersionNo: 1 }), md, owner, req));
    expect(r.status).toBe(409);
    expect(r.body.currentVersionNo).toBe(2);
  });

  it('**사람이 실시간으로 편집 중이면 409 PAGE_BEING_EDITED — 아무것도 쓰지 않는다** (G2)', async () => {
    const { owner, mk } = await setup();
    const p = await mk('편집 중');
    live.hasLiveEditors.mockReturnValue(true);
    expect(await codeOf(ctrl.update(p.id, v1UpdatePageDto.parse({ body: '덮어쓰기' }), md, owner, req))).toMatchObject({ status: 409, code: 'PAGE_BEING_EDITED' });
    const [row] = await db.select().from(pages).where(eq(pages.id, p.id));
    expect(row!.currentVersionNo).toBe(1);
    expect(await rows('page.update')).toHaveLength(0);
    expect(live.hasLiveEditors).toHaveBeenCalledWith(p.id);
  });

  it('**쓸 수 없는 사람에게는 편집 중이라는 사실보다 403이 먼저다**', async () => {
    const { owner, space, mk } = await setup();
    const p = await mk('x');
    const bob = await person(db, 'bob');
    await spacesSvc.addMember(space.id, { username: 'bob', role: 'viewer' }, owner);
    live.hasLiveEditors.mockReturnValue(true);
    await expect(ctrl.update(p.id, v1UpdatePageDto.parse({ body: 'y' }), md, bob, req)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('멘션 메일은 화면용과 같은 길로 간다 (커밋 뒤, 일으킨 사람 이름과 함께)', async () => {
    const { owner, space, mk } = await setup();
    await person(db, 'bob', 'member', { email: 'bob@example.internal' });
    await spacesSvc.addMember(space.id, { username: 'bob', role: 'editor' }, owner);
    const p = await mk('부르기');
    await ctrl.update(p.id, v1UpdatePageDto.parse({ body: '@bob 봐 주세요' }), md, owner, req);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('옮기기·지우기', () => {
  it('위치를 안 주면 맨 끝으로 옮긴다', async () => {
    const { owner, mk } = await setup();
    const a = await mk('A');
    const b = await mk('B');
    const c = await mk('C');
    const moved = await ctrl.move(a.id, v1MovePageDto.parse({ parentId: null }), owner, req);
    expect(moved.id).toBe(a.id);
    const list = await ctrl.list(a.id, undefined, owner).then((l) => l.items.map((p) => p.title));
    expect(list).toEqual(['B', 'C', 'A']);
    void b;
    void c;
  });

  it('부모를 바꾸면 조상이 바뀐다', async () => {
    const { owner, mk } = await setup();
    const a = await mk('A');
    const b = await mk('B');
    await ctrl.move(b.id, v1MovePageDto.parse({ parentId: a.id }), owner, req);
    expect((await ctrl.get(b.id, md, owner)).ancestors).toEqual([{ id: a.id, title: 'A' }]);
    expect((await rows('page.move'))[0]).toMatchObject({ targetId: b.id });
  });

  it('지우면 휴지통으로 가고 더는 읽히지 않는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('지울 글');
    await expect(ctrl.remove(p.id, owner, req)).resolves.toEqual({ ok: true });
    await expect(ctrl.get(p.id, md, owner)).rejects.toBeInstanceOf(NotFoundException);
    expect((await rows('page.delete'))[0]).toMatchObject({ detail: { title: '지울 글' } });
  });
});

describe('이력·되돌리기', () => {
  it('이력 목록과 옛 버전 읽기(형식 선택)', async () => {
    const { owner, mk } = await setup();
    const p = await mk('이력');
    await ctrl.update(p.id, v1UpdatePageDto.parse({ body: '둘째 본문' }), md, owner, req);
    const list = await ctrl.versions(p.id, owner);
    expect(list.map((v) => v.versionNo)).toEqual(expect.arrayContaining([1, 2]));
    expect(await ctrl.version(p.id, 1, md, owner)).toMatchObject({ versionNo: 1, format: 'markdown', body: '이력 본문' });
  });

  it('되돌리면 새 버전이 생긴다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('되돌리기');
    await ctrl.update(p.id, v1UpdatePageDto.parse({ body: '바뀜' }), md, owner, req);
    const back = await ctrl.restore(p.id, 1, md, owner, req);
    expect(back).toMatchObject({ currentVersionNo: 3, body: '되돌리기 본문' });
  });

  it('**편집 중이면 되돌리기도 409 PAGE_BEING_EDITED** — 방의 상태를 덮어쓰지 않는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('x');
    live.hasLiveEditors.mockReturnValue(true);
    expect(await codeOf(ctrl.restore(p.id, 1, md, owner, req))).toMatchObject({ status: 409, code: 'PAGE_BEING_EDITED' });
    expect(await rows('page.version.restore')).toHaveLength(0);
  });

  it('편집 중이라는 이유로 읽기가 막히지는 않는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('x');
    live.hasLiveEditors.mockReturnValue(true);
    await expect(ctrl.get(p.id, md, owner)).resolves.toMatchObject({ id: p.id });
    await expect(ctrl.versions(p.id, owner)).resolves.toHaveLength(1);
    void ConflictException;
  });
});
