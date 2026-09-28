// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { cleanup, render, screen } from '@testing-library/react';
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
 * 부른다 — 위임을 함께 넘겨 판정한다. 서버는 가짜 `fetch`다
 */

let me: MeView;
let urls: string[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  urls = [];
  me = { id: 'm1', username: 'kim', displayName: '김', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url.startsWith('/api/trash/pages')) return Promise.resolve(json(200, []));
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
