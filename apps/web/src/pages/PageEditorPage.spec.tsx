// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { PageEditorPage } from './PageEditorPage';

/**
 * 컴포넌트 시험 — 실시간 편집의 **저장하고 보기로가 보내는 제목** (P13 검토, FR-1460). 제목 칸은 동료의 화면에 곧바로 바뀌지 않는다
 * (설계서 A.1-8). 그래서 이 화면에서 고치지 않은 제목까지 보내면 동료가 먼저 바꾼 새 제목을 옛 제목으로 되돌린다.
 * 실시간 편집기(WebSocket·Yjs)는 가짜로 둔다 — 여기서 보는 것은 화면의 분기다. 서버는 가짜 `fetch`다
 */
vi.mock('../components/CollabEditor', () => ({ CollabEditor: () => <div>실시간 편집기</div> }));

const me: MeView = { id: 'u1', username: 'bob', displayName: '밥', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
const doc = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph' }] };
let flushed: unknown[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  flushed = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/auth/config') return Promise.resolve(json(200, { collabEnabled: true }));
    if (url === '/api/pages/p1') return Promise.resolve(json(200, { id: 'p1', title: '옛 제목', content: doc, currentVersionNo: 3 }));
    if (url === '/api/pages/p1/collab/flush') {
      flushed.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json(201, { saved: true, reason: '', currentVersionNo: 4 }));
    }
    if (url === '/api/pages/p1/collab/title') return Promise.resolve(json(201, { applied: true }));
    return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/pages/p1/edit']}>
      <AuthProvider>
        <Routes>
          <Route path="/pages/:id/edit" element={<PageEditorPage />} />
          <Route path="/pages/:id" element={<p>보기 화면</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

describe('PageEditorPage — 실시간 편집의 저장하고 보기로', () => {
  it('**제목을 고치지 않았으면 보내지 않는다** — 동료가 먼저 바꾼 새 제목을 이 화면의 옛 제목으로 되돌리지 않게', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    expect((screen.getByLabelText('제목') as HTMLInputElement).value).toBe('옛 제목');
    fireEvent.click(screen.getByRole('button', { name: '저장하고 보기로' }));
    await screen.findByText('보기 화면');
    expect(flushed).toEqual([{}]);
  });

  it('고쳤으면 보낸다', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '내가 고친 제목' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하고 보기로' }));
    await waitFor(() => expect(flushed).toEqual([{ title: '내가 고친 제목' }]));
  });
});
