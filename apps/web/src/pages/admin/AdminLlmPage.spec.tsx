// @vitest-environment happy-dom
import type { LlmProviderAdminView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminLlmPage } from './AdminLlmPage';

/** 컴포넌트 시험 (보류 28, P10_설계서_Llm G절, FR-1100~1105). 서버는 가짜 `fetch`다 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let rows: LlmProviderAdminView[] = [];
let checkResult: unknown = { ok: true, models: ['mock-qwen3', 'other'], modelFound: true };

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

const row = (over: Partial<LlmProviderAdminView> = {}): LlmProviderAdminView => ({
  id: 'p1',
  name: '사내 Qwen',
  model: 'mock-qwen3',
  baseUrl: 'http://llm.example.internal:8000/v1',
  hasKey: true,
  createdByName: '시스템 관리자',
  createdAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  calls = [];
  rows = [row(), row({ id: 'p2', name: '키 없는 것', hasKey: false })];
  checkResult = { ok: true, models: ['mock-qwen3', 'other'], modelFound: true };
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/api/llm/admin/providers') return Promise.resolve(json(200, rows));
    if (method === 'POST' && url === '/api/llm/admin/providers') {
      const b = body as { name: string; baseUrl: string; model: string; apiKey: string | null };
      const view = row({ id: 'p3', name: b.name, baseUrl: b.baseUrl, model: b.model, hasKey: b.apiKey !== null });
      rows = [...rows, view];
      return Promise.resolve(json(201, view));
    }
    if (method === 'POST' && url.endsWith('/check')) return Promise.resolve(json(200, checkResult));
    if (method === 'DELETE') return Promise.resolve(json(200, { ok: true }));
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminLlmPage />
    </MemoryRouter>,
  );

describe('AdminLlmPage', () => {
  it('**키는 있다·없다만 보인다** (FR-1102)', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    await screen.findByText('키 없는 것');
    expect(table.textContent).toContain('있음');
    expect(table.textContent).toContain('없음');
    expect(table.textContent).toContain('http://llm.example.internal:8000/v1');
  });

  it('**주소 판정은 서버와 같은 함수를 먼저 돌린다** — 틀리면 보내지 않는다 (FR-1104)', async () => {
    renderPage();
    await screen.findByText('키 없는 것');
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/^주소/), { target: { value: 'http://user:pw@llm.example.internal/v1' } });
    fireEvent.change(screen.getByLabelText('모델'), { target: { value: 'm' } });
    fireEvent.click(screen.getByRole('button', { name: '등록' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/사용자 정보/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('등록하면 **입력한 키를 곧바로 비우고** 연결을 확인한다 (FR-1105)', async () => {
    renderPage();
    await screen.findByText('키 없는 것');
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '새 LLM' } });
    fireEvent.change(screen.getByLabelText(/^주소/), { target: { value: ' http://llm.example.internal:8000/v1/ ' } });
    fireEvent.change(screen.getByLabelText('모델'), { target: { value: 'mock-qwen3' } });
    fireEvent.change(screen.getByLabelText(/^API 키/), { target: { value: 'k-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '등록' }));

    expect(await screen.findByText(/등록했다/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/llm/admin/providers')?.body).toEqual({
      name: '새 LLM',
      baseUrl: 'http://llm.example.internal:8000/v1',
      model: 'mock-qwen3',
      apiKey: 'k-secret',
    });
    expect(screen.getByLabelText(/^API 키/)).toHaveProperty('value', '');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/llm/admin/providers/p3/check')).toBe(true));
    expect(await screen.findByText('연결됨')).toBeTruthy();
    expect(document.body.textContent).toContain('모델 2개: mock-qwen3, other');
  });

  it('**http 주소면 무엇이 평문으로 가는지 알린다** — 막지는 않는다, https면 알리지 않는다 (보안 검토)', async () => {
    renderPage();
    await screen.findByText('키 없는 것');
    // 목록에서도 표시한다
    expect(screen.getAllByText('(암호화 안 됨)')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(/^주소/), { target: { value: 'http://llm.example.internal/v1' } });
    expect(screen.getByRole('note').textContent).toMatch(/질문과 답이 암호화되지 않고/);
    fireEvent.change(screen.getByLabelText(/^API 키/), { target: { value: 'k' } });
    expect(screen.getByRole('note').textContent).toMatch(/그리고 API 키가 암호화되지 않고/);
    fireEvent.change(screen.getByLabelText(/^주소/), { target: { value: 'https://llm.example.internal/v1' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('키를 비우면 키 없이 등록한다', async () => {
    renderPage();
    await screen.findByText('키 없는 것');
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText(/^주소/), { target: { value: 'http://llm.example.internal/v1' } });
    fireEvent.change(screen.getByLabelText('모델'), { target: { value: 'm' } });
    fireEvent.click(screen.getByRole('button', { name: '등록' }));
    await screen.findByText(/등록했다/);
    expect((calls.find((c) => c.method === 'POST')?.body as { apiKey: unknown }).apiKey).toBeNull();
  });

  it('연결이 안 되면 까닭을, 모델 이름이 틀리면 그렇게 말한다', async () => {
    renderPage();
    await screen.findByText('키 없는 것');
    checkResult = { ok: false, message: 'LLM 서버에 닿지 않는다 (ECONNREFUSED)' };
    fireEvent.click(screen.getByRole('button', { name: '사내 Qwen 연결 확인' }));
    expect(await screen.findByText('연결 안 됨 — LLM 서버에 닿지 않는다 (ECONNREFUSED)')).toBeTruthy();
    checkResult = { ok: true, models: ['other'], modelFound: false };
    fireEvent.click(screen.getByRole('button', { name: '키 없는 것 연결 확인' }));
    expect(await screen.findByText(/등록한 모델이 목록에 없다/)).toBeTruthy();
  });

  it('지우기는 되묻고, 그만두면 부르지 않는다', async () => {
    // happy-dom에는 `confirm`이 없다 — 붙인다
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '사내 Qwen 삭제' }));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '사내 Qwen 삭제' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/llm/admin/providers/p1')).toBe(true));
    expect(await screen.findByText(/지웠다/)).toBeTruthy();
  });
});
