// @vitest-environment happy-dom
import type { MeView, PageSummary, SpaceMemberView, SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { SpacePage } from './SpacePage';

/**
 * 컴포넌트 시험 — 스페이스 화면 (P14_설계서_Spaces D.2·D.3, FR-1500·1512). 트리는 들여쓰고, 새 페이지의 **위치**를 고르며, 페이지 보기의 하위 페이지
 * 만들기(`?parent=`)로 오면 그 부모를 골라 둔다. Crew에 넣을 때 역할을 고르고 넣은 뒤 바꾼다. 서버는 가짜 `fetch`다
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
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
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/spaces/s1') return Promise.resolve(json(200, space));
    if (url === '/api/pages?spaceId=s1') return Promise.resolve(json(200, tree));
    if (url === '/api/spaces/s1/members' && method === 'GET') return Promise.resolve(json(200, crew));
    if (url === '/api/templates' || url === '/api/categories') return Promise.resolve(json(200, []));
    if (url === '/api/pages' && method === 'POST') return Promise.resolve(json(201, page('new', '새 문서', 'p1', 1)));
    return Promise.resolve(json(200, crew));
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

describe('SpacePage — 트리와 하위 페이지', () => {
  it('**트리는 부모 → 자식 순서로 들여쓴다**', async () => {
    renderAt('/spaces/s1');
    const list = await screen.findByRole('list', { name: '페이지 트리' });
    await within(list).findByRole('link', { name: '9월 회의' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => [li.textContent?.replace(/\s*v\d+$/, ''), li.style.marginLeft])).toEqual([
      ['회의록', '0px'],
      ['9월 회의', '16px'],
      ['규정', '0px'],
    ]);
  });

  it('**위치를 고르면 그 아래에 만든다** — 기본은 맨 위', async () => {
    renderAt('/spaces/s1');
    await screen.findByLabelText('위치');
    expect((screen.getByLabelText('위치') as HTMLSelectElement).value).toBe('');
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
    expect((screen.getByLabelText('위치') as HTMLSelectElement).value).toBe('p1');
    fireEvent.change(box, { target: { value: '10월 회의' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('편집 화면');
    expect(writes()[0].body).toMatchObject({ parentId: 'p1', title: '10월 회의' });
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
    expect((screen.getByLabelText('위치') as HTMLSelectElement).value).toBe('p1');
    fireEvent.click(screen.getByRole('link', { name: '규정 아래에 만들기' }));
    await waitFor(() => expect((screen.getByLabelText('위치') as HTMLSelectElement).value).toBe('p2'));
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
