// @vitest-environment happy-dom
import type { MeView } from '@workfluence/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { AuthProvider } from '../auth';
import { PageEditorPage } from './PageEditorPage';

/**
 * 컴포넌트 시험 — 실시간 편집의 **제목 보내기와 저장하고 보기로** (P13 FR-1460·1463, 병합 전 검토). 제목 칸은 동료의 화면에 곧바로 바뀌지
 * 않는다(설계서 A.1-8). 그래서 이 화면이 방에 이미 준 제목을 다시 보내면 동료가 그 뒤에 바꾼 제목을 되돌린다. 입력을 멈추기 전에 떠나면
 * 제목이 가지 않았다. 저장하고 보기로는 화면 문서의 스냅숏(상태 벡터 + 지운 기록)을 싣는다(끊긴 줄 모르는 연결 — P13 D.7).
 * 실시간 편집기(WebSocket)는 가짜로 둔다 — 문서만 실제 Yjs로 만들어 넘긴다. 서버는 가짜 `fetch`다.
 *
 * 화면의 모양(P17 J.6 · FR-1860)도 본다 — 편집 줄(← 보기로 · 연결 상태 · 저장 방식), 편집 줄 아래의 알림띠, 흰 종이 안의 h1 · 제목 · 본문, 왼쪽 칸의
 * 페이지 트리. 실시간 편집을 끈 편집기도 이름("본문")이 있다(J.7). 틀 없이 그리므로 왼쪽 칸은 제자리에 그려진다(`SideSlot`)
 */
vi.mock('../components/CollabEditor', async () => {
  const { useEffect } = await import('react');
  const Yjs = await import('yjs');
  return {
    CollabEditor: ({ onDoc }: { onDoc?: (d: unknown) => void }) => {
      useEffect(() => {
        const d = new Yjs.Doc();
        d.getText('t').insert(0, '화면에서 친 글');
        d.getText('t').delete(0, 2); // 지우기도 했다 — 스냅숏의 지운 기록에 남는다
        onDoc?.(d);
        return () => onDoc?.(null);
      }, [onDoc]);
      return <div>실시간 편집기</div>;
    },
  };
});

const me: MeView = { id: 'u1', username: 'bob', displayName: '밥', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
const doc = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph' }] };
const pageSummary = { id: 'p1', spaceId: 's1', parentId: null, title: '옛 제목', position: 0, currentVersionNo: 3, updatedAt: '2026-09-29T00:00:00Z' };
const space = { id: 's1', key: 'MEET', name: '회의 공간', kind: 'team', memberCount: 2, access: { canWrite: true } };
let flushed: { title?: string; snapshot?: string }[] = [];
let titles: { title: string; keepalive: boolean }[] = [];
let patched: { title: string; baseVersionNo: number }[] = [];
let applied = true;
let collabEnabled = true;
let flushAnswer: { saved: boolean; reason: string } = { saved: true, reason: '' };
let flushDelayMs = 0;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  flushed = [];
  titles = [];
  patched = [];
  applied = true;
  collabEnabled = true;
  flushAnswer = { saved: true, reason: '' };
  flushDelayMs = 0;
  window.localStorage.clear(); // 넓게 보기의 기억 — 시험마다 처음 상태에서
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (url === '/api/auth/config') return Promise.resolve(json(200, { collabEnabled }));
    if (url === '/api/pages/p1' && init?.method === 'PATCH') {
      // REST 저장 — 남이 먼저 저장했다(409). 화면은 덮어쓰지 않고 최신을 불러오게 한다
      patched.push(JSON.parse(String(init.body)) as { title: string; baseVersionNo: number });
      return Promise.resolve(json(409, { message: '다른 사람이 먼저 저장했다', baseVersionNo: 3, currentVersionNo: 4 }));
    }
    if (url === '/api/pages/p1') return Promise.resolve(json(200, { ...pageSummary, content: doc }));
    if (url === '/api/spaces/s1') return Promise.resolve(json(200, space));
    if (url === '/api/pages?spaceId=s1') return Promise.resolve(json(200, [pageSummary]));
    if (url === '/api/pages/p1/collab/flush') {
      flushed.push(JSON.parse(String(init?.body)) as { title?: string; snapshot?: string });
      const answer = json(201, { ...flushAnswer, unchanged: false, currentVersionNo: 4 });
      return new Promise((r) => setTimeout(() => r(answer), flushDelayMs));
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
/** 창을 닫거나 새로 고치려 한다 — 화면이 막으면(묻는다) 참 */
const leaving = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
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

  it('**화면 문서의 스냅숏을 싣는다 — 넣은 것과 지운 것** — 서버가 그만큼 받았는지 본다 (P13 D.7, 좁은 자체 점검 2)', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    save();
    await waitFor(() => expect(flushed).toHaveLength(1));
    expect(flushed[0]).not.toHaveProperty('sv');
    const snap = Y.decodeSnapshot(Uint8Array.from(atob(flushed[0].snapshot!), (c) => c.charCodeAt(0)));
    expect([...snap.sv.values()]).toEqual(['화면에서 친 글'.length]); // 가짜 편집기가 친 글자 수만큼
    // 지운 두 글자 — 상태 벡터만으로는 보이지 않는다
    expect([...snap.ds.clients.values()].flat().map(({ clock, len }) => [clock, len])).toEqual([[0, 2]]);
  });

  it('**제목을 실어 보내면 기다리던 타이머를 끈다** — 저장이 1초를 넘겨도 같은 제목이 또 가지 않는다 (좁은 자체 점검 4)', async () => {
    flushDelayMs = 1500;
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(titleBox(), { target: { value: '저장이 싣는 제목' } });
    save();
    await waitFor(() => expect(flushed).toHaveLength(1));
    expect(flushed[0].title).toBe('저장이 싣는 제목');
    await new Promise((r) => setTimeout(r, 1300)); // 타이머(1초)가 울릴 때를 지난다
    expect(titles).toEqual([]);
    await screen.findByText('보기 화면', undefined, { timeout: 3000 });
    expect(titles).toEqual([]); // 떠날 때도 다시 보내지 않는다 — 저장이 실었다
  });

  it('**저장되지 않았으면 실었던 제목을 다시 기다린다** — 서버는 제목을 적용하기 전에 답한다. 떠날 때 보낸다 (좁은 자체 점검 4)', async () => {
    flushAnswer = { saved: false, reason: '이 화면의 입력이 아직 서버에 닿지 않았다' };
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(titleBox(), { target: { value: '저장되지 않은 제목' } });
    save();
    await screen.findByText(/저장되지 않았다: 이 화면의 입력이/);
    expect(titles).toEqual([]);
    fireEvent.click(screen.getByRole('link', { name: '← 보기로' }));
    await screen.findByText('보기 화면');
    await waitFor(() => expect(titles).toEqual([{ title: '저장되지 않은 제목', keepalive: true }]));
  });
});

