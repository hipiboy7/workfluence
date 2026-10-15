// @vitest-environment happy-dom
import { createPageDto, validateDocument, type AuditEventView, type MeView, type NotificationView, type PageDiffView, type PageSummary, type PageVersionView, type PageView, type SearchHit, type SpaceView } from '@workfluence/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { buildSeed } from './seed';
import { demoApi, resetDemo } from './server';
import { DEMO_PASSWORD } from './store';

/** 스마트폰 시연판(F-015)의 폰 안 서버 — 시연 장면이 기대는 동작을 본다 */

const call = <T>(path: string, method = 'GET', json?: unknown) => demoApi<T>(path, { method, json });
const login = (username: string) => call<MeView>('/api/auth/login', 'POST', { username, password: DEMO_PASSWORD });
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof ApiError ? e.status : -1;
  }
}

async function spaceNamed(name: string): Promise<SpaceView> {
  const all = [...(await call<SpaceView[]>('/api/spaces?scope=team')), ...(await call<SpaceView[]>('/api/spaces?scope=personal'))];
  const s = all.find((x) => x.name === name);
  if (!s) throw new Error(`${name} 없음`);
  return s;
}
async function pageNamed(spaceName: string, title: string): Promise<PageSummary> {
  const s = await spaceNamed(spaceName);
  const p = (await call<PageSummary[]>(`/api/pages?spaceId=${s.id}`)).find((x) => x.title === title);
  if (!p) throw new Error(`${title} 없음`);
  return p;
}

beforeEach(() => {
  localStorage.clear();
  resetDemo();
});

describe('시연 데이터', () => {
  it('모든 페이지 버전·댓글·템플릿이 서버의 문서 검증을 통과한다', () => {
    const s = buildSeed(new Date());
    const docs = [...s.pages.flatMap((p) => p.versions.map((v) => v.content)), ...s.comments.map((c) => c.body), ...s.templates.map((t) => t.content)];
    expect(docs.length).toBeGreaterThan(40);
    for (const d of docs) {
      const r = validateDocument(d);
      expect(r.ok ? [] : r.errors).toEqual([]);
      expect(createPageDto.safeParse({ spaceId: s.spaces[0].id, title: 'x', content: d }).success).toBe(true);
    }
  });

  it('트리가 3단계이고 장애 대응 절차에 버전이 5개 있다', async () => {
    await login('kim.ops');
    const p = await pageNamed('IT운영팀', '장애 대응 절차');
    expect(p.currentVersionNo).toBe(5);
    const kids = (await call<PageSummary[]>(`/api/pages?spaceId=${p.spaceId}`)).filter((x) => x.parentId === p.id);
    expect(kids.map((k) => k.title)).toContain('장애 등급 기준');
  });
});

describe('로그인', () => {
  it('시연 계정으로 들어가고 나온다. 틀린 비밀번호는 401이다', async () => {
    expect(await status(call('/api/auth/me'))).toBe(401);
    expect(await status(call('/api/auth/login', 'POST', { username: 'kim.ops', password: 'wrong' }))).toBe(401);
    expect((await login('kim.ops')).displayName).toBe('김운영');
    expect((await call<MeView>('/api/auth/me')).role).toBe('member');
    await call('/api/auth/logout', 'POST');
    expect(await status(call('/api/auth/me'))).toBe(401);
  });

  it('실시간 편집은 꺼져 있다 — 화면이 저장 단추로 버전을 남긴다', async () => {
    expect(await call('/api/auth/config')).toEqual({ oidcEnabled: false, collabEnabled: false, resetMailEnabled: false });
  });
});

describe('권한 (공유 spaceAccess)', () => {
  it('김운영은 세 팀 공간을 보고, 보안은 읽기만 된다', async () => {
    await login('kim.ops');
    const team = await call<SpaceView[]>('/api/spaces?scope=team');
    expect(team.map((s) => s.name).sort()).toEqual(['IT운영팀', 'IT인프라팀', '보안']);
    const sec = team.find((s) => s.name === '보안')!;
    expect(sec.access.canRead).toBe(true);
    expect(sec.access.canWrite).toBe(false);
    const p = await pageNamed('보안', '보안 정책 개요');
    const v = await call<PageView>(`/api/pages/${p.id}`);
    expect(await status(call(`/api/pages/${p.id}`, 'PATCH', { title: 'x', content: v.content, baseVersionNo: v.currentVersionNo }))).toBe(403);
  });

  it('Crew가 아닌 공간은 없는 것처럼 404다', async () => {
    await login('han.sec');
    const infra = buildSeed(new Date()); // 아이디는 시드마다 새로 만든다 — 이름으로 찾는다
    expect(infra).toBeTruthy();
    const team = await call<SpaceView[]>('/api/spaces?scope=team');
    expect(team.map((s) => s.name)).not.toContain('IT인프라팀');
    await call('/api/auth/logout', 'POST');
    await login('kim.ops');
    const s = await spaceNamed('IT인프라팀');
    await call('/api/auth/logout', 'POST');
    await login('han.sec');
    expect(await status(call(`/api/spaces/${s.id}`))).toBe(404);
  });

  it('감사로그는 관리자만 본다', async () => {
    await login('kim.ops');
    expect(await status(call('/api/audit'))).toBe(403);
  });
});

