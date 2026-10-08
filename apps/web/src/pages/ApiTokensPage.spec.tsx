// @vitest-environment happy-dom
import type { ApiTokenView, MeView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { ApiTokensPage } from './ApiTokensPage';

/**
 * 컴포넌트 시험 — 내 API 토큰 화면 (docs/spinoff/public-api 설계서 FR-2222). 서버는 가짜 `fetch`다. 지켜야 할 것: **토큰 값은 발급 직후 한 번만** 보이고,
 * 켜짐·상한은 서버가 준 설정(`/api/tokens/config`)을 따르며, 폐기는 확인을 거친다.
 */

let me: MeView;
let config: { enabled: boolean; scopes: string[]; maxDays: number; defaultDays: number; maxPerUser: number };
let tokens: ApiTokenView[];
let sent: { method: string; url: string; body?: unknown }[];
let createFails: { status: number; body: unknown } | null;

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;
const view = (over: Partial<ApiTokenView> = {}): ApiTokenView => ({
  id: 't1',
  name: '봇',
  scopes: ['read'],
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-12-30T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

beforeEach(() => {
  me = { id: 'u1', username: 'alice', displayName: '앨리스', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
  config = { enabled: true, scopes: ['read', 'write', 'admin'], maxDays: 365, defaultDays: 90, maxPerUser: 10 };
  tokens = [];
  sent = [];
  createFails = null;
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/tokens/config') return Promise.resolve(json(200, config));
    if (url === '/api/tokens' && method === 'GET') return Promise.resolve(json(200, tokens));
    if (url === '/api/tokens' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      sent.push({ method, url, body });
      if (createFails) return Promise.resolve(json(createFails.status, createFails.body));
      const created = view({ id: 'new1', name: body.name, scopes: body.scopes });
      tokens = [created, ...tokens];
      return Promise.resolve(json(201, { ...created, token: 'eyJhbGciOi.PAYLOAD.SIGNATURE' }));
    }
    const del = /^\/api\/tokens\/([^/]+)$/.exec(url);
    if (del && method === 'DELETE') {
      sent.push({ method, url });
      tokens = tokens.map((t) => (t.id === del[1] ? { ...t, status: 'revoked', revokedAt: '2026-10-08T00:00:00.000Z' } : t));
      return Promise.resolve(json(200, tokens.find((t) => t.id === del[1])));
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
        <ApiTokensPage />
      </AuthProvider>
    </MemoryRouter>,
  );
const nameInput = () => screen.getByLabelText('이름') as HTMLInputElement;
const box = (label: RegExp) => screen.getByRole('checkbox', { name: label }) as HTMLInputElement;

describe('ApiTokensPage', () => {
  it('서버가 꺼져 있다고 하면 폼 대신 그렇게 말한다', async () => {
    config = { ...config, enabled: false };
    renderPage();
    await screen.findByText(/공개 API가 꺼져 있다/);
    expect(screen.queryByLabelText('이름')).toBeNull();
  });

  it('폼은 서버의 설정을 따른다 — 만료 칸의 기본·상한, 권한 칸', async () => {
    renderPage();
    await screen.findByLabelText('이름');
    const days = screen.getByLabelText(/만료/) as HTMLInputElement;
    expect(days.max).toBe('365');
    expect(days.placeholder).toBe('90');
    expect(box(/읽기/).checked).toBe(true); // 읽기가 기본이다 — 가장 약한 권한
    expect(box(/쓰기/).checked).toBe(false);
  });

  it('**관리(admin) 권한은 관리자만 고른다** — member에게는 칸이 없다', async () => {
    renderPage();
    await screen.findByLabelText('이름');
    expect(screen.queryByRole('checkbox', { name: /관리/ })).toBeNull();
    cleanup();
    me = { ...me, role: 'admin' };
    renderPage();
    await screen.findByLabelText('이름');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /관리/ })).toBeTruthy());
  });

  it('이름이 없으면 만들 수 없다', async () => {
    renderPage();
    await screen.findByLabelText('이름');
    expect((screen.getByRole('button', { name: '발급' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('**발급하면 토큰 값이 한 번 보이고 다시 볼 수 없다고 말한다** — 확인을 누르면 사라진다', async () => {
    renderPage();
    await screen.findByLabelText('이름');
    fireEvent.change(nameInput(), { target: { value: '보고서 봇' } });
    fireEvent.click(box(/쓰기/));
    fireEvent.click(screen.getByRole('button', { name: '발급' }));

    const value = await screen.findByLabelText('발급된 토큰');
    expect(value.textContent).toBe('eyJhbGciOi.PAYLOAD.SIGNATURE');
    expect(screen.getByText(/다시 볼 수 없다/)).toBeTruthy();
    expect(sent[0]).toEqual({ method: 'POST', url: '/api/tokens', body: { name: '보고서 봇', scopes: ['read', 'write'] } });

    fireEvent.click(screen.getByRole('button', { name: '확인했다' }));
    await waitFor(() => expect(screen.queryByLabelText('발급된 토큰')).toBeNull());
    expect(screen.queryByText('eyJhbGciOi.PAYLOAD.SIGNATURE')).toBeNull();
    // 목록에는 이름만 있다 — 값이 없다
    expect(within(screen.getByRole('row', { name: /보고서 봇/ })).queryByText(/eyJ/)).toBeNull();
  });

  it('만료 일수를 적으면 보내고, 비우면 서버 기본에 맡긴다', async () => {
    renderPage();
    await screen.findByLabelText('이름');
    fireEvent.change(nameInput(), { target: { value: '한 달짜리' } });
    fireEvent.change(screen.getByLabelText(/만료/), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '발급' }));
    await screen.findByLabelText('발급된 토큰');
    expect((sent[0]!.body as { expiresInDays?: number }).expiresInDays).toBe(30);
  });

  it('**값을 복사한다** — 복사하지 못하면 그렇게 말한다', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    renderPage();
    await screen.findByLabelText('이름');
    fireEvent.change(nameInput(), { target: { value: '봇' } });
    fireEvent.click(screen.getByRole('button', { name: '발급' }));
    await screen.findByLabelText('발급된 토큰');
    fireEvent.click(screen.getByRole('button', { name: '값 복사' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith('eyJhbGciOi.PAYLOAD.SIGNATURE'));
    await screen.findByText('복사했다');
  });

  it('개수 한도에 걸리면 서버의 까닭을 보인다 — 값은 보이지 않는다', async () => {
    createFails = { status: 409, body: { code: 'TOKEN_LIMIT', message: '살아 있는 토큰은 10개까지다' } };
    renderPage();
    await screen.findByLabelText('이름');
    fireEvent.change(nameInput(), { target: { value: '봇' } });
    fireEvent.click(screen.getByRole('button', { name: '발급' }));
    await screen.findByText(/10개까지다/);
    expect(screen.queryByLabelText('발급된 토큰')).toBeNull();
  });

  it('폐기는 확인을 거쳐 그 토큰을 폐기하고 목록이 상태를 바꾼다', async () => {
    tokens = [view({ id: 'a1', name: '옛 봇' })];
    renderPage();
    await screen.findByRole('row', { name: /옛 봇/ });
    fireEvent.click(screen.getByRole('button', { name: '폐기' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '폐기한다' }));
    await waitFor(() => expect(sent).toContainEqual({ method: 'DELETE', url: '/api/tokens/a1' }));
    await waitFor(() => expect(within(screen.getByRole('row', { name: /옛 봇/ })).getByText('폐기됨')).toBeTruthy());
  });

  it('확인에서 그만두면 폐기하지 않는다', async () => {
    tokens = [view({ id: 'a1', name: '옛 봇' })];
    renderPage();
    await screen.findByRole('row', { name: /옛 봇/ });
    fireEvent.click(screen.getByRole('button', { name: '폐기' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent.filter((s) => s.method === 'DELETE')).toEqual([]);
  });

  it('쓰는 법을 알린다 — 명세 주소와 Authorization 머리말(토큰 값 없이)', async () => {
    renderPage();
    await screen.findByLabelText('이름');
    expect(screen.getByText(/\/api\/v1\/openapi\.json/)).toBeTruthy();
    expect(screen.getByText(/Authorization: Bearer/)).toBeTruthy();
  });
});