describe('PageEditorPage — 편집 화면의 모양 (P17 J.6 · FR-1860)', () => {
  it('편집 줄에 **← 보기로** · 연결 상태 · 저장 방식과 주 단추, 흰 종이 안에 빵부스러기 · h1 하나 · 제목, 왼쪽 칸에 페이지 트리', async () => {
    const { container } = renderPage();
    await screen.findByText('실시간 편집기');
    const bar = container.querySelector<HTMLElement>('.edit-canvas > .edit-bar')!;
    expect(bar).not.toBeNull();
    expect(within(bar).getByRole('link', { name: '← 보기로' }).getAttribute('href')).toBe('/pages/p1');
    // 가짜 편집기는 연결 상태를 알리지 않는다 — 처음 상태 그대로
    expect(within(bar).getByRole('status').textContent).toBe('연결 중…');
    expect(within(bar).getByText('쓰는 대로 자동으로 저장된다')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '저장하고 보기로' }).className).toBe('primary');

    const paper = container.querySelector<HTMLElement>('.edit-canvas > .paper')!;
    expect(paper.className).toBe('paper');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['페이지 편집']);
    expect(paper.contains(titleBox())).toBe(true);
    expect(titleBox().className).toBe('title-input');
    const crumbs = await within(paper).findByRole('navigation', { name: '현재 위치' });
    expect(within(crumbs).getByRole('link', { name: '회의 공간' }).getAttribute('href')).toBe('/spaces/s1');
    expect(within(crumbs).getByText('옛 제목').getAttribute('aria-current')).toBe('page');

    const tree = await screen.findByRole('list', { name: '페이지 트리' });
    expect(within(tree).getByRole('link', { name: '옛 제목' }).getAttribute('aria-current')).toBe('page');

    // 넓게 보기는 보기 화면과 같은 값이다 — 종이가 넓어진다
    fireEvent.click(within(bar).getByRole('button', { name: '넓게 보기' }));
    expect(paper.className).toBe('paper wide');
    expect(window.localStorage.getItem('wf:read-wide')).toBe('1');
  });

  it('**실시간 편집을 끈 편집기도 이름이 있다** — 보이는 라벨 "본문"이 그 이름이다(label htmlFor는 편집기의 div를 가리킬 수 없다, J.7)', async () => {
    collabEnabled = false;
    renderPage();
    const box = await screen.findByRole('textbox', { name: '본문' });
    expect(box.getAttribute('aria-labelledby')).toBe(screen.getByText('본문', { selector: 'label' }).id);
    expect(box.hasAttribute('aria-label')).toBe(false);
    expect(screen.getByText('편집을 시작한 버전: v3')).toBeTruthy();
    expect(screen.queryByText('쓰는 대로 자동으로 저장된다')).toBeNull();
  });

  it('**실시간 편집을 끈 화면은 저장하지 않은 편집이 있으면 창을 닫기 전에 묻는다** — 고치지 않았거나 되돌렸으면 묻지 않는다 (병합 전 검토 18)', async () => {
    collabEnabled = false;
    renderPage();
    const box = await screen.findByRole('textbox', { name: '본문' });
    // 처음 그린 편집기가 불러온 본문을 넣는 것은 고친 것이 아니다
    expect(leaving()).toBe(false);
    fireEvent.change(titleBox(), { target: { value: '고친 제목' } });
    expect(leaving()).toBe(true);
    fireEvent.change(titleBox(), { target: { value: '옛 제목' } });
    expect(leaving()).toBe(false);
    // 본문을 고친다 — 편집기의 입력과 같은 길(편집기가 알린다)
    await act(async () => {
      (box as HTMLElement & { editor: { commands: { insertContent: (t: string) => void } } }).editor.commands.insertContent('새 글');
    });
    expect(leaving()).toBe(true);
  });

  it('**다른 페이지의 편집으로 곧바로 옮기면 앞 페이지의 제목·고친 표시를 들고 가지 않는다** — 새 페이지를 읽는 동안은 불러오는 중이다 (병합 전 검토 14)', async () => {
    collabEnabled = false;
    let answerP2: (r: Response) => void = () => undefined;
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      if (String(input) === '/api/pages/p2') return new Promise<Response>((r) => (answerP2 = r));
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    function Go() {
      const nav = useNavigate();
      return (
        <button type="button" onClick={() => void nav('/pages/p2/edit')}>
          다른 편집으로
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={['/pages/p1/edit']}>
        <AuthProvider>
          <Go />
          <Routes>
            <Route path="/pages/:id/edit" element={<PageEditorPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('textbox', { name: '본문' });
    fireEvent.change(titleBox(), { target: { value: '고친 제목' } });
    expect(leaving()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '다른 편집으로' }));
    // 둘째 페이지의 응답이 오기 전 — 앞 페이지의 제목 칸이 남아 있으면 그것을 고쳐 둘째 페이지로 저장하게 된다
    await waitFor(() => expect(screen.queryByLabelText('제목')).toBeNull());
    expect(leaving()).toBe(false);
    await act(async () => {
      answerP2(json(200, { ...pageSummary, id: 'p2', title: '둘째 문서', currentVersionNo: 1, content: doc }));
    });
    await waitFor(() => expect(titleBox().value).toBe('둘째 문서'));
    expect(screen.getByText('편집을 시작한 버전: v1')).toBeTruthy();
    expect(leaving()).toBe(false);
  });

  it('실시간 편집 화면은 묻지 않는다 — 서버가 쓰는 대로 저장한다', async () => {
    renderPage();
    await screen.findByText('실시간 편집기');
    fireEvent.change(titleBox(), { target: { value: '고친 제목' } });
    expect(leaving()).toBe(false);
  });

  it('REST 저장이 409면 편집 줄 아래 알림띠가 말하고 **덮어쓰기 단추 없이** 최신 내용 불러오기만 둔다 — 저장은 막힌다 (FR-343)', async () => {
    collabEnabled = false;
    const { container } = renderPage();
    await screen.findByRole('textbox', { name: '본문' });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    const alert = await screen.findByRole('alert');
    expect(patched).toEqual([expect.objectContaining({ title: '옛 제목', baseVersionNo: 3 })]);
    expect(alert.className).toBe('notice error');
    // 편집 줄 바로 아래, 종이 위
    expect(alert.previousElementSibling).toBe(container.querySelector('.edit-bar'));
    expect(alert.textContent).toContain('다른 사람이 먼저 저장했다');
    expect(alert.textContent).toContain('내가 편집을 시작한 버전 v3 · 현재 서버 버전 v4');
    expect(within(alert).getAllByRole('button').map((b) => b.textContent)).toEqual(['최신 내용 불러오기']);
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