describe('편집·이력', () => {
  it('저장하면 새 버전이 쌓이고, 앞 버전과 비교하면 더한 것이 보이고, 감사로그 맨 위에 남는다', async () => {
    await login('kim.ops');
    const p = await pageNamed('IT운영팀', '장애 대응 절차');
    const v = await call<PageView>(`/api/pages/${p.id}`);
    const content = { ...v.content, content: [...(v.content.content ?? []), { type: 'paragraph', content: [{ type: 'text', text: '점심 시연에서 더한 줄', marks: [{ type: 'bold' }] }] }] };
    const saved = await call<PageView>(`/api/pages/${p.id}`, 'PATCH', { title: v.title, content, baseVersionNo: 5 });
    expect(saved.currentVersionNo).toBe(6);
    expect(saved.content.attrs?.schemaVersion).toBeTypeOf('number');

    // 옛 기준 버전으로 저장하면 409
    expect(await status(call(`/api/pages/${p.id}`, 'PATCH', { title: v.title, content, baseVersionNo: 5 }))).toBe(409);

    const versions = await call<PageVersionView[]>(`/api/pages/${p.id}/versions`);
    expect(versions[0]).toMatchObject({ versionNo: 6, createdByName: '김운영' });
    const diff = await call<PageDiffView>(`/api/pages/${p.id}/versions/5/diff/6`);
    expect(diff.diff.added).toBe(1);
    expect(diff.diff.blocks.some((b) => b.kind === 'added' && b.after?.includes('점심 시연'))).toBe(true);

    await call('/api/auth/logout', 'POST');
    await login('lee.admin');
    const audit = await call<AuditEventView[]>('/api/audit');
    const update = audit.find((e) => e.action === 'page.update');
    expect(update).toMatchObject({ actorName: '김운영', targetId: p.id, detail: { versionNo: 6 } });
    // 맨 위는 방금 한 로그인·로그아웃 — 그 아래 첫 page.update가 방금 저장이다
    expect(audit.findIndex((e) => e.action === 'page.update')).toBeLessThan(4);
  });

  it('되돌리기는 새 버전으로 쌓이고 이력은 지워지지 않는다', async () => {
    await login('kim.ops');
    const p = await pageNamed('IT운영팀', '장애 대응 절차');
    const r = await call<PageView>(`/api/pages/${p.id}/versions/1/restore`, 'POST');
    expect(r.currentVersionNo).toBe(6);
    const v1 = await call<PageView & { content: unknown }>(`/api/pages/${p.id}/versions/1`);
    expect(r.content).toEqual(v1.content);
    expect((await call<PageVersionView[]>(`/api/pages/${p.id}/versions`)).length).toBe(6);
  });

  it('템플릿으로 새 페이지를 만들면 트리에 생긴다', async () => {
    await login('kim.ops');
    const s = await spaceNamed('IT운영팀');
    const t = (await call<{ name: string; content: unknown }[]>('/api/templates')).find((x) => x.name === '회의록')!;
    const created = await call<PageView>('/api/pages', 'POST', { spaceId: s.id, parentId: null, title: '2026-10-16 점심 회의', content: t.content });
    const tree = await call<PageSummary[]>(`/api/pages?spaceId=${s.id}`);
    expect(tree.map((x) => x.id)).toContain(created.id);
  });

  it('옮기기와 휴지통·되살리기', async () => {
    await login('kim.ops');
    const p = await pageNamed('IT운영팀', '야간 당직 안내');
    const moved = await call<PageSummary>(`/api/pages/${p.id}/move`, 'PATCH', { parentId: null, position: 0 });
    expect(moved.parentId).toBeNull();
    const roots = (await call<PageSummary[]>(`/api/pages?spaceId=${p.spaceId}`)).filter((x) => x.parentId === null);
    expect(roots[0].id).toBe(p.id);
    await call(`/api/pages/${p.id}`, 'DELETE');
    expect(await status(call(`/api/pages/${p.id}`))).toBe(404);
    expect((await call<{ id: string }[]>('/api/trash/pages')).map((x) => x.id)).toContain(p.id);
    await call(`/api/trash/pages/${p.id}/restore`, 'POST');
    expect((await call<PageView>(`/api/pages/${p.id}`)).title).toBe('야간 당직 안내');
  });
});

