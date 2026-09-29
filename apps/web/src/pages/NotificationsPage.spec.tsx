// @vitest-environment happy-dom
import type { NotificationView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATIONS_CHANGED } from '../components/NotificationBell';
import { NotificationsPage } from './NotificationsPage';

/**
 * 컴포넌트 시험 — 알림함 (P4 C절 · P17 설계서 J.6 기본 문맥). 머리에 "안 읽은 것 N건"과 **모두 읽음**, 줄마다 **읽음**, 안 읽은 줄은 막대(`li.unread`)와
 * "안 읽음" 글. 줄은 `li.card`이고 그 안의 `strong`은 부른 사람 하나다 — E2E가 그 둘로 찾는다(collab.spec). 서버는 가짜 `fetch`다
 */

let rows: NotificationView[];
let calls: { method: string; url: string }[];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)) }) as unknown as Response;
const note = (over: Partial<NotificationView>): NotificationView => ({
  id: 'n1',
  kind: 'mention',
  pageId: '11111111-1111-4111-8111-111111111111',
  commentId: null,
  actorName: '앨리스',
  actorUsername: null,
  pageTitle: '회의록',
  readAt: null,
  createdAt: '2026-09-28T01:00:00.000Z',
  ...over,
});

beforeEach(() => {
  rows = [note({ id: 'n1' }), note({ id: 'n2', actorName: '밥', pageTitle: null, pageId: null, readAt: '2026-09-28T02:00:00.000Z' })];
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url });
    if (method === 'GET' && url.startsWith('/api/notifications?limit=')) return Promise.resolve(json(200, rows));
    if (method === 'POST' && url === '/api/notifications/read-all') {
      rows = rows.map((r) => ({ ...r, readAt: r.readAt ?? '2026-09-28T03:00:00.000Z' }));
      return Promise.resolve(json(204, undefined));
    }
    if (method === 'POST' && /^\/api\/notifications\/[^/]+\/read$/.test(url)) {
      const id = url.split('/')[3];
      rows = rows.map((r) => (r.id === id ? { ...r, readAt: '2026-09-28T03:00:00.000Z' } : r));
      return Promise.resolve(json(204, undefined));
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
      <NotificationsPage />
    </MemoryRouter>,
  );

describe('NotificationsPage', () => {
  it('**줄은 `li.card`, 안 읽은 줄은 막대와 "안 읽음" 글, 읽은 줄은 "· 읽음"** — 읽음 단추는 안 읽은 줄에만', async () => {
    const { container } = renderPage();
    expect(await screen.findByText('안 읽은 것 1건')).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.className)).toEqual(['card unread', 'card']);
    expect(items[0].textContent).toContain('· 안 읽음');
    expect(within(items[0]).getByRole('button', { name: '읽음' }).className).toBe('subtle');
    expect(items[1].textContent).toContain('· 읽음');
    expect(within(items[1]).queryByRole('button', { name: '읽음' })).toBeNull();
    // 부른 사람의 strong 하나 — 지워진 글은 갈 곳이 없다고 말한다 (FR-506)
    expect(Array.from(items[0].querySelectorAll('strong')).map((s) => s.textContent)).toEqual(['앨리스']);
    expect(within(items[1]).getByText('(지워진 글)')).toBeTruthy();
    expect(container.querySelectorAll('li.card')).toHaveLength(2);
  });

  it('**모두 읽음은 머리에 있고, 누르면 다 읽고 모든 화면의 알림 영역에 알린다** — 다 읽으면 단추가 사라진다', async () => {
    const changed = vi.fn();
    window.addEventListener(NOTIFICATIONS_CHANGED, changed);
    renderPage();
    const all = await screen.findByRole('button', { name: '모두 읽음' });
    expect(all.closest('header')).not.toBeNull();
    fireEvent.click(all);
    expect(await screen.findByText('안 읽은 것 0건')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '모두 읽음' })).toBeNull();
    expect(calls).toContainEqual({ method: 'POST', url: '/api/notifications/read-all' });
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(NOTIFICATIONS_CHANGED, changed);
  });

  it('줄의 읽음을 누르면 그 줄만 읽음이 된다', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '읽음' }));
    expect(await screen.findByText('안 읽은 것 0건')).toBeTruthy();
    expect(calls).toContainEqual({ method: 'POST', url: '/api/notifications/n1/read' });
  });

  it('받기 전에는 수를 말하지 않고, 0건이면 빈 상태다', async () => {
    rows = [];
    renderPage();
    expect(screen.queryByText(/안 읽은 것/)).toBeNull();
    expect(await screen.findByText('알림이 없다.')).toBeTruthy();
    expect(screen.getByText('안 읽은 것 0건')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
