// @vitest-environment happy-dom
import type { MeView, UserView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth';
import { AdminUsersPage } from './AdminUsersPage';

/** 컴포넌트 시험 — 사용자 관리의 위임 (P11_설계서_Ops D.1·G절, FR-1201·1206). 서버는 가짜 `fetch`다 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let me: MeView;
let rows: UserView[];

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const user = (over: Partial<UserView>): UserView => ({
  id: 'x',
  username: 'x',
  displayName: 'x',
  email: null,
  role: 'member',
  status: 'active',
  mustChangePassword: false,
  grants: [],
  createdAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  calls = [];
  me = { id: 'r1', username: 'root', displayName: '시스템 관리자', role: 'root', mustChangePassword: false, grants: [] };
  rows = [user({ id: 'a1', username: 'boss', role: 'admin' }), user({ id: 'm1', username: 'alice' })];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (method === 'GET' && url === '/api/users') return Promise.resolve(json(200, rows));
    if (method === 'PUT' && url === '/api/users/a1/grants') {
      rows = rows.map((r) => (r.id === 'a1' ? { ...r, grants: (body as { grants: UserView['grants'] }).grants } : r));
      return Promise.resolve(json(200, rows[0]));
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
        <AdminUsersPage />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('AdminUsersPage — 위임', () => {
  it('**root는 관리자에게 LLM 연결 관리를 주고 거둔다** — 목록 전체를 보내고 다시 읽는다', async () => {
    renderPage();
    const box = (await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/api/users/a1/grants', body: { grants: ['llm.manage'] } });
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'boss LLM 연결 관리' }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole('checkbox', { name: 'boss LLM 연결 관리' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ grants: [] }));
  });

  it('**관리자가 아닌 행에는 위임이 없다** — member는 받지 않는다', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' });
    expect(screen.queryByRole('checkbox', { name: 'alice LLM 연결 관리' })).toBeNull();
  });

  it('**다른 관리자에게는 보이기만 한다** — 주고 거두는 것은 root만 (A.1-3)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: ['llm.manage'] };
    renderPage();
    const box = (await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' })) as HTMLInputElement;
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    expect(box.disabled).toBe(true);
    expect(box.title).toMatch(/시스템 관리자만/);
  });

  it('**위임 없는 관리자는 위임받은 관리자를 관리하지 못한다** — 그 행의 조치는 눌리지 않는다. 다른 행은 그대로 (보안 검토 1)', async () => {
    me = { ...me, id: 'a2', role: 'admin', grants: [] };
    rows = [user({ id: 'a1', username: 'boss', role: 'admin', grants: ['llm.manage'] }), user({ id: 'a3', username: 'peer', role: 'admin' }), user({ id: 'm1', username: 'alice' })];
    renderPage();
    await screen.findByRole('checkbox', { name: 'boss LLM 연결 관리' });
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'boss 역할' }) as HTMLSelectElement).disabled).toBe(true));
    const resets = screen.getAllByRole('button', { name: '비밀번호 초기화' }) as HTMLButtonElement[];
    const ends = screen.getAllByRole('button', { name: '세션 강제 종료' }) as HTMLButtonElement[];
    expect(resets.map((b) => b.disabled)).toEqual([true, false, false]);
    expect(ends.map((b) => b.disabled)).toEqual([true, false, false]);
    expect(resets[0].title).toMatch(/권한이 없다/);
    expect((screen.getByRole('combobox', { name: 'peer 역할' }) as HTMLSelectElement).disabled).toBe(false);
  });
});
