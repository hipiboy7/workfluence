// @vitest-environment happy-dom
import type { AttachmentView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Attachments } from './Attachments';

/**
 * 컴포넌트 시험 — 페이지 보기의 첨부 구획 (P3_설계서_Content 3절 · P17 설계서 J.5.5·J.5.10·J.7). 목록은 데이터 표, 올리기 칸에는 보이는 라벨이 있고,
 * **지우기 전에 확인 대화로 묻는다** — 화면에서 되살리는 길이 없다. 서버는 가짜 `fetch`다
 */

const row = (id: string, filename: string): AttachmentView => ({
  id,
  pageId: 'p1',
  filename,
  size: 2048,
  mime: 'text/plain',
  uploadedBy: 'u1',
  uploadedByName: '김',
  createdAt: '2026-09-27T00:00:00.000Z',
});
let rows: AttachmentView[] = [];
type Call = { method: string; url: string };
let calls: Call[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  rows = [row('a1', '보고서.txt')];
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url });
    if (method === 'GET' && url === '/api/pages/p1/attachments') return Promise.resolve(json(200, rows));
    if (method === 'DELETE' && url === '/api/attachments/a1') {
      rows = [];
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

describe('Attachments', () => {
  it('**표로 보인다** — 파일(내려받기 링크)·크기·올린 사람. 올리기 칸에는 보이는 라벨 "첨부할 파일"', async () => {
    render(<Attachments pageId="p1" canWrite />);
    const region = screen.getByRole('region', { name: '첨부' });
    const link = await within(region).findByRole('link', { name: '보고서.txt' });
    expect(link.getAttribute('href')).toBe('/api/attachments/a1');
    expect(within(region).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['파일', '크기', '올린 사람', '조치']);
    expect(within(link.closest('tr')!).getAllByRole('cell').map((td) => td.textContent)).toEqual(['보고서.txt', '2KB', '김', '삭제']);
    const input = screen.getByLabelText('첨부할 파일');
    expect(input.getAttribute('type')).toBe('file');
    expect(document.querySelector('label[for="attach-file"]')?.textContent).toBe('첨부할 파일');
  });

  it('**지우기 전에 묻는다** — 그만두면 지우지 않는다. 확정 단추는 "삭제"를 품지 않는다 (J.5.10)', async () => {
    render(<Attachments pageId="p1" canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: '보고서.txt 삭제' }));
    const dialog = await screen.findByRole('dialog', { name: '이 첨부를 지울까요?' });
    expect(dialog.textContent).toContain('보고서.txt');
    expect(dialog.textContent).toContain('되살릴 수 없다');
    // 처음 초점은 그만두기다
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '그만두기' }));
    expect(within(dialog).queryByRole('button', { name: /삭제/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deletes()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '보고서.txt 삭제' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '지운다' }));
    await screen.findByText('첨부가 없다.');
    expect(deletes()).toEqual([{ method: 'DELETE', url: '/api/attachments/a1' }]);
  });

  it('쓸 수 없으면 올리기 칸도 지우기도 없다 — 내려받기는 된다', async () => {
    render(<Attachments pageId="p1" canWrite={false} />);
    await screen.findByRole('link', { name: '보고서.txt' });
    expect(screen.queryByLabelText('첨부할 파일')).toBeNull();
    expect(screen.queryByRole('button', { name: /삭제/ })).toBeNull();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  });
});
