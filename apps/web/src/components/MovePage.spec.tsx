// @vitest-environment happy-dom
import type { PageSummary } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MovePage } from './MovePage';

/**
 * 컴포넌트 시험 — 옮기기 칸 (P14_설계서_Spaces D.2, FR-1501·1502·1504). 자리는 **형제 가운데 몇 번째**(0부터)로 보낸다. 자기와 그 아래는 새 부모로
 * 고를 수 없다(편의 — 판정은 서버). 거절되면 서버의 까닭을 그대로 보인다. 서버는 가짜 `fetch`다
 */

const page = (id: string, parentId: string | null, position: number): PageSummary => ({
  id,
  spaceId: 's1',
  parentId,
  title: id.toUpperCase(),
  position,
  currentVersionNo: 1,
  updatedAt: '2026-09-27T00:00:00.000Z',
});
const tree = [page('a', null, 0), page('b', null, 1), page('a1', 'a', 0), page('a2', 'a', 1)];

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let moveAnswer: { status: number; body: unknown } = { status: 200, body: {} };
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

beforeEach(() => {
  calls = [];
  moveAnswer = { status: 200, body: {} };
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
    if (method === 'GET' && url === '/api/pages?spaceId=s1') return Promise.resolve(json(200, tree));
    if (method === 'PATCH' && url.endsWith('/move')) return Promise.resolve(json(moveAnswer.status, moveAnswer.body));
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const optionTexts = (label: string) => [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => o.textContent?.trim());
const moves = () => calls.filter((c) => c.method === 'PATCH');

describe('MovePage — 새 부모와 자리', () => {
  it('**자기와 그 아래는 새 부모로 고를 수 없다** — A를 옮길 때 A·A1·A2가 없다', async () => {
    render(<MovePage page={tree[0]} onMoved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText('어디 아래로');
    expect(optionTexts('어디 아래로')).toEqual(['맨 위', 'B']);
  });

  it('**그대로 누르면 지금 자리** — 같은 부모 안에서 자기를 뺀 형제 가운데 몇 번째를 보낸다', async () => {
    const onMoved = vi.fn();
    render(<MovePage page={tree[3]} onMoved={onMoved} onCancel={vi.fn()} />);
    await screen.findByLabelText('자리');
    // A2는 A 아래 두 번째 — 자기를 뺀 형제는 A1 하나, 지금 자리는 "A1 다음"
    expect(optionTexts('자리')).toEqual(['맨 앞', 'A1 다음']);
    expect((screen.getByLabelText('자리') as HTMLSelectElement).value).toBe('1');
    fireEvent.change(screen.getByLabelText('자리'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(moves()).toEqual([{ method: 'PATCH', url: '/api/pages/a2/move', body: { parentId: 'a', position: 0 } }]);
  });

  it('**앞자리에 있으면 기본도 그 자리** — 첫째 자식은 맨 앞(맨 뒤로 보내지 않는다)', async () => {
    render(<MovePage page={tree[2]} onMoved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText('자리');
    expect(optionTexts('자리')).toEqual(['맨 앞', 'A2 다음']);
    expect((screen.getByLabelText('자리') as HTMLSelectElement).value).toBe('0');
  });

  it('**다른 부모를 고르면 기본은 맨 뒤** — 그 부모의 형제 수', async () => {
    const onMoved = vi.fn();
    render(<MovePage page={tree[1]} onMoved={onMoved} onCancel={vi.fn()} />);
    await screen.findByLabelText('어디 아래로');
    fireEvent.change(screen.getByLabelText('어디 아래로'), { target: { value: 'a' } });
    expect(optionTexts('자리')).toEqual(['맨 앞', 'A1 다음', 'A2 다음']);
    expect((screen.getByLabelText('자리') as HTMLSelectElement).value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(moves()[0].body).toEqual({ parentId: 'a', position: 2 });
  });

  it('맨 위로 — 부모는 `null`', async () => {
    render(<MovePage page={tree[2]} onMoved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText('어디 아래로');
    fireEvent.change(screen.getByLabelText('어디 아래로'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('자리'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    await waitFor(() => expect(moves()).toHaveLength(1));
    expect(moves()[0].body).toEqual({ parentId: null, position: 1 });
  });

  it('**거절되면 서버의 까닭을 그대로 보이고 넘어가지 않는다** (FR-1504)', async () => {
    moveAnswer = { status: 400, body: { message: '페이지 트리는 10단계까지다' } };
    const onMoved = vi.fn();
    render(<MovePage page={tree[1]} onMoved={onMoved} onCancel={vi.fn()} />);
    await screen.findByLabelText('어디 아래로');
    fireEvent.change(screen.getByLabelText('어디 아래로'), { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));
    expect((await screen.findByRole('alert')).textContent).toContain('페이지 트리는 10단계까지다');
    expect(onMoved).not.toHaveBeenCalled();
  });

  it('닫기', async () => {
    const onCancel = vi.fn();
    render(<MovePage page={tree[0]} onMoved={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(await screen.findByRole('button', { name: '닫기' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
