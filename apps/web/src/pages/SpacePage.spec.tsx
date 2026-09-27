// @vitest-environment happy-dom
import type { MeView, PageSummary, SpaceMemberView, SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { SpacePage } from './SpacePage';

/**
 * 컴포넌트 시험 — 스페이스 화면 (P14_설계서_Spaces D.2·D.3, FR-1500·1512). 트리는 목록 안의 목록으로 들여쓰고, 새 페이지의 **위치**를 고르며, 페이지
 * 보기의 하위 페이지 만들기(`?parent=`)로 오면 그 부모를 골라 둔다. Crew에 넣을 때 역할을 고르고 넣은 뒤 바꾼다. 서버는 가짜 `fetch`다 — Crew를 바꾸면
 * 화면이 스페이스를 다시 읽는다(그때 무엇이 남는지가 병합 전 검토의 쟁점이었다)
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let members: SpaceMemberView[];
let spaceGets = 0;
// 스페이스 읽기의 n번째 응답 — 늦게 오는 응답을 흉내 낸다
let answerSpace: (n: number) => Promise<Response>;
// 트리 읽기의 응답 — 그 사이 지워진 페이지를 흉내 낸다
let answerTree: () => PageSummary[];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const me: MeView = { id: 'u1', username: 'owner', displayName: '주인', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
const space: SpaceView = {
  id: 's1',
  key: 'ABCD',
  name: '운영팀',
  description: '',
  kind: 'team',
  status: 'active',
  categoryId: null,
  categoryName: null,
  createdBy: 'u1',
  createdByUsername: 'owner',
  memberCount: 2,
  myRole: 'owner',
  access: { canRead: true, canWrite: true, canManageMembers: true, canChangeStatus: true, canDelete: false, isOwner: true },
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};
const page = (id: string, title: string, parentId: string | null, position: number): PageSummary => ({
  id,
  spaceId: 's1',
  parentId,
  title,
  position,
  currentVersionNo: 1,
  updatedAt: '2026-09-27T00:00:00.000Z',
});
const tree = [page('p1', '회의록', null, 0), page('p2', '규정', null, 1), page('p11', '9월 회의', 'p1', 0)];
const crew: SpaceMemberView[] = [
  { userId: 'u1', username: 'owner', displayName: '주인', role: 'owner', createdAt: '2026-09-27T00:00:00.000Z' },
  { userId: 'u2', username: 'kim', displayName: '김', role: 'editor', createdAt: '2026-09-27T00:00:00.000Z' },
];

beforeEach(() => {
  calls = [];
  members = crew;
  spaceGets = 0;
  answerSpace = () => Promise.resolve(json(200, space));
  answerTree = () => tree;
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/spaces/s1') return answerSpace(++spaceGets);
    if (url === '/api/pages?spaceId=s1') return Promise.resolve(json(200, answerTree()));
    if (url === '/api/spaces/s1/members' && method === 'GET') return Promise.resolve(json(200, members));
    if (url.startsWith('/api/spaces/s1/members/') && method === 'PATCH') {
      const userId = url.split('/').at(-1);
      members = members.map((m) => (m.userId === userId ? { ...m, role: (body as { role: SpaceMemberView['role'] }).role } : m));
      return Promise.resolve(json(200, {}));
    }
    if (url === '/api/templates' || url === '/api/categories') return Promise.resolve(json(200, []));
    if (url === '/api/pages' && method === 'POST') return Promise.resolve(json(201, page('new', '새 문서', 'p1', 1)));
    return Promise.resolve(json(200, {}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider>
        <Routes>
          <Route path="/spaces/:id" element={<SpacePage />} />
          <Route path="/pages/:id/edit" element={<p>편집 화면</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
const writes = () => calls.filter((c) => c.method !== 'GET');
const where = () => (screen.getByLabelText('위치') as HTMLSelectElement).value;
/** 목록의 바로 아래 줄들 — [이름, 들여쓰기] */
const lines = (list: HTMLElement) => [...list.children].map((li) => [li.querySelector('a')?.textContent, (li as HTMLElement).style.marginLeft]);
/** Crew를 바꾼다 — 화면이 스페이스를 다시 읽는다. 다시 읽은 것이 그려질 때까지 기다린다 */
async function reloadByCrew() {
  const before = spaceGets;
  fireEvent.change(screen.getByLabelText('kim 역할'), { target: { value: 'viewer' } });
  await waitFor(() => expect((screen.getByLabelText('kim 역할') as HTMLSelectElement).value).toBe('viewer'));
  expect(spaceGets).toBe(before + 1);
  // 다시 그린 뒤의 효과(`?parent=` 고르기)까지 돈다
  await new Promise((r) => setTimeout(r, 30));
}

describe('SpacePage — 트리와 하위 페이지', () => {
  it('**트리는 목록 안의 목록이다** — 자식은 부모 줄 안의 목록에 들여쓴다(화면 낭독기가 단계를 읽는다)', async () => {
    renderAt('/spaces/s1');
    const list = await screen.findByRole('list', { name: '페이지 트리' });
    await within(list).findByRole('link', { name: '9월 회의' });
    expect(lines(list)).toEqual([
      ['회의록', '0px'],
      ['규정', '0px'],
    ]);
    const inner = within(list.children[0] as HTMLElement).getByRole('list');
    expect(lines(inner)).toEqual([['9월 회의', '16px']]);
    // 안쪽 목록은 브라우저의 기본 들여쓰기(40px)를 없앤다 — 단계마다 16px만 (반영분 점검 3)
    expect(inner.style.paddingLeft).toBe('0px');
  });

  it('**위치를 고르면 그 아래에 만든다** — 기본은 맨 위', async () => {
    renderAt('/spaces/s1');
    await screen.findByLabelText('위치');
    expect(where()).toBe('');
    fireEvent.change(screen.getByLabelText('새 페이지 제목'), { target: { value: '새 문서' } });
    fireEvent.change(screen.getByLabelText('위치'), { target: { value: 'p11' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('편집 화면');
    expect(writes()[0]).toMatchObject({ method: 'POST', url: '/api/pages', body: { spaceId: 's1', parentId: 'p11', title: '새 문서' } });
  });

  it('**하위 페이지 만들기로 오면(`?parent=`) 그 부모를 골라 두고 제목 칸으로 간다** (FR-1500)', async () => {
    renderAt('/spaces/s1?parent=p1');
    const box = await screen.findByLabelText('새 페이지 제목');
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(where()).toBe('p1');
    fireEvent.change(box, { target: { value: '10월 회의' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('편집 화면');
    expect(writes()[0].body).toMatchObject({ parentId: 'p1', title: '10월 회의' });
  });

  it('**`?parent=`가 이 스페이스의 트리에 없으면 맨 위** — 칸이 보이는 것과 보내는 것이 같다(지워졌거나 다른 스페이스의 페이지)', async () => {
    renderAt('/spaces/s1?parent=elsewhere');
    const box = await screen.findByLabelText('새 페이지 제목');
    expect(where()).toBe('');
    expect(document.activeElement).not.toBe(box);
    fireEvent.change(box, { target: { value: '새 문서' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('편집 화면');
    expect(writes()[0].body).toMatchObject({ parentId: null });
  });
});

describe('SpacePage — 다시 읽을 때 (Crew를 바꾼 뒤)', () => {
  it('**고른 위치를 되돌리지 않는다** — `?parent=`는 그 값으로 온 때 한 번만 고른다', async () => {
    renderAt('/spaces/s1?parent=p1');
    await screen.findByLabelText('kim 역할');
    await waitFor(() => expect(where()).toBe('p1'));
    fireEvent.change(screen.getByLabelText('위치'), { target: { value: 'p2' } });
    await reloadByCrew();
    expect(where()).toBe('p2');
  });

  it('**고른 부모가 다시 읽은 트리에 없으면 맨 위로 보이고 맨 위로 보낸다** — 그 사이 누가 지웠다', async () => {
    renderAt('/spaces/s1');
    await screen.findByLabelText('kim 역할');
    fireEvent.change(screen.getByLabelText('위치'), { target: { value: 'p11' } });
    answerTree = () => tree.filter((p) => p.id !== 'p11');
    await reloadByCrew();
    expect(screen.queryByRole('link', { name: '9월 회의' })).toBeNull();
    expect(where()).toBe('');
    fireEvent.change(screen.getByLabelText('새 페이지 제목'), { target: { value: '새 문서' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('편집 화면');
    expect(writes().at(-1)).toMatchObject({ url: '/api/pages', body: { parentId: null } });
  });

  it('**늦게 온 옛 읽기는 새 읽기를 덮지 않는다** — 연달아 바꾸면 응답 순서가 뒤바뀐다', async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    // 둘째 읽기(첫 바꾸기 뒤)는 붙잡아 두었다가 셋째 읽기(둘째 바꾸기 뒤)보다 늦게 준다
    answerSpace = (n) =>
      n === 2 ? held.then(() => json(200, { ...space, name: '옛 이름' })) : Promise.resolve(json(200, n === 1 ? space : { ...space, name: '새 이름' }));
    renderAt('/spaces/s1');
    fireEvent.change(await screen.findByLabelText('kim 역할'), { target: { value: 'viewer' } });
    await waitFor(() => expect(spaceGets).toBe(2));
    fireEvent.change(screen.getByLabelText('kim 역할'), { target: { value: 'viewer' } });
    await screen.findByRole('heading', { name: '새 이름' });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('새 이름');
  });
});

describe('SpacePage — 떠 있는 채로 주소가 바뀌면', () => {
  it('**다른 페이지의 하위 페이지 만들기로 다시 오면 그 부모로 바꿔 고른다** — 같은 화면이 다시 쓰인다(주소의 뒤만 바뀐다)', async () => {
    render(
      <MemoryRouter initialEntries={['/spaces/s1?parent=p1']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/spaces/:id"
              element={
                <>
                  <SpacePage />
                  <Link to="/spaces/s1?parent=p2">규정 아래에 만들기</Link>
                </>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByLabelText('위치');
    // 트리를 읽은 뒤 그 스페이스에 있는지 보고 고른다 — 칸이 뜬 바로 그때는 아직 맨 위다
    await waitFor(() => expect(where()).toBe('p1'));
    fireEvent.click(screen.getByRole('link', { name: '규정 아래에 만들기' }));
    await waitFor(() => expect(where()).toBe('p2'));
  });
});

describe('SpacePage — Crew의 역할 (FR-1512)', () => {
  it('**넣을 때 역할을 고른다** — viewer로도 넣는다', async () => {
    renderAt('/spaces/s1');
    await screen.findByLabelText('아이디로 Crew 추가');
    fireEvent.change(screen.getByLabelText('아이디로 Crew 추가'), { target: { value: 'lee' } });
    fireEvent.change(screen.getByLabelText('역할'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'POST', url: '/api/spaces/s1/members', body: { username: 'lee', role: 'viewer' } });
  });

  it('**넣은 사람의 역할을 바꾼다** — owner 줄은 고를 수 없다', async () => {
    renderAt('/spaces/s1');
    const kim = await screen.findByLabelText('kim 역할');
    expect(screen.queryByLabelText('owner 역할')).toBeNull();
    fireEvent.change(kim, { target: { value: 'viewer' } });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'PATCH', url: '/api/spaces/s1/members/u2', body: { role: 'viewer' } });
  });
});
