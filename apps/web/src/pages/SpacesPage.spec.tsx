// @vitest-environment happy-dom
import type { MeView, SpaceAccess, SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { SpacesPage } from './SpacesPage';

/**
 * 컴포넌트 시험 — 홈(내 스페이스 목록, P17 설계서 J.6 기본 문맥). h1 "스페이스" 하나, 팀 스페이스 만들기 한 줄, 스페이스 표, 0건이면 빈 상태.
 * 인사말·메뉴 링크·로그아웃은 한 틀의 위 막대로 옮겼다 — 권한에 따른 메뉴의 보임은 `layout/AppLayout.spec.tsx`가 본다(P15 D.5에서 옮겼다).
 * 여기서는 본문이 그것을 **되풀이하지 않는지**를 본다(J.8-1 — 한 화면에 같은 이름의 링크가 둘이면 사람도 시험도 헷갈린다). 서버는 가짜 `fetch`다
 */

const NO: SpaceAccess = { canRead: true, canWrite: false, canManageMembers: false, canEditInfo: false, canChangeStatus: false, canDelete: false, isOwner: false, crewFrozen: false };
const space = (over: Partial<SpaceView>): SpaceView => ({
  id: 's1',
  key: 'ABCD',
  name: '운영팀',
  description: '',
  kind: 'team',
  status: 'active',
  suspendedByOwner: false,
  categoryId: null,
  categoryName: null,
  createdBy: 'm1',
  createdByUsername: 'kim',
  memberCount: 2,
  myRole: 'owner',
  access: NO,
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  ...over,
});

let me: MeView;
let personal: SpaceView[];
let team: SpaceView[];
let calls: { method: string; url: string; body: unknown }[];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  me = { id: 'm1', username: 'kim', displayName: '김', role: 'admin', mustChangePassword: false, grants: [], hasPassword: true };
  personal = [space({ id: 'p1', key: 'KIM1', name: '김의 공간', kind: 'personal', memberCount: 1 })];
  team = [];
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/spaces?scope=personal') return Promise.resolve(json(200, personal));
    if (url === '/api/spaces?scope=team') return Promise.resolve(json(200, team));
    if (method === 'POST' && url === '/api/spaces') {
      team = [space({ id: 't9', key: 'NEW1', name: '새 팀', memberCount: 1 })];
      return Promise.resolve(json(201, team[0]));
    }
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
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
        <SpacesPage />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('SpacesPage — 홈 (P17 J.6)', () => {
  it('**h1은 "스페이스" 하나이고, 위 막대·왼쪽 칸에 있는 메뉴·인사말·로그아웃을 본문에 되풀이하지 않는다** — 관리자라도', async () => {
    renderPage();
    await screen.findByRole('link', { name: '김의 공간' });
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1.map((h) => h.textContent)).toEqual(['스페이스']);
    // 예전 홈의 메뉴 줄 — 이제 틀의 몫이다
    for (const name of ['사용자 관리', '감사로그', '스페이스 관리', '검색', '휴지통', 'LLM 질문', '운영 설정', 'LLM 연결', '비밀번호 변경']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull();
    expect(screen.queryByText(/김님/)).toBeNull();
  });

  it('**스페이스 목록은 표다** — 이름 링크·종류·키·Crew·상태. 중지는 배지, 분류 열은 붙은 공간이 있을 때만', async () => {
    team = [space({ id: 't1', key: 'OPS1', name: '운영팀', status: 'suspended', categoryName: '운영', memberCount: 3 })];
    renderPage();
    const table = await screen.findByRole('table', { name: '내 스페이스' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['이름', '종류', '키', '분류', 'Crew', '상태']);
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first).getAllByRole('cell').map((c) => c.textContent)).toEqual(['김의 공간', '개인', 'KIM1', '없음', '1', '활성']);
    expect(within(first).getByRole('link', { name: '김의 공간' }).getAttribute('href')).toBe('/spaces/p1');
    expect(within(second).getAllByRole('cell').map((c) => c.textContent)).toEqual(['운영팀', '팀', 'OPS1', '운영', '3', '중지']);
    // 상태는 배지다 — 기호는 CSS가 붙인다
    expect(within(second).getByText('중지').className).toBe('badge paused');
    expect(within(first).getByText('활성').className).toBe('badge ok');
  });

  it('분류가 붙은 공간이 없으면 분류 열이 없다', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: '내 스페이스' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['이름', '종류', '키', 'Crew', '상태']);
  });

  it('0건이면 빈 상태를 보이고 표를 그리지 않는다', async () => {
    personal = [];
    renderPage();
    expect(await screen.findByText('아직 스페이스가 없다.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('**팀 스페이스 만들기는 칸 하나 + 주 단추 한 줄** — 라벨 "이름"으로 쓰고 "만들기"를 누르면 만들고 목록을 다시 받는다', async () => {
    renderPage();
    await screen.findByRole('link', { name: '김의 공간' });
    const form = screen.getByRole('form', { name: '팀 스페이스 만들기' });
    expect(form.className).toBe('inline-form');
    const button = within(form).getByRole('button', { name: '만들기' });
    expect(button.className).toBe('primary');
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '새 팀' } });
    fireEvent.click(button);
    expect(await screen.findByRole('link', { name: '새 팀' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/api/spaces', body: { name: '새 팀', kind: 'team' } });
    await waitFor(() => expect((screen.getByLabelText('이름') as HTMLInputElement).value).toBe(''));
  });
});
