// @vitest-environment happy-dom
import type { MeView, PageSummary, PageView, SpaceView } from '@workfluence/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth';
import { TREE_CHANGED } from '../layout/SpaceSideNav';
import { PageViewPage } from './PageViewPage';

/**
 * 컴포넌트 시험 — 페이지 보기의 **하위 페이지 만들기**·**옮기기** (P14_설계서_Spaces D.2, FR-1500·1501·1505). 쓸 수 있는 사람에게만 보인다 — 보이는
 * 조건은 응답의 `access`다(P2 FR-345). 그리고 P17의 모양(설계서 J.3.5·J.6) — 머리 줄의 빵부스러기(스페이스 / 상위 페이지 / 페이지)와 조치, 글 칸의
 * 메타·넓게 보기, 탭 제목. 본문 편집기와 아래 칸들(라벨·첨부·댓글·복사)은 이 시험의 대상이 아니라 가짜로 둔다. 왼쪽 칸(페이지 트리)은 진짜다 — 틀 없이
 * 그리면 제자리에 그린다. 서버는 가짜 `fetch`다
 */
vi.mock('../components/Editor', () => ({ Editor: () => <div>본문</div>, EMPTY_DOC: { type: 'doc', content: [] } }));
vi.mock('../components/Labels', () => ({ Labels: () => null }));
vi.mock('../components/Attachments', () => ({ Attachments: () => null }));
vi.mock('../components/Comments', () => ({ Comments: () => null }));
vi.mock('../components/CopyButtons', () => ({ CopyButtons: () => null }));
vi.mock('../components/TemplateFromPage', () => ({ TemplateFromPage: () => null }));
vi.mock('../components/MovePage', () => ({ MovePage: () => <section aria-label="페이지 옮기기">옮기기 칸</section> }));

const me: MeView = { id: 'u1', username: 'kim', displayName: '김', role: 'member', mustChangePassword: false, grants: [], hasPassword: true };
let page: PageView;
const basePage: PageView = {
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
const summary = (id: string, parentId: string | null, title: string): PageSummary => ({
  id,
  spaceId: 's1',
  parentId,
  title,
  position: 0,
  currentVersionNo: 1,
  updatedAt: '2026-09-27T00:00:00.000Z',
});
let tree: PageSummary[] = [];
let canWrite = true;
let pageStatus = 200;
type Call = { method: string; url: string };
let calls: Call[] = [];
const space = (): SpaceView =>
  ({
    id: 's1',
    name: '운영팀',
    key: 'OPS',
    kind: 'team',
    memberCount: 2,
    access: { canRead: true, canWrite, canManageMembers: false, canChangeStatus: false, canDelete: false, isOwner: false },
  }) as SpaceView;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  canWrite = true;
  pageStatus = 200;
  page = basePage;
  tree = [summary('p1', null, '회의록')];
  calls = [];
  window.localStorage.clear();
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url === '/api/auth/me') return Promise.resolve(json(200, me));
    if (method === 'DELETE' && url === '/api/pages/p1') return Promise.resolve(json(200, { ok: true }));
    if (url === '/api/pages/p1') return Promise.resolve(pageStatus === 200 ? json(200, page) : json(pageStatus, { message: '페이지를 찾을 수 없다' }));
    if (url === '/api/spaces/s1') return Promise.resolve(json(200, space()));
    if (url === '/api/pages?spaceId=s1') return Promise.resolve(json(200, tree));
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
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
          <Route path="/spaces/:id" element={<p>스페이스 화면</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
/** 머리 줄의 빵부스러기 — 스페이스를 읽은 뒤에 그려진다 */
const crumbs = async () => within(await screen.findByRole('navigation', { name: '현재 위치' }));

describe('PageViewPage — 하위 페이지 만들기·옮기기 (FR-1505)', () => {
  it('**쓸 수 있으면 보인다** — 하위 페이지 만들기는 그 스페이스의 새 페이지 칸으로 부모를 싣고 간다. 옮기기는 칸을 연다', async () => {
    renderPage();
    const child = await screen.findByRole('link', { name: '하위 페이지 만들기' });
    expect(child.getAttribute('href')).toBe('/spaces/s1?parent=p1#new-page');
    const toggle = screen.getByRole('button', { name: '옮기기' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: '페이지 옮기기' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: '페이지 옮기기' })).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    expect(screen.queryByRole('region', { name: '페이지 옮기기' })).toBeNull();
  });

  it('**쓸 수 없으면 없다** — viewer·중지된 스페이스', async () => {
    canWrite = false;
    renderPage();
    await screen.findByRole('heading', { name: '회의록' });
    await screen.findByText(/버전 2/);
    // 스페이스를 읽은 뒤에도 없다
    expect((await crumbs()).getByRole('link', { name: '운영팀' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '하위 페이지 만들기' })).toBeNull();
    expect(screen.queryByRole('button', { name: '옮기기' })).toBeNull();
    expect(screen.queryByRole('link', { name: '편집' })).toBeNull();
    expect(screen.queryByRole('button', { name: '삭제' })).toBeNull();
  });
});

