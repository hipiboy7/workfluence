// @vitest-environment happy-dom
import type { CommentView, DocNode } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Comments } from './Comments';

/**
 * 컴포넌트 시험 — 페이지 보기의 댓글 구획 (P3_설계서_Content 5절 · P17 설계서 J.5.10·J.7). 답은 `.comment.reply`로 들고 답에는 답하기가 없다(FR-421).
 * 쓰는 칸의 보이는 이름이 아무 칸도 가리키지 않는 `label`이던 결함을 고쳤다. **지우기 전에 확인 대화로 묻는다.** 편집기는 가짜다 — 쓰는 칸은 이름 있는
 * 입력란, 읽기는 `.editor.readonly`로 그린다(진짜 편집기의 모양은 `Editor.spec.tsx`). 서버는 가짜 `fetch`다
 */
vi.mock('./Editor', () => ({
  Editor: ({ editable = true, ariaLabel, value }: { editable?: boolean; ariaLabel?: string; value: DocNode }) =>
    editable ? <div role="textbox" aria-label={ariaLabel} /> : <div className="editor readonly">{JSON.stringify(value.content ?? [])}</div>,
}));

const doc = (text: string): DocNode => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const comment = (id: string, parentId: string | null, text: string, canDelete = true): CommentView => ({
  id,
  pageId: 'p1',
  parentId,
  body: doc(text),
  createdBy: 'u1',
  createdByName: '김',
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  canDelete,
});
let rows: CommentView[] = [];
type Call = { method: string; url: string };
let calls: Call[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  rows = [comment('c1', null, '원 댓글'), comment('c2', 'c1', '답 하나')];
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url });
    if (method === 'GET' && url === '/api/pages/p1/comments') return Promise.resolve(json(200, rows));
    if (method === 'DELETE' && url.startsWith('/api/comments/')) {
      rows = rows.filter((c) => url !== `/api/comments/${c.id}`);
      return Promise.resolve(json(200, { ok: true }));
    }
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const deletes = () => calls.filter((c) => c.method === 'DELETE');
const itemOf = (text: string) => screen.getByText(new RegExp(text)).closest('li')!;

describe('Comments', () => {
  it('**답은 클래스로 들이고 답에는 답하기가 없다** (FR-421)', async () => {
    render(<Comments pageId="p1" canWrite />);
    await screen.findByText(/답 하나/);
    expect(itemOf('원 댓글').className).toBe('comment');
    expect(itemOf('답 하나').className).toBe('comment reply');
    expect(itemOf('답 하나').getAttribute('style')).toBeNull();
    expect(screen.getAllByRole('button', { name: '답하기' })).toHaveLength(1);
    expect(within(itemOf('원 댓글')).getByRole('button', { name: '답하기' })).toBeTruthy();
  });

  it('**쓰는 칸의 보이는 이름은 묶이지 않는 label이 아니다** — 칸의 이름과 같은 글이 제목으로 보이고, 답하기를 누르면 둘 다 "답 쓰기"다 (J.7)', async () => {
    render(<Comments pageId="p1" canWrite />);
    await screen.findByText(/원 댓글/);
    const region = screen.getByRole('region', { name: '댓글' });
    expect(region.querySelector('label')).toBeNull();
    expect(within(region).getByRole('heading', { name: '댓글 쓰기' })).toBeTruthy();
    expect(within(region).getByRole('textbox', { name: '댓글 쓰기' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '답하기' }));
    expect(within(region).getByRole('heading', { name: '답 쓰기' })).toBeTruthy();
    expect(within(region).getByRole('textbox', { name: '답 쓰기' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(within(region).getByRole('textbox', { name: '댓글 쓰기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '등록' }).className).toBe('primary');
  });

  it('**지우기 전에 묻는다** — 그만두면 지우지 않는다. 원 댓글이면 답도 안 보이게 된다고 말한다 (J.5.10)', async () => {
    render(<Comments pageId="p1" canWrite />);
    await screen.findByText(/답 하나/);
    fireEvent.click(within(itemOf('원 댓글')).getByRole('button', { name: '삭제' }));
    const dialog = await screen.findByRole('dialog', { name: '이 댓글을 지울까요?' });
    expect(dialog.textContent).toContain('김님의 댓글을 지운다. 화면에서 되살릴 수 없다.');
    expect(dialog.textContent).toContain('달린 답 1개도 보이지 않게 된다.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '그만두기' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes()).toEqual([]);

    fireEvent.click(within(itemOf('답 하나')).getByRole('button', { name: '삭제' }));
    const second = await screen.findByRole('dialog');
    // 답에는 답이 없다 — 그 말을 붙이지 않는다
    expect(second.textContent).not.toContain('달린 답');
    fireEvent.click(within(second).getByRole('button', { name: '지운다' }));
    await waitFor(() => expect(screen.queryByText(/답 하나/)).toBeNull());
    expect(deletes()).toEqual([{ method: 'DELETE', url: '/api/comments/c2' }]);
  });

  it('지울 수 있는지는 서버의 `canDelete`를 따른다 · 쓸 수 없으면 쓰는 칸과 답하기가 없다', async () => {
    rows = [comment('c1', null, '남의 댓글', false)];
    render(<Comments pageId="p1" canWrite={false} />);
    await screen.findByText(/남의 댓글/);
    expect(screen.queryByRole('button', { name: '삭제' })).toBeNull();
    expect(screen.queryByRole('button', { name: '답하기' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
