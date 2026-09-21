import type { Principal } from '@workfluence/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pages, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { LabelsService } from './labels.service';

/** B등급 (P4_설계서_Admin E절). 실제 PostgreSQL. 보류 10을 닫는 자리다 */

let db: TestDb;
let spacesSvc: SpacesService;
let svc: LabelsService;

async function user(username: string, role: 'root' | 'admin' | 'member' = 'member'): Promise<Principal> {
  const [u] = await db.insert(users).values({ username, displayName: username, passwordHash: 'x', role, status: 'active' }).returning();
  return { id: u.id, role };
}
async function page(spaceId: string, uid: string, title = 'T'): Promise<string> {
  const [p] = await db
    .insert(pages)
    .values({ spaceId, parentId: null, title, position: 0, currentVersionNo: 1, searchText: '', createdBy: uid, updatedBy: uid })
    .returning();
  return p.id;
}
const team = (me: Principal) => spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  svc = new LabelsService(db, spacesSvc);
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('붙이기·떼기 (FR-533)', () => {
  it('붙이면 목록에 나온다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const l = await svc.attach(pid, '회의록', me);
    expect(await svc.forPage(pid, me)).toEqual([{ id: l.id, name: '회의록' }]);
  });

  it('이름은 유일하다 — 같은 이름을 다른 페이지에 붙여도 라벨은 하나다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const a = await page(sp.id, me.id, 'A');
    const b = await page(sp.id, me.id, 'B');
    const la = await svc.attach(a, '분기', me);
    const lb = await svc.attach(b, '분기', me);
    expect(la.id).toBe(lb.id);
    expect(await svc.all(50)).toHaveLength(1);
  });

  it('대소문자·공백을 정규화한다 — `회의록 `과 `회의록`이 다른 라벨이 되면 안 된다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const a = await svc.attach(pid, ' Report ', me);
    const b = await svc.attach(pid, 'report', me);
    expect(a.id).toBe(b.id);
    expect(a.name).toBe('report');
  });

  it('두 번 붙여도 오류가 아니다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    await svc.attach(pid, '중복', me);
    await expect(svc.attach(pid, '중복', me)).resolves.toBeTruthy();
    expect(await svc.forPage(pid, me)).toHaveLength(1);
  });

  it('**쓰는 곳이 없어지면 라벨 자체를 지운다** — 자동완성 목록이 쓰레기로 차지 않게', async () => {
    const me = await user('me');
    const sp = await team(me);
    const pid = await page(sp.id, me.id);
    const l = await svc.attach(pid, '한번만', me);
    await svc.detach(pid, l.id, me);
    expect(await svc.all(50)).toHaveLength(0);
  });

  it('다른 페이지가 아직 쓰고 있으면 남긴다', async () => {
    const me = await user('me');
    const sp = await team(me);
    const a = await page(sp.id, me.id, 'A');
    const b = await page(sp.id, me.id, 'B');
    const l = await svc.attach(a, '공용', me);
    await svc.attach(b, '공용', me);
    await svc.detach(a, l.id, me);
    expect(await svc.all(50)).toHaveLength(1);
    expect(await svc.forPage(b, me)).toHaveLength(1);
  });
});

describe('권한 (FR-535)', () => {
  it('볼 수 없는 페이지의 라벨은 없는 것이다', async () => {
    const owner = await user('owner');
    const other = await user('other');
    const sp = await team(owner);
    const pid = await page(sp.id, owner.id);
    await svc.attach(pid, '비밀', owner);
    await expect(svc.forPage(pid, other)).rejects.toThrow(/찾을 수 없다/);
  });

  it('viewer는 읽지만 붙이지 못한다', async () => {
    const owner = await user('owner');
    const viewer = await user('viewer');
    const sp = await team(owner);
    await spacesSvc.addMember(sp.id, { username: 'viewer', role: 'viewer' }, owner);
    const pid = await page(sp.id, owner.id);
    const l = await svc.attach(pid, '읽기', owner);
    expect(await svc.forPage(pid, viewer)).toHaveLength(1);
    await expect(svc.attach(pid, '쓰기', viewer)).rejects.toThrow(/쓸 권한/);
    await expect(svc.detach(pid, l.id, viewer)).rejects.toThrow(/쓸 권한/);
  });
});

describe('라벨로 찾기 (FR-534)', () => {
  it('붙은 페이지를 찾는다. **볼 수 없는 것은 결과에 없다**', async () => {
    const owner = await user('owner');
    const other = await user('other');
    const mine = await team(owner);
    const theirs = await spacesSvc.create({ name: '남의 팀', kind: 'team', categoryId: null, description: '' }, other);

    const a = await page(mine.id, owner.id, '내 것');
    const b = await page(theirs.id, other.id, '남의 것');
    await svc.attach(a, '분기', owner);
    await svc.attach(b, '분기', other);

    const hits = await svc.findPages('분기', owner, 50);
    expect(hits.map((h) => h.title)).toEqual(['내 것']);
  });

  it('없는 라벨이면 빈 목록', async () => {
    const me = await user('me');
    expect(await svc.findPages('없다', me, 50)).toEqual([]);
  });
});