describe('검색·라벨', () => {
  it('"장애"는 본문까지 3건 넘게, 두 글자 "배포"도 찾는다', async () => {
    await login('kim.ops');
    const hits = await call<SearchHit[]>(`/api/search?q=${encodeURIComponent('장애')}`);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.some((h) => !h.title.includes('장애') && h.snippet.includes('장애'))).toBe(true);
    expect((await call<SearchHit[]>(`/api/search?q=${encodeURIComponent('배포')}`)).length).toBeGreaterThanOrEqual(2);
  });

  it('읽지 못하는 공간의 문서는 검색에 나오지 않는다', async () => {
    await login('han.sec');
    expect(await call<SearchHit[]>(`/api/search?q=${encodeURIComponent('백업·복구')}`)).toEqual([]);
  });

  it('라벨을 누르면 같은 라벨의 문서', async () => {
    await login('kim.ops');
    const hits = await call<SearchHit[]>(`/api/labels/${encodeURIComponent('장애')}/pages?limit=200`);
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});

describe('댓글·알림', () => {
  it('처음에는 읽지 않은 멘션 알림이 있고, 누르면 그 페이지다', async () => {
    await login('kim.ops');
    expect((await call<{ count: number }>('/api/notifications/unread-count')).count).toBe(2);
    const list = await call<NotificationView[]>('/api/notifications?limit=5');
    expect(list[0]).toMatchObject({ kind: 'mention', actorName: '최디비', pageTitle: '장애 대응 절차' });
  });

  it('댓글의 @아이디가 그 사람에게 알림을 만든다 — 자기 자신은 빼고', async () => {
    await login('kim.ops');
    const p = await pageNamed('IT운영팀', '장애 대응 절차');
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '@choi.db 반영했습니다. @kim.ops' }] }] };
    const c = await call<{ canDelete: boolean; createdByName: string }>(`/api/pages/${p.id}/comments`, 'POST', { body });
    expect(c).toMatchObject({ canDelete: true, createdByName: '김운영' });
    expect((await call<{ count: number }>('/api/notifications/unread-count')).count).toBe(2);
    await call('/api/auth/logout', 'POST');
    await login('choi.db');
    const n = await call<NotificationView[]>('/api/notifications?limit=5');
    expect(n[0]).toMatchObject({ kind: 'mention', actorName: '김운영', readAt: null });
  });

  it('읽기만 되는 공간에는 댓글을 달지 못한다 — 서버와 같다', async () => {
    await login('kim.ops');
    const p = await pageNamed('보안', '보안 정책 개요');
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '확인했습니다.' }] }] };
    expect(await status(call(`/api/pages/${p.id}/comments`, 'POST', { body }))).toBe(403);
  });
});

describe('그 밖', () => {
  it('시연판에 없는 기능은 이유와 함께 답한다', async () => {
    await login('kim.ops');
    expect(await status(call('/api/auth/change-password', 'POST', {}))).toBe(400);
    expect(await status(call('/api/nothing-here'))).toBe(404);
  });

  it('처음으로 — 고친 것과 로그인이 모두 사라진다', async () => {
    await login('kim.ops');
    const p = await pageNamed('IT운영팀', '장애 대응 절차');
    await call(`/api/pages/${p.id}/versions/1/restore`, 'POST');
    resetDemo();
    expect(await status(call('/api/auth/me'))).toBe(401);
    await login('kim.ops');
    expect((await pageNamed('IT운영팀', '장애 대응 절차')).currentVersionNo).toBe(5);
  });

  it('껐다 켜도 남는다 — 저장소에서 다시 읽는다', async () => {
    await login('kim.ops');
    const raw = localStorage.getItem('wf-demo:state');
    expect(raw && JSON.parse(raw).sessionUserId).toBeTruthy();
  });
});
