// @vitest-environment happy-dom
import type { MeView, NotificationView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { NOTIFICATION_POLL_MS } from '@workfluence/shared';
import { NOTIFICATIONS_CHANGED, NotificationBell, bellLabel } from './NotificationBell';

const NOTIFICATION_POLL_MS_FOR_TEST = NOTIFICATION_POLL_MS + 10;

/**
 * 컴포넌트 시험 — 모든 화면의 알림 영역 (P17 F-010 8번). 로그인한 사람에게만 그리고, 안 읽은 수를 단추가 읽어 주고, 누르면 최근 알림이
 * 펼쳐진다. 비밀번호 초기화 요청은 요청한 사람과 사용자 관리로 가는 링크를 보인다. 서버는 가짜 `fetch`다
 */

let me: MeView | null;
let unread = 0;
let asked: string[] = [];
let heads: Record<string, Headers> = {};
const rows: NotificationView[] = [
  {
    id: 'n1',
    kind: 'password.reset.request',
    pageId: null,
    commentId: null,
    actorName: '앨리스',
    actorUsername: 'alice',
    pageTitle: null,
    readAt: null,
    createdAt: '2026-09-28T01:00:00.000Z',
  },
  {
    id: 'n2',
    kind: 'mention',
    pageId: '11111111-1111-4111-8111-111111111111',
    commentId: null,
    actorName: '밥',
    actorUsername: null,
    pageTitle: '회의록',
    readAt: '2026-09-28T02:00:00.000Z',
    createdAt: '2026-09-28T00:30:00.000Z',
  },
];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  me = { id: 'u1', username: 'root', displayName: '관리자', role: 'root', mustChangePassword: false, grants: [], hasPassword: true };
  unread = 1;
  asked = [];
  heads = {};
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    heads[url] = new Headers(init?.headers);
    if (url === '/api/auth/me') return Promise.resolve(me ? json(200, me) : json(401, { message: '로그인이 필요하다' }));
    if (url === '/api/notifications/unread-count') return Promise.resolve(json(200, { count: unread }));
    if (url.startsWith('/api/notifications?limit=')) return Promise.resolve(json(200, rows));
    return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderBell = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <NotificationBell />
        <Routes>
          <Route path="/" element={<p>홈</p>} />
          <Route path="/admin/users" element={<p>사용자 관리 화면</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

describe('NotificationBell', () => {
  it('**안 읽은 수를 단추가 읽어 주고, 누르면 최근 알림이 펼쳐진다** — 초기화 요청은 요청한 사람과 사용자 관리로 가는 링크', async () => {
    renderBell();
    const bell = await screen.findByRole('button', { name: bellLabel(1) });
    expect(bellLabel(1)).toBe('알림 — 안 읽은 것 1건');
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(bell);
    const panel = await screen.findByRole('region', { name: '최근 알림' });
    await waitFor(() => expect(panel.textContent).toContain('앨리스 (alice)님이 비밀번호 초기화를 요청했다'));
    expect(panel.textContent).toContain('밥님이 불렀다');
    expect(screen.getByRole('link', { name: '회의록' }).getAttribute('href')).toBe('/pages/11111111-1111-4111-8111-111111111111');
    expect(screen.getByRole('link', { name: '알림함에서 모두 보기' }).getAttribute('href')).toBe('/notifications');
    // 링크를 누르면 그 화면으로 가고 펼친 목록은 닫힌다
    fireEvent.click(screen.getByRole('link', { name: '사용자 관리에서 초기화' }));
    await screen.findByText('사용자 관리 화면');
    expect(screen.queryByRole('region', { name: '최근 알림' })).toBeNull();
  });

  it('**Esc로 닫고, 알림함이 읽음을 바꾸면 수를 곧바로 다시 묻는다** — 다 읽으면 단추는 "알림"만', async () => {
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: bellLabel(1) }));
    await screen.findByRole('region', { name: '최근 알림' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: '최근 알림' })).toBeNull());
    unread = 0;
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
    await screen.findByRole('button', { name: '알림' });
  });

  it('**로그인하지 않았거나 비밀번호를 바꿔야 하면 그리지 않고 묻지도 않는다**', async () => {
    me = null;
    renderBell();
    await waitFor(() => expect(asked).toContain('/api/auth/me'));
    expect(screen.queryByRole('button', { name: /^알림/ })).toBeNull();
    cleanup();
    me = { id: 'u1', username: 'root', displayName: '관리자', role: 'root', mustChangePassword: true, grants: [], hasPassword: true };
    asked = [];
    renderBell();
    await waitFor(() => expect(asked).toContain('/api/auth/me'));
    await screen.findByText('홈');
    expect(screen.queryByRole('button', { name: /^알림/ })).toBeNull();
    expect(asked).not.toContain('/api/notifications/unread-count');
  });
});

describe('알림 수는 배경 요청으로 묻는다 (P17 병합 전 검토 — 세션을 늘리지 않는다)', () => {
  it('안 읽은 수를 묻는 요청에 배경 표시가 붙는다 — 서버가 세션을 늘리지 않고 접근 로그에 남기지 않는다', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <NotificationBell />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(asked).toContain('/api/notifications/unread-count'));
    expect(heads['/api/notifications/unread-count'].get('x-wf-background')).toBe('1');
    // 사람이 연 목록은 배경 요청이 아니다
    fireEvent.click(await screen.findByRole('button', { name: /^알림/ }));
    await waitFor(() => expect(asked.some((u) => u.startsWith('/api/notifications?limit='))).toBe(true));
    const listUrl = asked.find((u) => u.startsWith('/api/notifications?limit='))!;
    expect(heads[listUrl].get('x-wf-background')).toBeNull();
  });

  it('탭이 가려져 있으면 주기의 물음을 건너뛰고, 다시 보이면 곧바로 묻는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <NotificationBell />
          </AuthProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(asked.filter((u) => u === '/api/notifications/unread-count').length).toBe(1));
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS_FOR_TEST);
      expect(asked.filter((u) => u === '/api/notifications/unread-count').length).toBe(1);
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(asked.filter((u) => u === '/api/notifications/unread-count').length).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
