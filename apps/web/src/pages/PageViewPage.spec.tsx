// @vitest-environment happy-dom
import type { MeView, PageView, SpaceView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { PageViewPage } from './PageViewPage';

/**
 * 컴포넌트 시험 — 페이지 보기의 **하위 페이지 만들기**·**옮기기** (P14_설계서_Spaces D.2, FR-1500·1501·1505). 쓸 수 있는 사람에게만 보인다 — 보이는
 * 조건은 응답의 `access`다(P2 FR-345). 본문 편집기와 아래 칸들(라벨·첨부·댓글·복사)은 이 시험의 대상이 아니라 가짜로 둔다. 서버는 가짜 `fetch`다
 */
vi.mock('../components/Editor', () => ({ Editor: () => <div>본문</div>, EMPTY_DOC: { type: 'doc', content: [] } }));
vi.mock('../components/Labels', () => ({ Labels: () => null }));
vi.mock('../components/Attachments', () => ({ Attachments: () => null }));
vi.mock('../components/Comments', () => ({ Comments: () => null }));
vi.mock('../components/CopyButtons', () => ({ CopyButtons: () => null }));
vi.mock('../components/TemplateFromPage', () => ({ TemplateFromPage: () => null }));
vi.mock('../components/MovePage', () => ({ MovePage: () => <section aria-label="페이지 옮기기">옮기기 칸</section> }));

const me: MeView = { id: 'u1', username: 'kim', displayName: '김', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
const page: PageView = {
  id: 'p1',
  spaceId: 's1',
  parentId: null,
  title: '회의록',
  position: 0,
  currentVersionNo: 2,
  updatedAt: '2026-09-27T00:00:00.000Z',
  content: { type: 'doc', content: [] },
  createdBy: 'u1',
  updatedBy: 'u1',
  createdAt: '2026-09-27T00:00:00.000Z',
} as PageView;
let canWrite = true;
const space = (): SpaceView =>
  ({
    id: 's1',
    name: '운영팀',
    access: { canRead: true, canWrite, canManageMembers: false, canChangeStatus: false, canDelete: false, isOwner: false },
  }) as SpaceView;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  canWrite = true;
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/pages/p1') return Promise.resolve(json(200, page));
    if (url === '/api/spaces/s1') return Promise.resolve(json(200, space()));
    return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/pages/p1']}>
      <AuthProvider>
        <Routes>
          <Route path="/pages/:id" element={<PageViewPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

describe('PageViewPage — 하위 페이지 만들기·옮기기 (FR-1505)', () => {
  it('**쓸 수 있으면 보인다** — 하위 페이지 만들기는 그 스페이스의 새 페이지 칸으로 부모를 싣고 간다. 옮기기는 칸을 연다', async () => {
    renderPage();
    const child = await screen.findByRole('link', { name: '하위 페이지 만들기' });
    expect(child.getAttribute('href')).toBe('/spaces/s1?parent=p1#new-page');
    expect(screen.queryByRole('region', { name: '페이지 옮기기' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    expect(screen.getByRole('region', { name: '페이지 옮기기' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    expect(screen.queryByRole('region', { name: '페이지 옮기기' })).toBeNull();
  });

  it('**쓸 수 없으면 없다** — viewer·중지된 스페이스', async () => {
    canWrite = false;
    renderPage();
    await screen.findByRole('heading', { name: '회의록' });
    await screen.findByText(/버전 2/);
    // 스페이스를 읽은 뒤에도 없다
    await screen.findByRole('link', { name: '← 운영팀' });
    expect(screen.queryByRole('link', { name: '하위 페이지 만들기' })).toBeNull();
    expect(screen.queryByRole('button', { name: '옮기기' })).toBeNull();
    expect(screen.queryByRole('link', { name: '편집' })).toBeNull();
  });
});
