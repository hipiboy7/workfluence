// @vitest-environment happy-dom
import type { MeView, TrashPageView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth';
import { TrashPage } from './TrashPage';

/** 누구인지 화면에 닿았는지 보인다 — 닿기 전의 "부르지 않았다"는 아무것도 증명하지 않는다(병합 전 코드 리뷰 7) */
function MeProbe() {
  const { me } = useAuth();
  return me ? <p data-testid="me">{me.username}</p> : null;
}

/**
 * 컴포넌트 시험 — 휴지통의 **지운 스페이스** 칸 (P4 FR-513 · P15 FR-1630). 관리자와 스페이스 관리 전체를 맡겨 받은 member에게 보이고, 그때만 목록을
 * 부른다 — 위임을 함께 넘겨 판정한다. 되살리기는 묻지 않고 완료 알림띠(`role="status"`)로 알린다(P17 J.5.10 — E2E가 그 역할로 찾는다).
 * 서버는 가짜 `fetch`다
 */

let me: MeView;
let urls: string[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

let trashed: TrashPageView[] = [];
let movedToRoot = false;

beforeEach(() => {
  urls = [];
  trashed = [];
  movedToRoot = false;
  me = { id: 'm1', username: 'kim', displayName: '김', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (init?.method === 'POST' && /^\/api\/trash\/pages\/[^/]+\/restore$/.test(url)) {
      trashed = [];
      return Promise.resolve(json(200, { movedToRoot }));
    }
    if (init?.method === 'POST' && url === '/api/trash/spaces/s1/restore') return Promise.resolve(json(200, {}));
    if (url.startsWith('/api/trash/pages')) return Promise.resolve(json(200, trashed));
    if (url.startsWith('/api/trash/spaces')) return Promise.resolve(json(200, [{ id: 's1', key: 'WFAB1234', name: '지운 팀', deletedAt: '2026-09-28T00:00:00.000Z', createdByName: '주인' }]));
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
        <MeProbe />
        <TrashPage />
      </AuthProvider>
    </MemoryRouter>,
  );

describe('TrashPage — 지운 스페이스 (P15 FR-1630)', () => {
  it('**스페이스 관리 전체를 받은 member에게 보이고 목록을 부른다**', async () => {
    me = { ...me, grants: ['space.oversee'] };
    renderPage();
    expect(await screen.findByRole('region', { name: '지운 스페이스' })).toBeTruthy();
    expect(await screen.findByText('지운 팀')).toBeTruthy();
    expect(urls.some((u) => u.startsWith('/api/trash/spaces'))).toBe(true);
  });

  it('**다른 위임만 받은 member에게는 없고 부르지도 않는다** — 분류 관리·관리자가 건 중지 풀기', async () => {
    me = { ...me, grants: ['category.manage', 'space.unsuspend'] };
    renderPage();
    await screen.findByRole('region', { name: '지운 페이지' });
    // 누구인지 휴지통 화면에 닿은 뒤에 본다 — 같은 문맥이 바뀌면 휴지통도 다시 그려진다
    expect((await screen.findByTestId('me')).textContent).toBe('kim');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('region', { name: '지운 스페이스' })).toBeNull();
    expect(urls.some((u) => u.startsWith('/api/trash/spaces'))).toBe(false);
  });

  it('관리자에게 보인다', async () => {
    me = { ...me, role: 'admin' };
    renderPage();
    expect(await screen.findByRole('region', { name: '지운 스페이스' })).toBeTruthy();
  });
});

describe('TrashPage — 되살리기 (P4 FR-512 · P17 J.6)', () => {
  it('**지운 페이지는 줄 목록이고, 되살리면 완료 알림띠가 알린다** — 묻지 않는다(J.5.10)', async () => {
    trashed = [{ id: 'p1', title: '회의록', spaceId: 's9', spaceName: '운영팀', deletedAt: '2026-09-28T00:00:00.000Z', deletedByName: '김' }];
    renderPage();
    const region = await screen.findByRole('region', { name: '지운 페이지' });
    const item = await within(region).findByRole('listitem');
    expect(item.closest('ul')!.className).toBe('row-list');
    expect(item.textContent).toContain('운영팀');
    const restore = within(item).getByRole('button', { name: '되살리기' });
    expect(restore.className).toBe('subtle');
    fireEvent.click(restore);
    const status = await screen.findByRole('status');
    expect(status.className).toBe('notice success');
    expect(status.textContent).toBe('"회의록"을 되살렸다.');
    expect(await within(region).findByText('되살릴 페이지가 없다.')).toBeTruthy();
  });

  it('제자리로 돌아갈 수 없으면 맨 위로 옮겼다고 말한다', async () => {
    trashed = [{ id: 'p1', title: '회의록', spaceId: 's9', spaceName: '운영팀', deletedAt: '2026-09-28T00:00:00.000Z', deletedByName: '김' }];
    movedToRoot = true;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '되살리기' }));
    expect((await screen.findByRole('status')).textContent).toContain('맨 위로 옮겼다');
  });

  it('지운 스페이스를 되살려도 완료 알림띠가 알린다', async () => {
    me = { ...me, role: 'admin' };
    renderPage();
    const region = await screen.findByRole('region', { name: '지운 스페이스' });
    fireEvent.click(await within(region).findByRole('button', { name: '되살리기' }));
    expect((await screen.findByRole('status')).textContent).toBe('"지운 팀"을 되살렸다. 안에 있던 문서도 함께 다시 보인다.');
  });
});
