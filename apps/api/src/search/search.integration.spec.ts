import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@workfluence/shared';
import { pages, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { SearchService } from './search.module';

/** B등급 통합 테스트 (P3_설계서_Content 5절). 실제 PostgreSQL. */

let db: TestDb;
let spacesSvc: SpacesService;
let search: SearchService;

async function user(username: string, role: 'root' | 'admin' | 'member' = 'member'): Promise<Principal> {
  const [u] = await db.insert(users).values({ username, displayName: username, passwordHash: 'x', role, status: 'active' }).returning();
  return { id: u.id, role };
}
const addPage = (spaceId: string, uid: string, title: string, text: string) =>
  db.insert(pages).values({ spaceId, parentId: null, title, position: 0, currentVersionNo: 1, searchText: text, createdBy: uid, updatedBy: uid });

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  search = new SearchService(db);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('한글 2글자 검색 (인수 기준)', () => {
  it('두 글자로 본문과 제목을 찾는다', async () => {
    const me = await user('me');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);
    await addPage(sp.id, me.id, '분기 보고서', '이번 분기 검색 기능에 대한 내용');
    await addPage(sp.id, me.id, '검색 설계', '설계 문서다');
    await addPage(sp.id, me.id, '관계없음', '전혀 다른 내용');

    const hits = await search.search(me, '검색', 50);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.title).sort()).toEqual(['분기 보고서', '검색 설계'].sort());
  });

  it('결과에 스페이스 이름과 문맥 조각이 있다 (FR-405)', async () => {
    const me = await user('me');
    const sp = await spacesSvc.create({ name: '우리팀', kind: 'team', categoryId: null, description: '' }, me);
    await addPage(sp.id, me.id, 'T', '앞부분 내용이 길게 있고 여기에 검색 이라는 말이 나온다');
    const [hit] = await search.search(me, '검색', 10);
    expect(hit.spaceName).toBe('우리팀');
    expect(hit.snippet).toContain('검색');
  });

  it('스페이스로 좁힐 수 있다 (FR-406)', async () => {
    const me = await user('me');
    const a = await spacesSvc.create({ name: 'A', kind: 'team', categoryId: null, description: '' }, me);
    const b = await spacesSvc.create({ name: 'B', kind: 'team', categoryId: null, description: '' }, me);
    await addPage(a.id, me.id, 'TA', '검색 대상');
    await addPage(b.id, me.id, 'TB', '검색 대상');
    expect(await search.search(me, '검색', 50)).toHaveLength(2);
    expect(await search.search(me, '검색', 50, a.id)).toHaveLength(1);
  });
});

describe('권한 (인수 기준 — 볼 수 없는 스페이스는 결과에 없다)', () => {
  it('Crew가 아닌 팀 스페이스의 페이지는 안 나온다', async () => {
    const owner = await user('owner');
    const outsider = await user('outsider');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await addPage(sp.id, owner.id, '비밀 보고서', '검색 되면 안 된다');

    expect(await search.search(owner, '검색', 50)).toHaveLength(1);
    expect(await search.search(outsider, '검색', 50)).toHaveLength(0);
  });

  it('남의 개인 스페이스도 안 나온다', async () => {
    const me = await user('me');
    const other = await user('other');
    const sp = await spacesSvc.create({ name: '내 공간', kind: 'personal', categoryId: null, description: '' }, me);
    await addPage(sp.id, me.id, '개인 메모', '검색 대상');
    expect(await search.search(other, '검색', 50)).toHaveLength(0);
  });

  it('admin은 모두 본다', async () => {
    const owner = await user('owner');
    const admin = await user('adm', 'admin');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
    await addPage(sp.id, owner.id, 'T', '검색 대상');
    expect(await search.search(admin, '검색', 50)).toHaveLength(1);
  });

  /**
   * **권한을 질의에서 거는 이유** (FR-403). 가져와서 거르면 `limit`이 볼 수 없는 것으로 차서
   * 볼 수 있는 결과가 조용히 빠진다. Phase 2의 스페이스 목록이 그 실수를 했다.
   */
  it('limit이 볼 수 없는 것으로 차지 않는다', async () => {
    const owner = await user('owner');
    const me = await user('me');
    const hidden = await spacesSvc.create({ name: '남의팀', kind: 'team', categoryId: null, description: '' }, owner);
    const mine = await spacesSvc.create({ name: '내팀', kind: 'team', categoryId: null, description: '' }, me);
    for (let i = 0; i < 20; i++) await addPage(hidden.id, owner.id, `숨김${i}`, '검색 대상');
    await addPage(mine.id, me.id, '내 것', '검색 대상');

    const hits = await search.search(me, '검색', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('내 것');
  });
});

describe('삭제된 것은 빠진다 (FR-404)', () => {
  it('삭제된 페이지와 스페이스는 결과에 없다', async () => {
    const me = await user('me');
    const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);
    await addPage(sp.id, me.id, 'T', '검색 대상');
    expect(await search.search(me, '검색', 50)).toHaveLength(1);

    await spacesSvc.softDelete(sp.id, me);
    expect(await search.search(me, '검색', 50)).toHaveLength(0);
  });
});
