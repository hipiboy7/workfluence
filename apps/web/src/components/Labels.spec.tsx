// @vitest-environment happy-dom
import type { LabelView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Labels } from './Labels';

/**
 * 컴포넌트 시험 — 페이지 보기의 라벨 구획 (P4_설계서_Admin C절 FR-533·534 · P17 설계서 J.5.4·J.5.10·J.5.12). 라벨은 칩, 떼기 단추의 이름은 "{라벨} 떼기".
 * **떼기는 묻지 않는다** — 다시 붙이면 된다. 붙이기는 칸 + 단추 한 줄. 서버는 가짜 `fetch`다
 */

let rows: LabelView[] = [];
type Call = { method: string; url: string; body?: unknown };
let calls: Call[] = [];
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  rows = [{ id: 'l1', name: '회의록' }];
  calls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { name: string }) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/api/pages/p1/labels') return Promise.resolve(json(200, rows));
    if (method === 'POST' && url === '/api/pages/p1/labels') {
      rows = [...rows, { id: `l${rows.length + 1}`, name: body?.name ?? '' }];
      return Promise.resolve(json(201, rows[rows.length - 1]));
    }
    if (method === 'DELETE' && url === '/api/pages/p1/labels/l1') {
      rows = rows.filter((l) => l.id !== 'l1');
      return Promise.resolve(json(200, { ok: true }));
    }
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderLabels = (canWrite: boolean) =>
  render(
    <MemoryRouter>
      <Labels pageId="p1" canWrite={canWrite} />
    </MemoryRouter>,
  );

describe('Labels', () => {
  it('**라벨은 칩이고 라벨 화면으로 가는 링크다** — 떼기는 묻지 않고 뗀다 (J.5.10)', async () => {
    renderLabels(true);
    const region = screen.getByRole('region', { name: '라벨' });
    const link = await within(region).findByRole('link', { name: '회의록' });
    expect(link.getAttribute('href')).toBe(`/labels/${encodeURIComponent('회의록')}`);
    expect(link.closest('li')?.className).toBe('chip');
    fireEvent.click(within(region).getByRole('button', { name: '회의록 떼기' }));
    await within(region).findByText('라벨이 없다.');
    expect(document.querySelector('dialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/pages/p1/labels/l1']);
  });

  it('**붙이기는 칸 + 단추 한 줄** — 붙인 뒤 칸을 비운다', async () => {
    renderLabels(true);
    await screen.findByRole('link', { name: '회의록' });
    const input = screen.getByLabelText('라벨 붙이기') as HTMLInputElement;
    expect(input.closest('form')?.className).toBe('inline-form');
    fireEvent.change(input, { target: { value: '결산' } });
    fireEvent.click(screen.getByRole('button', { name: '붙이기' }));
    await screen.findByRole('link', { name: '결산' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: '결산' });
  });

  it('쓸 수 없으면 떼기도 붙이기도 없다', async () => {
    renderLabels(false);
    await screen.findByRole('link', { name: '회의록' });
    expect(screen.queryByRole('button', { name: /떼기/ })).toBeNull();
    expect(screen.queryByLabelText('라벨 붙이기')).toBeNull();
  });
});