describe('PageViewPage — 머리 줄과 글 칸 (P17 J.3.5·J.6)', () => {
  it('**머리 줄의 조치** — 편집은 주 단추 모양의 링크, 삭제는 위험 단추. 순서는 편집 · 하위 페이지 만들기 · 옮기기 · 삭제', async () => {
    renderPage();
    const edit = await screen.findByRole('link', { name: '편집' });
    expect(edit.getAttribute('href')).toBe('/pages/p1/edit');
    expect(edit.className).toBe('btn primary');
    expect(screen.getByRole('button', { name: '삭제' }).className).toBe('danger');
    const actions = edit.parentElement!;
    expect([...actions.children].map((el) => el.textContent)).toEqual(['편집', '하위 페이지 만들기', '옮기기', '삭제']);
  });

  it('**빵부스러기는 스페이스 / 상위 페이지들 / 지금 페이지** — 지금 페이지는 링크가 아닌 글이다', async () => {
    page = { ...basePage, parentId: 'p2' };
    tree = [summary('p0', null, '문서'), summary('p2', 'p0', '회의'), summary('p1', 'p2', '회의록')];
    renderPage();
    const nav = await crumbs();
    const links = nav.getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['운영팀', '/spaces/s1'],
      ['문서', '/pages/p0'],
      ['회의', '/pages/p2'],
    ]);
    const current = nav.getByText('회의록');
    expect(current.tagName).toBe('SPAN');
    expect(current.getAttribute('aria-current')).toBe('page');
    // 제목(heading)은 글 칸의 h1 하나다 — 왼쪽 칸의 트리는 같은 이름을 링크로만 둔다
    expect(screen.getAllByRole('heading', { name: '회의록' })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('회의록');
  });

  it('트리를 읽지 못하면 빵부스러기는 스페이스 / 페이지만이다 — 페이지는 그대로 보인다', async () => {
    page = { ...basePage, parentId: 'p2' };
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) =>
      String(input) === '/api/pages?spaceId=s1' ? Promise.resolve(json(500, { message: '고장' })) : base(input as RequestInfo, init),
    ) as unknown as typeof fetch;
    renderPage();
    const nav = await crumbs();
    expect(nav.getAllByRole('link').map((a) => a.textContent)).toEqual(['운영팀']);
    expect(nav.getByText('회의록').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: '회의록' })).toBeTruthy();
  });

  it('**메타는 "버전 N · 시각 · 이력" 한 줄이고 버전은 한 곳에만 보인다**. 탭 제목은 페이지 제목', async () => {
    renderPage();
    const meta = (await screen.findByText(/버전 2/)).closest('p')!;
    expect(screen.getAllByText(/버전 2/)).toHaveLength(1);
    expect(meta.className).toBe('doc-meta');
    expect(within(meta).getByRole('link', { name: '이력' }).getAttribute('href')).toBe('/pages/p1/history');
    expect(meta.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-27T00:00:00.000Z');
    await waitFor(() => expect(document.title).toBe('회의록 - 스페이스 - workfluence'));
  });

  it('**넓게 보기** — 누르면 글 칸이 넓어지고 눌린 상태를 말한다. 브라우저가 기억한다', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: '넓게 보기' });
    const doc = screen.getByRole('heading', { level: 1 }).parentElement!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(doc.className).toBe('doc');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(doc.className).toBe('doc wide');
    expect(window.localStorage.getItem('wf:read-wide')).toBe('1');
    // 내보내기는 평범한 링크다 (FR-730)
    const exportLink = screen.getByRole('link', { name: 'HTML로 내보내기' });
    expect(exportLink.getAttribute('href')).toBe('/api/pages/p1/export');
    expect(exportLink.hasAttribute('download')).toBe(true);
  });

  it('**삭제는 묻지 않고 지운 뒤 스페이스로 간다** — 휴지통에서 되살린다(J.5.10). 왼쪽 칸에 트리가 바뀌었다고 알린다', async () => {
    const changed = vi.fn();
    const onChanged = (e: Event) => changed((e as CustomEvent<string>).detail);
    window.addEventListener(TREE_CHANGED, onChanged);
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
      expect(await screen.findByText('스페이스 화면')).toBeTruthy();
      expect(document.querySelector('dialog')).toBeNull();
      expect(calls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', url: '/api/pages/p1' }]);
      expect(changed).toHaveBeenCalledWith('s1');
    } finally {
      window.removeEventListener(TREE_CHANGED, onChanged);
    }
  });

  it('**트리로 다른 페이지로 가는 사이 앞 페이지의 제목·조치를 보이지 않는다** — 삭제가 옛 제목을 보인 채 새 페이지로 가지 않고, 트리의 접음은 남는다 (병합 전 검토 14)', async () => {
    tree = [summary('p1', null, '회의록'), summary('p2', null, '주간 보고'), summary('p3', 'p2', '월요일')];
    const second: PageView = { ...basePage, id: 'p2', title: '주간 보고', currentVersionNo: 5 };
    let answer: (r: Response) => void = () => undefined;
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/pages/p2') {
        calls.push({ method, url });
        if (method === 'DELETE') return Promise.resolve(json(200, { ok: true }));
        // 둘째 페이지의 응답은 시험이 보낼 때까지 오지 않는다
        return new Promise<Response>((r) => (answer = r));
      }
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    renderPage();
    await screen.findByRole('heading', { level: 1, name: '회의록' });
    // 트리의 "주간 보고" 가지를 접어 둔다 — 페이지를 옮겨도 그대로여야 한다
    fireEvent.click(screen.getByRole('button', { name: '주간 보고 접기' }));
    expect(screen.queryByRole('link', { name: '월요일' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: '주간 보고' }));
    // 응답을 기다리는 동안 — 앞 페이지의 제목·조치·본문이 없다. 불러오는 중이다
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: '회의록' })).toBeNull());
    expect(screen.queryByRole('button', { name: '삭제' })).toBeNull();
    expect(screen.queryByRole('link', { name: '편집' })).toBeNull();
    expect(screen.getByText('불러오는 중…')).toBeTruthy();
    // 왼쪽 칸은 그대로다 — 접은 가지가 접힌 채이고 지금 페이지는 새 주소의 것이다
    expect(screen.getByRole('button', { name: '주간 보고 펼치기' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('link', { name: '주간 보고' }).getAttribute('aria-current')).toBe('page');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    await act(async () => {
      answer(json(200, second));
    });
    expect(await screen.findByRole('heading', { level: 1, name: '주간 보고' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    expect(await screen.findByText('스페이스 화면')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', url: '/api/pages/p2' }]);
  });

  it('**열지 못하면 까닭을 알림띠로 말한다** — 흩어진 "← 목록" 링크는 없다(위 막대가 있다)', async () => {
    pageStatus = 404;
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: '페이지를 열 수 없다' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('페이지를 찾을 수 없다');
    expect(screen.queryByRole('link', { name: /목록/ })).toBeNull();
  });
});
