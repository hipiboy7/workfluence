// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHistoryPage } from './PageHistoryPage';

/**
 * 컴포넌트 시험 — 버전 이력의 모양 (P17 J.6 · J.3.7). 머리에 빵부스러기(스페이스 / 페이지)와 **← 보기로**, 도구 줄(비교하기) 바로 아래 **한 자리**에
 * 비교 결과나 미리보기, 그 아래 버전 목록(`.row-list` — 줄 글이 "v1"로 시작한다, E2E가 그것으로 줄을 찾는다). 복원은 묻지 않는다 — 새 버전을
 * 더할 뿐이다(J.5.10). 틀 없이 그리므로 왼쪽 칸은 제자리에 그려진다(`SideSlot`). 서버는 가짜 `fetch`다
 */
const doc = (text: string) => ({ type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const pageSummary = { id: 'p1', spaceId: 's1', parentId: null, title: '회의록', position: 0, currentVersionNo: 2, updatedAt: '2026-09-29T00:00:00Z' };
const versions = [
  { versionNo: 2, title: '회의록', createdBy: 'u1', createdByName: '밥', createdAt: '2026-09-29T01:00:00Z' },
  { versionNo: 1, title: '회의록', createdBy: 'u1', createdByName: '밥', createdAt: '2026-09-29T00:00:00Z' },
];
let canWrite = true;
let restored: string[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  canWrite = true;
  restored = [];
  window.localStorage.clear();
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/pages/p1/versions') return Promise.resolve(json(200, versions));
    if (url === '/api/pages/p1') return Promise.resolve(json(200, { ...pageSummary, content: doc('둘째') }));
    if (url === '/api/spaces/s1')
      return Promise.resolve(json(200, { id: 's1', key: 'MEET', name: '회의 공간', kind: 'team', memberCount: 2, access: { canWrite } }));
    if (url === '/api/pages?spaceId=s1') return Promise.resolve(json(200, [pageSummary]));
    if (url === '/api/pages/p1/versions/1/diff/2')
      return Promise.resolve(
        json(200, {
          from: { versionNo: 1, title: '회의록', createdByName: '밥', createdAt: versions[1].createdAt },
          to: { versionNo: 2, title: '회의록', createdByName: '밥', createdAt: versions[0].createdAt },
          titleChanged: false,
          diff: { changed: true, modified: 0, added: 1, removed: 0, blocks: [{ kind: 'added', after: '더한 문단' }] },
        }),
      );
    if (url === '/api/pages/p1/versions/1') return Promise.resolve(json(200, { ...versions[1], content: doc('첫째 본문') }));
    if (url === '/api/pages/p1/versions/1/restore' && init?.method === 'POST') {
      restored.push(url);
      return Promise.resolve(json(201, { ...pageSummary, currentVersionNo: 3 }));
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
    <MemoryRouter initialEntries={['/pages/p1/history']}>
      <Routes>
        <Route path="/pages/:id/history" element={<PageHistoryPage />} />
        <Route path="/pages/:id" element={<p>보기 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
const list = () => screen.getByRole('list', { name: '버전 목록' });
const row = (no: number) => within(list()).getAllByRole('listitem').find((li) => li.textContent?.startsWith(`v${no} `))!;

describe('PageHistoryPage', () => {
  it('머리에 빵부스러기(스페이스 / 페이지) · h1 하나 · **← 보기로**, 줄은 "v{n}"으로 시작하고 비교 체크 · 보기 · 이 버전으로 복원', async () => {
    renderPage();
    await screen.findByRole('list', { name: '버전 목록' });
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['버전 이력']);
    const crumbs = await screen.findByRole('navigation', { name: '현재 위치' });
    expect(within(crumbs).getByRole('link', { name: '회의 공간' }).getAttribute('href')).toBe('/spaces/s1');
    expect(within(crumbs).getByText('회의록').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: '← 보기로' }).getAttribute('href')).toBe('/pages/p1');

    expect(list().className).toBe('row-list');
    expect(within(list()).getAllByRole('listitem').map((li) => /^v\d+/.exec(li.textContent ?? '')?.[0])).toEqual(['v2', 'v1']);
    const one = row(1);
    expect(within(one).getByRole('checkbox', { name: '비교' })).toBeTruthy();
    expect(within(one).getByRole('button', { name: '보기' })).toBeTruthy();
    await waitFor(() => expect(within(row(1)).getByRole('button', { name: '이 버전으로 복원' })).toBeTruthy());
    // 왼쪽 칸 — 스페이스 문맥의 페이지 트리
    const tree = await screen.findByRole('list', { name: '페이지 트리' });
    expect(within(tree).getByRole('link', { name: '회의록' }).getAttribute('aria-current')).toBe('page');
  });

  it('두 개를 고르면 비교하기가 풀리고, 결과는 "버전 비교" 안의 `.diff`에 — 미리보기와 **한 자리**를 번갈아 쓴다', async () => {
    const { container } = renderPage();
    await screen.findByRole('list', { name: '버전 목록' });
    const compare = screen.getByRole('button', { name: '비교하기' }) as HTMLButtonElement;
    expect(compare.disabled).toBe(true);
    fireEvent.click(within(row(1)).getByRole('checkbox', { name: '비교' }));
    fireEvent.click(within(row(2)).getByRole('checkbox', { name: '비교' }));
    expect(compare.disabled).toBe(false);
    expect(screen.getByText(/지금 고른 것: v1, v2/)).toBeTruthy();
    fireEvent.click(compare);
    const region = screen.getByRole('region', { name: '버전 비교' });
    await waitFor(() => expect(region.querySelector('.diff .diff-added')?.textContent).toBe('더한 문단'));

    // 보기 → 같은 자리에 미리보기, 비교 결과는 닫힌다
    fireEvent.click(within(row(1)).getByRole('button', { name: '보기' }));
    const preview = await screen.findByRole('region', { name: 'v1 미리보기' });
    expect(preview.querySelector('.editor.readonly')?.textContent).toContain('첫째 본문');
    expect(container.querySelector('.diff')).toBeNull();
  });

  it('**복원은 묻지 않는다** — 새 버전을 더하고 보기로 간다 (J.5.10)', async () => {
    renderPage();
    await screen.findByRole('list', { name: '버전 목록' });
    const restore = await waitFor(() => within(row(1)).getByRole('button', { name: '이 버전으로 복원' }));
    fireEvent.click(restore);
    await screen.findByText('보기 화면');
    expect(restored).toEqual(['/api/pages/p1/versions/1/restore']);
  });

  it('스페이스에 쓸 수 없으면 복원 단추가 없다', async () => {
    canWrite = false;
    renderPage();
    await screen.findByRole('navigation', { name: '현재 위치' });
    expect(within(list()).queryByRole('button', { name: '이 버전으로 복원' })).toBeNull();
  });

  it('**다른 페이지의 이력으로 곧바로 옮기면 앞 페이지의 고른 버전·목록을 들고 가지 않는다** — 화면을 페이지마다 새로 만든다 (병합 전 검토 14)', async () => {
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/pages/p2/versions') return Promise.resolve(json(200, [{ ...versions[1], title: '주간 보고' }]));
      if (url === '/api/pages/p2') return Promise.resolve(json(200, { ...pageSummary, id: 'p2', title: '주간 보고', currentVersionNo: 1, content: doc('셋째') }));
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    function Go() {
      const nav = useNavigate();
      return (
        <button type="button" onClick={() => void nav('/pages/p2/history')}>
          다른 이력으로
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={['/pages/p1/history']}>
        <Go />
        <Routes>
          <Route path="/pages/:id/history" element={<PageHistoryPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('list', { name: '버전 목록' });
    fireEvent.click(within(row(2)).getByRole('checkbox', { name: '비교' }));
    expect(screen.getByText(/지금 고른 것: v2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '다른 이력으로' }));
    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByText(/지금 고른 것: 없음/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '← 보기로' }).getAttribute('href')).toBe('/pages/p2');
  });
});
