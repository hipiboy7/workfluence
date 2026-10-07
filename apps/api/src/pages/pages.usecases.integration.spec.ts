import { DOCUMENT_SCHEMA_VERSION, type DocNode } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service';
import { InAppChannel, NotificationsService } from '../notifications/notifications.service';
import { auditEvents, pages } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { PagesService } from './pages.service';
import { PageUseCases } from './pages.usecases';

/**
 * 페이지의 유스케이스 (P2_설계서_Page 3절 — 쓰기는 감사와 같은 트랜잭션 · FR-754 멘션 메일은 커밋 뒤 · P13 D.7 실시간 제목·저장의 감사 ·
 * docs/spinoff/public-api 계획서 7.1절). B등급 — 실제 PostgreSQL. 판정·잠금·트리의 세부는 `spaces.integration.spec.ts`와 게이트웨이 시험이 본다.
 * 실시간 방과 메일은 대역이다(2절 인터페이스)
 */

let db: TestDb;
let spacesSvc: SpacesService;
let uc: PageUseCases;
const META = { ip: '10.0.0.16' };
const notify = vi.fn();
const collab = { setTitle: vi.fn(), flush: vi.fn() };
const rows = (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const doc = (text: string) =>
  ({ type: 'doc', schemaVersion: DOCUMENT_SCHEMA_VERSION, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) as DocNode;

beforeAll(async () => {
  ({ db } = await openTestDb());
  spacesSvc = new SpacesService(db);
  const pagesSvc = new PagesService(db, spacesSvc, new NotificationsService(db, new InAppChannel()));
  uc = new PageUseCases(pagesSvc, new AuditService(db), collab as never, { notify } as never, spacesSvc, db);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  notify.mockReset();
  collab.setTitle.mockReset();
  collab.flush.mockReset();
});

const setup = async () => {
  const owner = await person(db, 'owner');
  const sp = await spacesSvc.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, owner);
  const mk = (title: string, parentId: string | null = null) => uc.create({ spaceId: sp.id, parentId, title, content: doc(title) }, owner, META);
  return { owner, spaceId: sp.id, mk };
};

describe('페이지 만들기·고치기', () => {
  it('만들면 감사에 스페이스·제목·IP가 남는다', async () => {
    const { owner, spaceId, mk } = await setup();
    const p = await mk('첫 글');
    expect(p).toMatchObject({ title: '첫 글', spaceId, currentVersionNo: 1 });
    expect((await rows('page.create'))[0]).toMatchObject({ actorId: owner.id, targetType: 'page', targetId: p.id, ip: META.ip, detail: { spaceId, title: '첫 글' } });
  });

  it('고치면 새 버전 번호가 감사에 남고, 기준 버전이 어긋나면 409이며 감사가 남지 않는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('글');
    const v2 = await uc.update(p.id, { title: '글2', content: doc('바뀜'), baseVersionNo: 1 }, owner, META);
    expect(v2.currentVersionNo).toBe(2);
    expect((await rows('page.update'))[0]).toMatchObject({ targetId: p.id, ip: META.ip, detail: { versionNo: 2 } });

    await expect(uc.update(p.id, { title: '또', content: doc('또'), baseVersionNo: 1 }, owner, META)).rejects.toMatchObject({ status: 409 });
    expect(await rows('page.update')).toHaveLength(1);
  });

  it('권한이 없으면 막히고 감사가 남지 않는다', async () => {
    const { mk, spaceId } = await setup();
    const mallory = await person(db, 'mallory');
    const p = await mk('글');
    await expect(uc.update(p.id, { title: 'x', content: doc('x'), baseVersionNo: 1 }, mallory, META)).rejects.toThrow();
    await expect(uc.create({ spaceId, parentId: null, title: 'x', content: doc('x') }, mallory, META)).rejects.toThrow();
    expect(await rows('page.update')).toHaveLength(0);
    expect(await rows('page.create')).toHaveLength(1);
  });
});

