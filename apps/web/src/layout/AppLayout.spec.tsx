// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { AppLayout } from './AppLayout';

/**
 * 컴포넌트 시험 — 한 틀의 위 막대와 기본 문맥의 왼쪽 칸 (P17 설계서 J.3.2·J.3.3, FR-1850). 예전에는 홈 한 줄의 메뉴였다 — 그 시험
 * (`SpacesPage.spec`, P15 D.5의 스페이스 관리 메뉴)을 여기로 옮겼다. 주 메뉴(스페이스·검색·LLM 질문·휴지통·관리), 관리 링크(권한에 따라 보임/숨김 —
 * 판정은 서버의 가드와 같은 `can()`이고 위임을 함께 넘긴다), 비밀번호 변경(비밀번호가 있는 계정만), 로그아웃, 한글 역할. 서버는 가짜 `fetch`다
 */

let me: MeView;
let calls: { method: string; url: string }[];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  me = { id: 'm1', username: 'kim', displayName: '김', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url });
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/notifications/unread-count') return Promise.resolve(json(200, { count: 0 }));
    if (method === 'POST' && url === '/api/auth/logout') return Promise.resolve(json(204, undefined));
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
  try {
    window.localStorage.clear();
  } catch {
    // 저장소가 없으면 폭으로만 정한다 — 시험과 무관하다
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderAt = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<p>홈 본문</p>} />
            <Route path="/search" element={<p>검색 본문</p>} />
            <Route path="/admin/*" element={<p>관리 본문</p>} />
          </Route>
          <Route path="/login" element={<p>로그인 화면</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

const texts = (els: HTMLElement[]) => els.map((e) => e.textContent?.trim());

describe('AppLayout — 위 막대 (J.3.2)', () => {
  it('**주 메뉴는 스페이스·검색·LLM 질문·휴지통** — 관리 권한이 없으면 "관리"가 없고, 지금 구역에 `aria-current`', async () => {
    renderAt('/search');
    const nav = await screen.findByRole('navigation', { name: '주 메뉴' });
    const links = within(nav).getAllByRole('link');
    expect(texts(links)).toEqual(['스페이스', '검색', 'LLM 질문', '휴지통']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/', '/search', '/llm', '/trash']);
    expect(within(nav).getByRole('link', { name: '검색' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: '스페이스' }).getAttribute('aria-current')).toBeNull();
    // 관리 묶음도 없다
    expect(screen.queryByRole('navigation', { name: '관리' })).toBeNull();
  });

  it('**관리 권한이 하나라도 있으면 "관리"가 보이고 허용된 첫 관리 화면으로 간다**', async () => {
    me = { ...me, role: 'member', grants: ['category.manage'] };
    renderAt();
    const nav = await screen.findByRole('navigation', { name: '주 메뉴' });
    expect(texts(within(nav).getAllByRole('link'))).toEqual(['스페이스', '검색', 'LLM 질문', '휴지통', '관리']);
    // 분류 관리만 받은 member의 첫 관리 화면은 스페이스 관리다
    expect(within(nav).getByRole('link', { name: '관리' }).getAttribute('href')).toBe('/admin/spaces');
  });

  it('**이름과 한글 역할** — 코드(admin)를 보이지 않는다', async () => {
    me = { ...me, displayName: '홍길동', role: 'admin' };
    renderAt();
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByText(/^홍길동님/).textContent).toBe('홍길동님 (관리자)');
    expect(banner.textContent).not.toMatch(/\badmin\b/);
  });

  it.each([
    ['시스템 관리자', 'root' as const, '시스템 관리자'],
    ['일반 사용자', 'member' as const, '일반 사용자'],
  ])('%s의 역할 글', async (_who, role, shown) => {
    me = { ...me, role };
    renderAt();
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByText(/^김님/).textContent).toBe(`김님 (${shown})`);
  });

  it.each([
    ['비밀번호가 있는 계정', true, true],
    ['사내 계정(비밀번호 없음 — IdP에서 바꾼다, P13 FR-1471)', false, false],
  ])('%s → 비밀번호 변경이 보이는가 %s', async (_who, hasPassword, shown) => {
    me = { ...me, hasPassword };
    renderAt();
    const banner = await screen.findByRole('banner');
    await within(banner).findByRole('button', { name: '로그아웃' });
    const link = within(banner).queryByRole('link', { name: '비밀번호 변경' });
    expect(link !== null).toBe(shown);
    if (link) expect(link.getAttribute('href')).toBe('/change-password');
  });

  it('**로그아웃을 누르면 서버 세션을 끊고 로그인 화면으로 간다**', async () => {
    renderAt();
    const banner = await screen.findByRole('banner');
    fireEvent.click(within(banner).getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByText('로그인 화면')).toBeTruthy();
    expect(calls).toContainEqual({ method: 'POST', url: '/api/auth/logout' });
  });
});

describe('AppLayout — 왼쪽 칸의 관리 링크 (J.3.3 · P15 D.5)', () => {
  it.each([
    ['관리자', { role: 'admin' as const, grants: [] }, true],
    ['스페이스 관리 전체를 받은 member', { role: 'member' as const, grants: ['space.oversee' as const] }, true],
    ['분류 관리를 받은 member', { role: 'member' as const, grants: ['category.manage' as const] }, true],
    ['관리자가 건 중지 풀기만 받은 member', { role: 'member' as const, grants: ['space.unsuspend' as const] }, false],
    ['아무것도 받지 않은 member', { role: 'member' as const, grants: [] }, false],
  ])('%s → 스페이스 관리가 보이는가 %s', async (_who, over, shown) => {
    me = { ...me, ...over };
    renderAt();
    // 누구인지 틀에 닿은 뒤에 본다 — 닿기 전의 "없다"는 아무것도 증명하지 않는다
    await screen.findByRole('navigation', { name: '바로가기' });
    await waitFor(() => expect(screen.queryByRole('link', { name: '스페이스 관리' }) !== null).toBe(shown));
  });

  it.each([
    ['시스템 관리자', { role: 'root' as const, grants: [] }, ['사용자 관리', '감사로그', '스페이스 관리', '운영 설정', 'LLM 연결']],
    ['관리자', { role: 'admin' as const, grants: [] }, ['사용자 관리', '감사로그', '스페이스 관리', '운영 설정']],
    // LLM 연결 관리는 root가 관리자에게 준다 (P11 D.1)
    ['LLM 연결 관리를 받은 관리자', { role: 'admin' as const, grants: ['llm.manage' as const] }, ['사용자 관리', '감사로그', '스페이스 관리', '운영 설정', 'LLM 연결']],
  ])('%s의 관리 링크', async (_who, over, expected) => {
    me = { ...me, ...over };
    renderAt();
    const admin = await screen.findByRole('navigation', { name: '관리' });
    expect(texts(within(admin).getAllByRole('link'))).toEqual(expected);
  });

  it('바로가기는 알림함·내 지시문이다', async () => {
    renderAt();
    const quick = await screen.findByRole('navigation', { name: '바로가기' });
    const links = within(quick).getAllByRole('link');
    expect(texts(links)).toEqual(['알림함', '내 지시문']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/notifications', '/llm/prompts']);
  });
});
