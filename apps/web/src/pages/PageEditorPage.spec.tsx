// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { AuthProvider } from '../auth';
import { PageEditorPage } from './PageEditorPage';

/**
 * 컴포넌트 시험 — 실시간 편집의 **제목 보내기와 저장하고 보기로** (P13 FR-1460·1463, 병합 전 검토). 제목 칸은 동료의 화면에 곧바로 바뀌지
 * 않는다(설계서 A.1-8). 그래서 이 화면이 방에 이미 준 제목을 다시 보내면 동료가 그 뒤에 바꾼 제목을 되돌린다. 입력을 멈추기 전에 떠나면
 * 제목이 가지 않았다. 저장하고 보기로는 화면 문서의 상태 벡터를 싣는다(끊긴 줄 모르는 연결).
 * 실시간 편집기(WebSocket)는 가짜로 둔다 — 문서만 실제 Yjs로 만들어 넘긴다. 서버는 가짜 `fetch`다
 */
vi.mock('../components/CollabEditor', async () => {
  const { useEffect } = await import('react');
  const Yjs = await import('yjs');
  return {
    CollabEditor: ({ onDoc }: { onDoc?: (d: unknown) => void }) => {
      useEffect(() => {
        const d = new Yjs.Doc();
        d.getText('t').insert(0, '화면에서 친 글');
        onDoc?.(d);
        return () => onDoc?.(null);
      }, [onDoc]);
      return <div>실시간 편집기</div>;
    },
  };
});

const me: MeView = { id: 'u1', username: 'bob', displayName: '밥', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
const doc = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph' }] };
let flushed: { title?: string; sv?: string }[] = [];
let titles: { title: string; keepalive: boolean }[] = [];
let applied = true;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  flushed = [];
  titles = [];
  applied = true;
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/auth/config') return Promise.resolve(json(200, { collabEnabled: true }));
    if (url === '/api/pages/p1') return Promise.resolve(json(200, { id: 'p1', title: '옛 제목', content: doc, currentVersionNo: 3 }));
    if (url === '/api/pages/p1/collab/flush') {
      flushed.push(JSON.parse(String(init?.body)) as { title?: string; sv?: string });
      return Promise.resolve(json(201, { saved: true, reason: '', unchanged: false, currentVersionNo: 4 }));
    }
    if (url === '/api/pages/p1/collab/title') {
      titles.push({ title: (JSON.parse(String(init?.body)) as { title: string }).title, keepalive: init?.keepalive === true });
      return Promise.resolve(json(201, { applied }));
    }
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
const titleBox = () => screen.getByLabelText('제목') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: '저장하고 보기로' }));

describe('PageEditorPage — 실시간 편집의 저장하고 보기로', () => {
  it('**제목을 고치지 않았으면 보내지 않는다** — 동료가 먼저 바꾼 새 제목을 이 화면의 옛 제목으로 되돌리지 않게', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    expect(titleBox().value).toBe('옛 제목');
    save();
    await screen.findByText('보기 화면');
    expect(flushed).toHaveLength(1);
    expect(flushed[0].title).toBeUndefined();
  });

  it('고쳤는데 아직 방에 가지 않았으면 보낸다', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(titleBox(), { target: { value: '내가 고친 제목' } });
    save();
    await waitFor(() => expect(flushed).toHaveLength(1));
    expect(flushed[0].title).toBe('내가 고친 제목');
  });

  it('**한 번 고쳐 방이 받은 뒤에는 다시 보내지 않는다** — 그 뒤 동료가 바꾼 제목을 되돌리지 않게 (병합 전 검토 — 코드 리뷰 3·자체 점검 2)', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(titleBox(), { target: { value: '방이 받은 제목' } });
    await waitFor(() => expect(titles).toEqual([{ title: '방이 받은 제목', keepalive: false }]), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 20)); // 방이 받았다는 답을 읽을 틈
    save();
    await waitFor(() => expect(flushed).toHaveLength(1));
    expect(flushed[0].title).toBeUndefined();
  });

  it('**방이 받지 못했으면 보낸 것으로 치지 않는다** — 저장하고 보기로가 싣는다', async () => {
    applied = false;
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(titleBox(), { target: { value: '받을 곳이 없던 제목' } });
    await waitFor(() => expect(titles).toHaveLength(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 20));
    save();
    await waitFor(() => expect(flushed).toHaveLength(1));
    expect(flushed[0].title).toBe('받을 곳이 없던 제목');
  });

  it('**입력을 멈추기 전에 떠나도 제목을 보낸다** — 창을 닫아도 가도록 keepalive (병합 전 코드 리뷰 4)', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(titleBox(), { target: { value: '떠나기 직전에 친 제목' } });
    fireEvent.click(screen.getByRole('link', { name: '← 보기로' }));
    await screen.findByText('보기 화면');
    await waitFor(() => expect(titles).toEqual([{ title: '떠나기 직전에 친 제목', keepalive: true }]));
  });

  it('**화면 문서의 상태 벡터를 싣는다** — 서버가 그만큼 받았는지 본다 (병합 전 자체 점검 8)', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    save();
    await waitFor(() => expect(flushed).toHaveLength(1));
    const sv = Y.decodeStateVector(Uint8Array.from(atob(flushed[0].sv!), (c) => c.charCodeAt(0)));
    expect([...sv.values()]).toEqual(['화면에서 친 글'.length]); // 가짜 편집기가 친 글자 수만큼
  });
});