describe('멘션 메일은 커밋 뒤에 보낸다 (FR-754)', () => {
  it('저장에서 불린 사람이 있으면 일으킨 사람·페이지 제목과 함께 메일을 부르고, 없으면 부르지 않는다', async () => {
    const { owner, spaceId, mk } = await setup();
    await person(db, 'bob', 'member', { email: 'bob@example.internal' });
    await spacesSvc.addMember(spaceId, { username: 'bob', role: 'editor' }, owner);
    const p = await mk('조용한 글');
    expect(notify).not.toHaveBeenCalled();

    await uc.update(p.id, { title: '부르는 글', content: doc('안녕 @bob'), baseVersionNo: 1 }, owner, META);
    expect(notify).toHaveBeenCalledTimes(1);
    const [outcome, actorName, title, actorId] = notify.mock.calls[0]!;
    expect(outcome.recipients.map((r: { email: string }) => r.email)).toEqual(['bob@example.internal']);
    expect([actorName, title, actorId]).toEqual([owner.displayName, '부르는 글', owner.id]);
  });

  it('새 페이지에서 불러도 메일이 간다 (P8 자체 점검 6)', async () => {
    const { owner, spaceId } = await setup();
    await person(db, 'bob', 'member', { email: 'bob@example.internal' });
    await spacesSvc.addMember(spaceId, { username: 'bob', role: 'editor' }, owner);
    await uc.create({ spaceId, parentId: null, title: '새 글', content: doc('@bob 봐 주세요') }, owner, META);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('저장이 실패하면(기준 버전 불일치) 메일은 가지 않는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('글');
    await expect(uc.update(p.id, { title: 'x', content: doc('@bob'), baseVersionNo: 9 }, owner, META)).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('옮기기·지우기·되돌리기', () => {
  it('옮기면 어디서 어디로가 감사에 남는다', async () => {
    const { owner, mk } = await setup();
    const a = await mk('A');
    const b = await mk('B');
    const { page } = await uc.move(b.id, { parentId: a.id, position: 99 }, owner, META);
    expect(page.id).toBe(b.id);
    const [row] = await rows('page.move');
    expect(row).toMatchObject({ targetId: b.id, ip: META.ip });
    expect(row!.detail).toMatchObject({ from: { parentId: null }, to: { parentId: a.id, index: 0 } });
  });

  it('지우면 휴지통으로 가고 지우기 전의 제목이 감사에 남는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('지울 글');
    await expect(uc.remove(p.id, owner, META)).resolves.toEqual({ ok: true });
    expect((await rows('page.delete'))[0]).toMatchObject({ targetId: p.id, ip: META.ip, detail: { title: '지울 글' } });
    const [row] = await db.select().from(pages).where(eq(pages.id, p.id));
    expect(row!.deletedAt).not.toBeNull();
  });

  it('옛 버전으로 되돌리면 새 버전이 생기고 감사에 어느 버전에서 어디로가 남는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('글');
    await uc.update(p.id, { title: '글2', content: doc('둘째'), baseVersionNo: 1 }, owner, META);
    const back = await uc.restoreVersion(p.id, 1, owner, META);
    expect(back.currentVersionNo).toBe(3);
    expect((await rows('page.version.restore'))[0]).toMatchObject({ targetId: p.id, ip: META.ip, detail: { from: 1, to: 3 } });
  });
});

describe('실시간 편집의 제목·저장', () => {
  it('제목: 쓰기 권한이 없으면 방을 건드리지 않고, 반영됐을 때만 감사가 남는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('글');
    const mallory = await person(db, 'mallory');
    await expect(uc.collabTitle(p.id, '몰래', mallory)).rejects.toThrow();
    expect(collab.setTitle).not.toHaveBeenCalled();

    collab.setTitle.mockResolvedValueOnce(false);
    await expect(uc.collabTitle(p.id, '꺼짐', owner)).resolves.toEqual({ applied: false });
    expect(await rows('page.collab.title')).toHaveLength(0);

    collab.setTitle.mockResolvedValueOnce(true);
    await expect(uc.collabTitle(p.id, '새 제목', owner)).resolves.toEqual({ applied: true });
    expect(collab.setTitle).toHaveBeenLastCalledWith(p.id, '새 제목', owner.id);
    expect((await rows('page.collab.title'))[0]).toMatchObject({ actorId: owner.id, targetId: p.id, detail: { title: '새 제목' } });
  });

  it('저장: 권한이 없으면 방을 건드리지 않고, 누른 사람·결과·준 제목이 감사에 남으며 스냅숏은 바이트로 풀어 넘긴다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('글');
    const mallory = await person(db, 'mallory');
    await expect(uc.flush(p.id, { title: 'x' }, mallory)).rejects.toThrow();
    expect(collab.flush).not.toHaveBeenCalled();

    collab.flush.mockResolvedValueOnce({ saved: true, reason: 'ok' });
    const out = await uc.flush(p.id, { title: '제목', snapshot: Buffer.from([1, 2, 3]).toString('base64') }, owner);
    expect(out).toEqual({ saved: true, reason: 'ok', unchanged: false, currentVersionNo: 1 });
    const [, title, snap] = collab.flush.mock.calls[0]!;
    expect(title).toBe('제목');
    expect(Array.from(snap as Uint8Array)).toEqual([1, 2, 3]);
    expect((await rows('page.collab.flush'))[0]).toMatchObject({ actorId: owner.id, targetId: p.id, detail: { saved: true, unchanged: false, reason: 'ok', titleGiven: '제목' } });

    collab.flush.mockResolvedValueOnce({ saved: true, reason: 'ok', unchanged: true });
    expect((await uc.flush(p.id, {}, owner)).unchanged).toBe(true);
    expect((await rows('page.collab.flush'))[1]!.detail).toMatchObject({ unchanged: true, titleGiven: null });
  });
});

describe('HTML 내보내기', () => {
  it('내보내면 파일을 돌려주고 감사에 버전 번호와 IP가 남는다', async () => {
    const { owner, mk } = await setup();
    const p = await mk('글');
    const out = await uc.exportHtml(p.id, undefined, owner, META);
    expect(out.html).toContain('<');
    expect(out.versionNo).toBe(1);
    expect((await rows('page.export'))[0]).toMatchObject({ actorId: owner.id, targetId: p.id, ip: META.ip, detail: { versionNo: 1 } });
  });
});
