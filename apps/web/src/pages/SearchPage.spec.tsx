// @vitest-environment happy-dom
import type { SearchHit } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchPage } from './SearchPage';

/**
 * 컴포넌트 시험 — 검색 (P3 2절 · P17 설계서 J.6 기본 문맥). 칸 하나 + 찾기 한 줄 → "'X' 결과 N건" → 줄 목록(제목 링크·스페이스·스니펫), 0건이면 빈 상태.
 * 질의는 주소에 있다. 서버는 가짜 `fetch`다
 */

const hit = (over: Partial<SearchHit>): SearchHit => ({
  pageId: 'p1',
  spaceId: 's1',
  spaceName: '재무팀',
  title: '결산 보고',
  snippet: '분기 결산을 정리한다',
  updatedAt: '2026-09-28T00:00:00.000Z',
  ...over,
});
let answers: Record<string, SearchHit[]>;
/** 이 질의의 응답은 풀어 줄 때까지 붙든다 — 늦게 온 앞 질의가 뒤 질의를 덮는지 본다 */
let held: Record<string, (r: Response) => void>;
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  answers = { 결산: [hit({})], 없는말: [] };
  held = {};
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input), 'http://x');
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      if (q === '느린말') return new Promise<Response>((resolve) => (held[q] = resolve));
      return Promise.resolve(json(200, answers[q] ?? []));
    }
    return Promise.reject(new Error(`시험에 없는 요청: ${String(input)}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/search" element={<SearchPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('SearchPage', () => {
  it("**'X' 결과 N건 → 줄 목록** — 제목 링크·스페이스 이름·스니펫", async () => {
    renderAt('/search?q=결산');
    const count = await screen.findByRole('heading', { name: "'결산' 결과 1건" });
    const list = within(count.closest('section')!).getByRole('list');
    expect(list.className).toBe('row-list result-list');
    const [item] = within(list).getAllByRole('listitem');
    expect(within(item).getByRole('link', { name: '결산 보고' }).getAttribute('href')).toBe('/pages/p1');
    expect(within(item).getByText('재무팀')).toBeTruthy();
    expect(within(item).getByText('분기 결산을 정리한다')).toBeTruthy();
    expect((screen.getByLabelText('찾을 말') as HTMLInputElement).value).toBe('결산');
  });

  it('0건이면 빈 상태와 까닭 — 볼 수 없는 스페이스의 페이지는 나오지 않는다', async () => {
    renderAt('/search?q=없는말');
    expect(await screen.findByRole('heading', { name: "'없는말' 결과 0건" })).toBeTruthy();
    expect(screen.getByText('찾은 것이 없다.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('**칸 하나 + 찾기 한 줄** — 찾기를 누르면 주소의 질의로 찾는다. 질의가 없으면 결과를 그리지 않는다', async () => {
    renderAt('/search');
    const form = screen.getByRole('search');
    expect(form.className).toBe('inline-form');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    fireEvent.change(screen.getByLabelText('찾을 말'), { target: { value: '결산' } });
    fireEvent.click(within(form).getByRole('button', { name: '찾기' }));
    expect(await screen.findByRole('heading', { name: "'결산' 결과 1건" })).toBeTruthy();
  });

  it('**늦게 온 앞 질의의 응답이 뒤 질의의 결과를 덮지 않는다**', async () => {
    renderAt('/search?q=느린말');
    fireEvent.change(screen.getByLabelText('찾을 말'), { target: { value: '결산' } });
    fireEvent.click(screen.getByRole('button', { name: '찾기' }));
    expect(await screen.findByRole('heading', { name: "'결산' 결과 1건" })).toBeTruthy();
    held['느린말'](json(200, [hit({ pageId: 'p2', title: '엉뚱한 문서' })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('heading', { name: "'결산' 결과 1건" })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '엉뚱한 문서' })).toBeNull();
  });
});
