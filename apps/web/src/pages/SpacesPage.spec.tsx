// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { SpacesPage } from './SpacesPage';

/**
 * 컴포넌트 시험 — 첫 화면 메뉴의 **스페이스 관리** (P15_설계서_Grants D.5). 관리자와, 스페이스 관리 전체나 분류 관리를 맡겨 받은 member에게 보인다.
 * 판정은 서버의 가드와 같은 `can()`이고 위임을 함께 넘긴다. 서버는 가짜 `fetch`다
 */

let me: MeView;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  me = { id: 'm1', username: 'kim', displayName: '김', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/notifications/unread-count') return Promise.resolve(json(200, { count: 0 }));
    if (url.startsWith('/api/spaces?')) return Promise.resolve(json(200, []));
    return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
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

describe('SpacesPage — 스페이스 관리 메뉴 (P15 D.5)', () => {
  it.each([
    ['관리자', { role: 'admin' as const, grants: [] }, true],
    ['스페이스 관리 전체를 받은 member', { role: 'member' as const, grants: ['space.oversee' as const] }, true],
    ['분류 관리를 받은 member', { role: 'member' as const, grants: ['category.manage' as const] }, true],
    ['관리자가 건 중지 풀기만 받은 member', { role: 'member' as const, grants: ['space.unsuspend' as const] }, false],
    ['아무것도 받지 않은 member', { role: 'member' as const, grants: [] }, false],
  ])('%s → 보이는가 %s', async (_who, over, shown) => {
    me = { ...me, ...over };
    renderPage();
    await screen.findByRole('link', { name: 'LLM 질문' });
    await waitFor(() => expect(screen.queryByRole('link', { name: '스페이스 관리' }) !== null).toBe(shown));
  });
});
