// @vitest-environment happy-dom
import type { PageSummary, SpaceView } from '@workfluence/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTree, SpaceSideNav, announceTreeChanged } from './SpaceSideNav';

/**
 * 컴포넌트 시험 — 스페이스 문맥의 왼쪽 칸과 페이지 트리 (P17 설계서 J.3.3·J.5.11, FR-1853 · 병합 전 검토 3·5). 트리는 목록 안의 목록이고 펼치기 단추는
 * 이름과 `aria-expanded`만 둔다. 지금 페이지는 `aria-current`. 스스로 부른 것이 실패하면 "불러오는 중"에 머물지 않는다. 서버는 가짜 `fetch`다
 */

const summary = (id: string, parentId: string | null, title: string): PageSummary => ({
  id,
  spaceId: 's1',
  parentId,
  title,
  position: 0,
  currentVersionNo: 1,
  updatedAt: '2026-09-29T00:00:00.000Z',
});
// 문서 ─ 회의록 ─ 월요일, 주간(하위 없음)
const PAGES = [summary('p0', null, '문서'), summary('p1', 'p0', '회의록'), summary('p3', 'p1', '월요일'), summary('p2', null, '주간')];

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderTree = (currentId?: string) =>
  render(
    <MemoryRouter>
      <PageTree pages={PAGES} currentId={currentId} />
    </MemoryRouter>,
  );

describe('PageTree — 펼치기·접기와 지금 페이지 (FR-1853)', () => {
  it('**처음에는 모두 펼쳐져 있고, 접으면 그 아래가 사라지고 다시 펼치면 돌아온다** — 단추의 이름과 aria-expanded가 따라간다', () => {
    renderTree();
    const tree = screen.getByRole('list', { name: '페이지 트리' });
    expect(within(tree).getAllByRole('link').map((a) => a.textContent)).toEqual(['문서', '회의록', '월요일', '주간']);
    const toggle = within(tree).getByRole('button', { name: '문서 접기' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // 단추에는 글이 없다 — 줄 글이 제목으로 시작한다
    expect(toggle.textContent).toBe('');

    fireEvent.click(toggle);
    expect(within(tree).getAllByRole('link').map((a) => a.textContent)).toEqual(['문서', '주간']);
    const closed = within(tree).getByRole('button', { name: '문서 펼치기' });
    expect(closed).toBe(toggle);
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    // 접은 줄 아래의 펼치기 단추도 함께 사라진다
    expect(within(tree).queryByRole('button', { name: /^회의록 / })).toBeNull();

    fireEvent.click(closed);
    expect(within(tree).getAllByRole('link').map((a) => a.textContent)).toEqual(['문서', '회의록', '월요일', '주간']);
    expect(within(tree).getByRole('button', { name: '문서 접기' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('**안쪽 가지를 접으면 그 가지만 접힌다** — 바깥 줄은 그대로다', () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: '회의록 접기' }));
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['문서', '회의록', '주간']);
    expect(screen.getByRole('button', { name: '문서 접기' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('**하위가 없는 줄은 단추 대신 같은 폭의 빈 자리** — 단계마다 16px 들여 쓰고, 안쪽 목록은 기본 들여쓰기가 없다', () => {
    renderTree();
    const row = screen.getByRole('link', { name: '주간' }).closest('.tree-row')!;
    expect(row.querySelector('button')).toBeNull();
    expect(row.querySelector('.tree-spacer')!.getAttribute('aria-hidden')).toBe('true');
    // 목록 안의 목록 — 화면 낭독기가 단계를 읽는다
    const child = screen.getByRole('link', { name: '회의록' }).closest('li')!;
    expect(child.style.marginLeft).toBe('16px');
    expect((child.parentElement as HTMLElement).tagName).toBe('UL');
    expect((child.parentElement as HTMLElement).style.paddingLeft).toBe('0px');
    expect(screen.getByRole('link', { name: '문서' }).closest('li')!.style.marginLeft).toBe('0px');
  });

  it('**지금 페이지만 aria-current="page"**', () => {
    renderTree('p1');
    expect(screen.getByRole('link', { name: '회의록' }).getAttribute('aria-current')).toBe('page');
    for (const other of ['문서', '월요일', '주간']) expect(screen.getByRole('link', { name: other }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: '회의록' }).getAttribute('href')).toBe('/pages/p1');
  });

  it('페이지가 없으면 그렇게 말한다', () => {
    render(
      <MemoryRouter>
        <PageTree pages={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('아직 페이지가 없다.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '페이지 트리' })).toBeNull();
  });
});

describe('SpaceSideNav — 스스로 부르는 트리 (병합 전 검토 5)', () => {
  let fail = true;
  let calls: string[] = [];
  // 스페이스마다 다른 id — 왼쪽 칸은 화면 사이에 트리를 들고 있다(모듈의 캐시). 시험끼리 섞이지 않게
  let spaceId = '';
  let n = 0;
  const space = (): SpaceView =>
    ({
      id: spaceId,
      name: '운영팀',
      key: 'OPS',
      kind: 'team',
      memberCount: 2,
      access: { canRead: true, canWrite: false, canManageMembers: false, canChangeStatus: false, canDelete: false, isOwner: false },
    }) as SpaceView;

  beforeEach(() => {
    fail = true;
    calls = [];
    spaceId = `side-${++n}`;
    globalThis.fetch = vi.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (fail) return Promise.resolve(json(500, { message: '고장' }));
      if (url === `/api/spaces/${spaceId}`) return Promise.resolve(json(200, space()));
      if (url === `/api/pages?spaceId=${spaceId}`) return Promise.resolve(json(200, PAGES.map((p) => ({ ...p, spaceId }))));
      return Promise.reject(new Error(`시험에 없는 요청: ${url}`));
    }) as unknown as typeof fetch;
  });

  const renderNav = () =>
    render(
      <MemoryRouter>
        <SpaceSideNav spaceId={spaceId} />
      </MemoryRouter>,
    );

  it('**읽지 못하면 "불러오는 중"에 머물지 않고 그렇게 말한다** — 다시 읽기를 누르면 다시 부른다', async () => {
    renderNav();
    expect(await screen.findByText('트리를 읽지 못했다.')).toBeTruthy();
    expect(screen.queryByText('불러오는 중…')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    expect(await screen.findByRole('list', { name: '페이지 트리' })).toBeTruthy();
    expect(screen.getByText('운영팀')).toBeTruthy();
    expect(screen.queryByText('트리를 읽지 못했다.')).toBeNull();
    expect(calls.filter((u) => u === `/api/spaces/${spaceId}`)).toHaveLength(2);
  });

  it('**트리가 바뀌었다는 알림에도 다시 부른다** — 다른 화면이 페이지를 만들거나 지운 뒤', async () => {
    renderNav();
    await screen.findByText('트리를 읽지 못했다.');
    fail = false;
    await act(async () => {
      announceTreeChanged(spaceId);
    });
    expect(await screen.findByRole('list', { name: '페이지 트리' })).toBeTruthy();
  });

  it('다른 스페이스의 알림에는 부르지 않는다', async () => {
    renderNav();
    await screen.findByText('트리를 읽지 못했다.');
    const before = calls.length;
    await act(async () => {
      announceTreeChanged('another-space');
    });
    expect(calls).toHaveLength(before);
    expect(screen.getByText('트리를 읽지 못했다.')).toBeTruthy();
  });
});
