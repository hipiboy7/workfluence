import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v1SearchQuery } from '@workfluence/shared';
import { pages } from '../db/schema';
import { SearchService } from '../search/search.service';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { V1SearchController } from './v1-search.controller';

/**
 * 공개 API v1의 검색 (docs/spinoff/public-api 설계서 3.5절 · FR-2223). B등급 — 실제 PostgreSQL. 에이전트가 정하는 것은 검색어뿐이고, 스페이스로 좁히는 것은
 * **이름으로도** 된다. 권한 거름(볼 수 없는 스페이스·휴지통)은 검색 서비스 한 곳이 한다 — 여기서는 연결을 본다.
 */

let db: TestDb;
let spacesSvc: SpacesService;
let ctrl: V1SearchController;

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  ctrl = new V1SearchController(new SearchService(db), spacesSvc);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

const addPage = (spaceId: string, uid: string, title: string, text: string, over: Partial<typeof pages.$inferInsert> = {}) =>
  db.insert(pages).values({ spaceId, parentId: null, title, position: 0, currentVersionNo: 1, searchText: text, createdBy: uid, updatedBy: uid, ...over });
const query = (q: Record<string, unknown>) => v1SearchQuery.parse(q);
const team = (me: Awaited<ReturnType<typeof person>>, name: string) => spacesSvc.create({ name, kind: 'team', categoryId: null, description: '' }, me);

describe('검색', () => {
  it('검색어만 주면 내가 읽을 수 있는 모든 스페이스에서 찾는다 — 한글 두 글자도', async () => {
    const me = await person(db, 'me');
    const a = await team(me, '장애 보고');
    const b = await team(me, '인사 규정');
    await addPage(a.id, me.id, '10/7 장애', '로그인 지연이 있었다');
    await addPage(b.id, me.id, '휴가 규정', '지연 사유서를 낸다');
    await addPage(b.id, me.id, '무관', '전혀 다른 내용');
    const r = await ctrl.find(query({ q: '지연' }), me);
    expect(r.items.map((h) => h.title).sort()).toEqual(['10/7 장애', '휴가 규정']);
    expect(r.items[0]).toMatchObject({ spaceName: expect.any(String), snippet: expect.stringContaining('지연') });
  });

  it('**스페이스를 이름으로 좁힌다**(id로도)', async () => {
    const me = await person(db, 'me');
    const a = await team(me, '장애 보고');
    const b = await team(me, '인사 규정');
    await addPage(a.id, me.id, 'TA', '검색 대상');
    await addPage(b.id, me.id, 'TB', '검색 대상');
    expect((await ctrl.find(query({ q: '검색', space: '장애 보고' }), me)).items.map((h) => h.title)).toEqual(['TA']);
    expect((await ctrl.find(query({ q: '검색', space: b.id }), me)).items.map((h) => h.title)).toEqual(['TB']);
  });

  it('없는 스페이스 이름은 404 SPACE_NOT_FOUND — 빈 결과로 얼버무리지 않는다', async () => {
    const me = await person(db, 'me');
    await team(me, '장애 보고');
    const e = await ctrl.find(query({ q: 'x', space: '없는 곳' }), me).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(404);
    expect(((e as HttpException).getResponse() as { code: string }).code).toBe('SPACE_NOT_FOUND');
  });

  it('**볼 수 없는 스페이스의 페이지는 결과에 없다** — 이름으로 좁혀도 마찬가지다', async () => {
    const owner = await person(db, 'owner');
    const mallory = await person(db, 'mallory');
    const s = await team(owner, '비공개');
    await addPage(s.id, owner.id, '비밀 문서', '검색 대상');
    expect((await ctrl.find(query({ q: '검색' }), mallory)).items).toEqual([]);
    const e = await ctrl.find(query({ q: '검색', space: '비공개' }), mallory).catch((x: unknown) => x);
    expect((e as HttpException).getStatus()).toBe(404);
  });

  it('휴지통의 페이지는 나오지 않고, limit로 자른다', async () => {
    const me = await person(db, 'me');
    const s = await team(me, '팀');
    await addPage(s.id, me.id, '살아 있음', '검색 대상');
    await addPage(s.id, me.id, '지움', '검색 대상', { deletedAt: new Date() });
    expect((await ctrl.find(query({ q: '검색' }), me)).items.map((h) => h.title)).toEqual(['살아 있음']);
    for (let i = 0; i < 3; i++) await addPage(s.id, me.id, `P${i}`, '검색 대상');
    expect((await ctrl.find(query({ q: '검색', limit: '2' }), me)).items).toHaveLength(2);
  });

  it('`%`·`_` 한 글자가 전부를 돌려주지 않는다 (P3 자체 점검 12)', async () => {
    const me = await person(db, 'me');
    const s = await team(me, '팀');
    await addPage(s.id, me.id, 'A', '일반 글');
    expect((await ctrl.find(query({ q: '%' }), me)).items).toEqual([]);
  });
});
