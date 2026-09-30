// @vitest-environment happy-dom
import type { LlmProviderAdminView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminLlmPage } from './AdminLlmPage';

/**
 * 컴포넌트 시험 (보류 28, P10_설계서_Llm G절, FR-1100~1105 · P17 설계서 J.6 관리 다섯). 서버는 가짜 `fetch`다.
 *
 * 등록은 구획 폼(라벨은 이름만 — 설명은 도움말), 연결 확인의 결과는 그 줄 바로 아래의 펼친 줄(연결 이름을 되풀이하지 않는다 — E2E가 줄 이름으로
 * 한 줄만 찾는다), 삭제는 브라우저 창이 아니라 확인 대화로 묻는다(J.5.10)
 */

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
/** 그 연결의 줄 — 이름 칸으로 찾는다 */
const rowOf = (name: string) => screen.getByText(name, { selector: 'td' }).closest('tr')!;

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
    // 까닭은 그 칸 아래에 있고 칸이 그것을 가리킨다 (J.5.3)
    const url = screen.getByLabelText(/^주소/);
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(url.getAttribute('aria-describedby')).toContain('llm-url-err');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    // 주소를 고치면 까닭은 지운다
    fireEvent.change(url, { target: { value: 'http://llm.example.internal/v1' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('**라벨은 이름만** — 설명·필수는 라벨 밖이고 칸이 도움말을 가리킨다 (J.5.3)', async () => {
    renderPage();
    await screen.findByText('키 없는 것');
    const help = (label: RegExp | string) => document.getElementById(screen.getByLabelText(label).getAttribute('aria-describedby')!)!.textContent;
    expect(help(/^주소/)).toBe('OpenAI 호환 API의 /v1까지');
    expect(help(/^API 키/)).toBe('없으면 비운다. 저장하면 다시 볼 수 없다');
    expect(screen.getByText('주소', { selector: 'label' })).toBeTruthy();
    expect(screen.getByText('API 키', { selector: 'label' })).toBeTruthy();
    // 이름·주소·모델은 반드시 적는다 — 키는 없어도 된다
    expect(['이름', '모델'].map((l) => (screen.getByLabelText(l) as HTMLInputElement).required)).toEqual([true, true]);
    expect((screen.getByLabelText(/^주소/) as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText(/^API 키/) as HTMLInputElement).required).toBe(false);
    // 눈 모양 단추를 두지 않는다 — "API 키"로 찾는 이름이 그 단추에 걸리지 않게
    expect(screen.queryAllByRole('button', { name: /API 키/ })).toEqual([]);
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
    // 결과는 새 줄 바로 아래의 펼친 줄이다 — 연결 이름을 되풀이하지 않아 이름으로 찾으면 한 줄이다
    const detail = rowOf('새 LLM').nextElementSibling as HTMLElement;
    expect(within(detail).getByText('연결됨')).toBeTruthy();
    expect(detail.textContent).not.toContain('새 LLM');
    expect(screen.getAllByRole('row', { name: /새 LLM/ })).toHaveLength(1);
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
    // 배지는 짧게(연결 안 됨), 까닭은 그 옆의 글이다 — 긴 문장을 배지에 담지 않는다 (J.5.8)
    // 줄의 글은 예전 그대로다 — 설치및실행가이드가 그 글로 찾는다
    const why = await screen.findByText('— LLM 서버에 닿지 않는다 (ECONNREFUSED)');
    const detail = why.closest('tr')!;
    expect(detail.textContent).toBe('연결 안 됨 — LLM 서버에 닿지 않는다 (ECONNREFUSED)');
    expect(within(detail).getByText('연결 안 됨').className).toBe('badge fail');
    // 그 연결의 줄 바로 아래다
    expect(detail.previousElementSibling).toBe(rowOf('사내 Qwen'));
    checkResult = { ok: true, models: ['other'], modelFound: false };
    fireEvent.click(screen.getByRole('button', { name: '키 없는 것 연결 확인' }));
    const missing = await screen.findByText(/등록한 모델이 목록에 없다/);
    expect(missing.closest('tr')!.previousElementSibling).toBe(rowOf('키 없는 것'));
  });

  it('지우기는 되묻고, 그만두면 부르지 않는다 — 확인 대화의 확정은 부른 단추(삭제)의 이름을 품지 않는다 (J.5.10)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '사내 Qwen 삭제' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('"사내 Qwen"을(를) 지운다. 이 LLM으로 한 대화는 남고, 사람들은 다른 LLM으로 이어 묻는다.');
    // 처음 초점은 그만두기 — 잘못 누른 Enter가 지우기가 되지 않게
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '그만두기' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '사내 Qwen 삭제' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '지운다' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/llm/admin/providers/p1')).toBe(true));
    expect((await screen.findByRole('status')).textContent).toBe('"사내 Qwen"을(를) 지웠다');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('**목록을 읽지 못하면 까닭을 보이고** "등록된 LLM이 없다"로 말하지 않는다', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(json(403, { message: '권한이 없다 — LLM 연결은 시스템 관리자와 위임받은 관리자가 관리한다' }))) as unknown as typeof fetch;
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toContain('권한이 없다');
    expect(screen.queryByText('등록된 LLM이 없다.')).toBeNull();
    expect(screen.getByText('목록을 불러오지 못했다.')).toBeTruthy();
  });
});
