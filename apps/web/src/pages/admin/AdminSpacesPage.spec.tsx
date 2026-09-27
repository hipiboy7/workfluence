// @vitest-environment happy-dom
import { SPACE_LIST_MAX, type CategoryView, type MeView, type SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth';
import { AdminSpacesPage } from './AdminSpacesPage';

/**
 * 컴포넌트 시험 — 관리 콘솔의 스페이스 (P14_설계서_Spaces D.3, FR-1513~1515). **찾기와 상태는 서버에 보낸다**(`q`·`status`) — 화면에서 거르지 않는다.
 * 늦게 온 옛 응답은 버린다. 줄의 조치는 응답의 `access`대로. 분류를 지울 수 없으면 서버의 까닭을 보인다. 서버는 가짜 `fetch`다
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let me: MeView;
let spaces: SpaceView[];
let categories: CategoryView[];
let delay: (url: string) => number = () => 0;
let categoryDelete: { status: number; body: unknown } = { status: 200, body: { ok: true } };
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const NO = { canRead: true, canWrite: false, canManageMembers: false, canChangeStatus: false, canDelete: false, isOwner: false };
const space = (over: Partial<SpaceView>): SpaceView => ({
  id: 's',
  key: 'KEY',
  name: 's',
  description: '',
  kind: 'team',
  status: 'active',
  categoryId: null,
  categoryName: null,
  createdBy: 'u1',
  createdByUsername: 'owner',
  memberCount: 3,
  myRole: null,
  access: { ...NO, canWrite: true, canManageMembers: true, canChangeStatus: true },
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  calls = [];
  delay = () => 0;
  categoryDelete = { status: 200, body: { ok: true } };
  me = { id: 'a1', username: 'boss', displayName: '관리자', role: 'admin', mustChangePassword: false, grants: [], hasPassword: true };
  spaces = [
    space({ id: 's1', key: 'OPS1', name: '운영팀' }),
    space({ id: 's2', key: 'DEV1', name: '개발팀', status: 'suspended', access: { ...NO, canChangeStatus: true, canDelete: true } }),
  ];
  categories = [{ id: 'c1', name: '운영', createdAt: '2026-09-27T00:00:00.000Z' }];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
    const answer = (r: Response) => new Promise<Response>((ok) => setTimeout(() => ok(r), delay(url)));
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (method === 'GET' && url.startsWith('/api/spaces?')) {
      const p = new URL(url, 'http://t').searchParams;
      const q = p.get('q') ?? '';
      const status = p.get('status');
      return answer(json(200, spaces.filter((s) => (!q || s.name.includes(q) || s.key.includes(q)) && (!status || s.status === status))));
    }
    if (method === 'GET' && url === '/api/categories') return answer(json(200, categories));
    if (method === 'DELETE' && url.startsWith('/api/categories/')) return answer(json(categoryDelete.status, categoryDelete.body));
    return answer(json(200, {}));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <AdminSpacesPage />
      </AuthProvider>
    </MemoryRouter>,
  );
const listCalls = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/spaces?')).map((c) => c.url);
const writes = () => calls.filter((c) => c.method !== 'GET');

describe('AdminSpacesPage — 모든 스페이스', () => {
  it('**모든 스페이스를 상한만큼 받는다** — `scope=all`, `limit`은 공유 상수', async () => {
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    expect(listCalls()).toEqual([`/api/spaces?scope=all&limit=${SPACE_LIST_MAX}`]);
    expect(screen.getByRole('link', { name: '개발팀' })).toBeTruthy();
  });

  it('**찾기와 상태는 서버에 보낸다** — 화면에서 거르지 않는다(상한 밖을 찾으려면)', async () => {
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '개발' } });
    fireEvent.change(screen.getByLabelText('상태'), { target: { value: 'suspended' } });
    await waitFor(() => expect(listCalls().at(-1)).toBe(`/api/spaces?scope=all&limit=${SPACE_LIST_MAX}&q=%EA%B0%9C%EB%B0%9C&status=suspended`));
    await waitFor(() => expect(screen.queryByRole('link', { name: '운영팀' })).toBeNull());
  });

  it('**늦게 온 옛 응답은 버린다** — 마지막 찾기만 받는다', async () => {
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    // 첫 찾기('운영')는 늦게, 둘째('개발')는 곧바로 온다
    delay = (url) => (url.includes('q=%EC%9A%B4%EC%98%81') ? 600 : 0);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '운영' } });
    await waitFor(() => expect(listCalls().some((u) => u.includes('q=%EC%9A%B4%EC%98%81'))).toBe(true));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '개발' } });
    await screen.findByRole('link', { name: '개발팀' });
    await new Promise((r) => setTimeout(r, 800));
    expect(screen.queryByRole('link', { name: '운영팀' })).toBeNull();
  });

  it('**줄의 조치는 access대로** — 활성은 중지(묻는다), 중지된 것은 다시 쓰기·지우기(묻는다)', async () => {
    // happy-dom에는 `confirm`이 없다 — 브라우저처럼 둔다
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    renderPage();
    await screen.findByRole('link', { name: '운영팀' });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.filter((t) => t === '중지')).toHaveLength(1);
    expect(buttons.filter((t) => t === '다시 쓰기')).toHaveLength(1);
    expect(buttons.filter((t) => t === '지우기').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '다시 쓰기' }));
    fireEvent.click(screen.getAllByRole('button', { name: '지우기' })[0]);
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()).toEqual([
      { method: 'PATCH', url: '/api/spaces/s1/status', body: { status: 'suspended' } },
      { method: 'PATCH', url: '/api/spaces/s2/status', body: { status: 'active' } },
      { method: 'DELETE', url: '/api/spaces/s2', body: undefined },
    ]);
    expect(confirm).toHaveBeenCalledTimes(2); // 중지·지우기 — 다시 쓰기는 묻지 않는다
  });

  it(`**상한(${SPACE_LIST_MAX}개)을 채우면 찾기로 좁히라고 말한다**`, async () => {
    spaces = Array.from({ length: SPACE_LIST_MAX }, (_, i) => space({ id: `s${i}`, key: `K${i}`, name: `스페이스 ${i}` }));
    renderPage();
    expect(await screen.findByText(new RegExp(`${SPACE_LIST_MAX}개까지 보인다`))).toBeTruthy();
  });

  it('관리 권한이 없으면 목록을 부르지 않는다', async () => {
    me = { ...me, role: 'member' };
    renderPage();
    expect(await screen.findByText('스페이스를 관리할 권한이 없다.')).toBeTruthy();
    expect(listCalls()).toEqual([]);
  });
});

describe('AdminSpacesPage — 분류', () => {
  it('**만들고 이름을 바꾼다** — 이름이 그대로면 바꾸기를 누를 수 없다', async () => {
    renderPage();
    const box = (await screen.findByLabelText('분류 운영 이름')) as HTMLInputElement;
    expect((screen.getByRole('button', { name: '이름 바꾸기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '운영·지원' } });
    fireEvent.click(screen.getByRole('button', { name: '이름 바꾸기' }));
    fireEvent.change(screen.getByLabelText('새 분류'), { target: { value: '개발' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()).toEqual([
      { method: 'PATCH', url: '/api/categories/c1', body: { name: '운영·지원' } },
      { method: 'POST', url: '/api/categories', body: { name: '개발' } },
    ]);
  });

  it('**쓰는 스페이스가 있어 지울 수 없으면 서버의 까닭을 보인다** (P4 FR-538)', async () => {
    window.confirm = vi.fn(() => true);
    categoryDelete = { status: 409, body: { message: '이 분류를 쓰는 스페이스가 2개 있다(휴지통 포함). 먼저 옮긴 뒤 지운다' } };
    renderPage();
    await screen.findByLabelText('분류 운영 이름');
    const del = screen.getAllByRole('button', { name: '지우기' }).at(-1)!;
    fireEvent.click(del);
    expect((await screen.findByRole('alert')).textContent).toContain('이 분류를 쓰는 스페이스가 2개 있다');
  });
});
