// @vitest-environment happy-dom
import { encodeLlmEvent, type LlmConversationList, type LlmConversationView, type LlmStreamEvent } from '@workfluence/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmPage } from './LlmPage';

/**
 * 컴포넌트 시험 (보류 28, P10_설계서_Llm G절). 서버는 가짜 `fetch`다 — 흐름의 규칙은 `llmStream.spec.ts`가, 실제 서버와의 흐름은
 * E2E가 본다. 여기는 **무엇이 그려지고 무엇을 부르나**를 본다.
 */

type Call = { method: string; url: string; body: unknown; signal: AbortSignal | null };
type Route_ = (body: unknown, init?: RequestInit) => Response | Promise<Response>;

let calls: Call[] = [];
let routes: Record<string, Route_> = {};

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, body: null, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;

/**
 * 줄을 차례로 내는 흐름. `gate`가 풀릴 때까지 `hold`번째 줄에서 멈춘다 — "받는 중"을 보려고. `signal`이 끊기면 `fetch`처럼 읽기가
 * `AbortError`로 끝난다 — 페이지를 떠나는 시험
 */
function stream(events: LlmStreamEvent[], hold = -1, signal?: AbortSignal | null): { res: Response; release: () => void } {
  let release = () => undefined as void;
  const gate = new Promise<void>((r) => (release = r));
  const aborted = new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
  const bytes = events.map((e) => new TextEncoder().encode(encodeLlmEvent(e)));
  let i = 0;
  const res = {
    ok: true,
    status: 200,
    text: () => Promise.resolve(''),
    body: {
      getReader: () => ({
        read: async () => {
          if (i === hold) await Promise.race([gate, aborted]);
          if (signal?.aborted) throw new DOMException('중지', 'AbortError');
          return i < bytes.length ? { done: false, value: bytes[i++] } : { done: true, value: undefined };
        },
      }),
    },
  } as unknown as Response;
  return { res, release };
}

const soon = new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString();
const listOf = (items: LlmConversationList['items'], pinnedMax = 20): LlmConversationList => ({
  items,
  limits: { retentionDays: 7, conversationMax: 100, pinnedMax },
});
const summary = (id: string, title: string, pinned: boolean) => ({
  id,
  title,
  providerId: 'p1',
  providerName: '사내 Qwen',
  promptName: null,
  pinned,
  updatedAt: new Date().toISOString(),
  expiresAt: pinned ? null : soon,
});
const conversation = (id: string, over: Partial<LlmConversationView> = {}): LlmConversationView => ({
  ...summary(id, '회의록 요약', false),
  systemPrompt: null,
  messages: [
    { id: 'm1', role: 'user', content: '회의록 요약해 줘', model: null, status: 'done', createdAt: new Date().toISOString() },
    { id: 'm2', role: 'assistant', content: '세 줄 요약', model: 'mock-qwen3', status: 'done', createdAt: new Date().toISOString() },
  ],
  ...over,
});

/** 시험이 주소를 바꾼다 — 뒤로 가기·주소 입력과 같다 */
function GoTo({ to }: { to: string }) {
  const nav = useNavigate();
  return (
    <button type="button" onClick={() => void nav(to)}>
      시험: {to}로
    </button>
  );
}

function renderAt(path: string, goTo = '/llm/other') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GoTo to={goTo} />
      <Routes>
        <Route path="/llm" element={<LlmPage />} />
        <Route path="/llm/:id" element={<LlmPage />} />
        <Route path="/llm/prompts" element={<p>지시문 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  calls = [];
  routes = {
    'GET /api/llm/conversations': () => json(200, listOf([])),
    'GET /api/llm/providers': () => json(200, [{ id: 'p1', name: '사내 Qwen', model: 'mock-qwen3' }]),
    'GET /api/llm/prompts': () => json(200, [{ id: 'pr1', name: '세 줄', content: '세 줄로', updatedAt: new Date().toISOString() }]),
  };
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body, signal: init?.signal ?? null });
    const r = routes[`${method} ${url}`];
    if (!r) return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
    return Promise.resolve(r(body, init));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ask = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/llm/ask');

describe('목록과 상한 (FR-1131~1133)', () => {
  it('고정·최근을 나누고, 상한과 남은 날을 말하고, **고정이 차면 고정 버튼을 막는다**', async () => {
    routes['GET /api/llm/conversations'] = () => json(200, listOf([summary('a', '고정한 것', true), summary('b', '최근 것', false)], 1));
    renderAt('/llm');
    const aside = await screen.findByRole('complementary', { name: '대화 목록' });
    await within(aside).findByText('고정한 것');
    expect(aside.textContent).toContain('고정 1/1 · 보관 2/100 · 고정하지 않은 대화는 마지막 사용 뒤 7일이 지나면 지워진다');
    expect(aside.textContent).toContain('3일 뒤 지워짐');
    expect(screen.getByRole('button', { name: '최근 것 고정' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '고정한 것 고정 풀기' })).toHaveProperty('disabled', false);
  });

  it('고정·풀기·지우기는 서버를 부르고 목록을 다시 읽는다', async () => {
    routes['GET /api/llm/conversations'] = () => json(200, listOf([summary('b', '최근 것', false)]));
    routes['PUT /api/llm/conversations/b/pin'] = () => json(200, { ok: true });
    routes['DELETE /api/llm/conversations/b'] = () => json(200, { ok: true });
    // happy-dom에는 `confirm`이 없다 — 붙인다
    Object.defineProperty(window, 'confirm', { value: vi.fn(() => true), configurable: true, writable: true });
    renderAt('/llm');
    fireEvent.click(await screen.findByRole('button', { name: '최근 것 고정' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '최근 것 지우기' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.filter((c) => c.url === '/api/llm/conversations').length).toBeGreaterThanOrEqual(3);
  });

  it('등록된 LLM이 없으면 그렇게 말하고 보내지 못한다', async () => {
    routes['GET /api/llm/providers'] = () => json(200, []);
    renderAt('/llm');
    expect(await screen.findByText(/등록된 LLM이 없다/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('질문'), { target: { value: '질문' } });
    expect(screen.getByRole('button', { name: '보내기' })).toHaveProperty('disabled', true);
  });
});

describe('묻기 (FR-1110~1122)', () => {
  it('**흘러나오는 동안 답이 보이고 중지가 있다** — 끝나면 저장된 대화로 옮긴다', async () => {
    const s = stream(
      [
        { type: 'thinking', text: '음…' },
        { type: 'delta', text: '안녕' },
        { type: 'end', status: 'done', saved: true, conversationId: 'c1', evicted: 0, message: null },
      ],
      2,
    );
    routes['POST /api/llm/ask'] = () => s.res;
    routes['GET /api/llm/conversations/c1'] = () => json(200, conversation('c1'));
    renderAt('/llm');
    // 새 대화에서는 지시문을 고른다
    const prompt = await screen.findByLabelText('지시문');
    await within(prompt).findByText('세 줄');
    fireEvent.change(prompt, { target: { value: 'pr1' } });
    fireEvent.change(screen.getByLabelText('질문'), { target: { value: '  회의록 요약해 줘  ' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));

    const live = await screen.findByLabelText('흘러나오는 답');
    await within(live).findByText('안녕');
    expect(live.textContent).toContain('답을 받는 중…');
    expect(live.textContent).toContain('생각 과정');
    expect(screen.getByRole('button', { name: '중지' })).toBeTruthy();
    // 받는 동안 다른 대화로 옮기지 못한다
    expect(screen.getByRole('button', { name: '새 대화' })).toHaveProperty('disabled', true);
    expect(ask()[0].body).toEqual({ providerId: 'p1', question: '회의록 요약해 줘', promptId: 'pr1' });

    await act(async () => s.release());
    const messages = await screen.findByRole('list', { name: '메시지' });
    await within(messages).findByText('세 줄 요약');
    expect(screen.queryByLabelText('흘러나오는 답')).toBeNull();
    expect(screen.getByLabelText('질문')).toHaveProperty('value', '');
    // 이어 묻는 대화에서는 지시문을 고르지 않는다
    expect(screen.queryByLabelText('지시문')).toBeNull();
  });

  it('**첫 답이 올 때까지 기다린 초를 보이고, 5초부터 "답변이 늦어지고 있습니다."** — 답이 오면 사라진다 (P12 FR-1300·1301)', async () => {
    // 시계만 가짜로 — 화면의 1초 시계(setInterval)와 Date. 흐름의 모아 그리기(setTimeout)는 그대로 둔다
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const s = stream(
        [
          { type: 'ping' },
          { type: 'delta', text: '늦은 답' },
          { type: 'end', status: 'done', saved: true, conversationId: 'c1', evicted: 0, message: null },
        ],
        1,
      );
      routes['POST /api/llm/ask'] = () => s.res;
      routes['GET /api/llm/conversations/c1'] = () => json(200, conversation('c1'));
      renderAt('/llm');
      await within(await screen.findByLabelText('지시문')).findByText('세 줄');
      fireEvent.change(screen.getByLabelText('질문'), { target: { value: '붐빌 때의 질문' } });
      fireEvent.click(screen.getByRole('button', { name: '보내기' }));

      const live = await screen.findByLabelText('흘러나오는 답');
      const waiting = await within(live).findByText(/답변을 기다리고 있습니다/);
      expect(live.textContent).toContain('답변을 기다리고 있습니다 · 0s');
      // 문구는 읽히고 1초마다 바뀌는 초만 읽지 않는다 (P12 코드 리뷰 9 · 종료 루틴 자체 점검 3)
      expect(waiting.closest('[aria-hidden="true"]')).toBeNull();
      expect(waiting.querySelector('[aria-hidden="true"]')?.textContent).toBe(' · 0s');
      act(() => void vi.advanceTimersByTime(3_000));
      expect(live.textContent).toContain('답변을 기다리고 있습니다 · 3s');
      expect(live.textContent).not.toContain('답변이 늦어지고 있습니다.');
      act(() => void vi.advanceTimersByTime(2_000));
      expect(live.textContent).toContain('답변을 기다리고 있습니다 · 5s');
      expect(live.textContent).toContain('답변이 늦어지고 있습니다.');

      await act(async () => s.release());
      const messages = await screen.findByRole('list', { name: '메시지' });
      await within(messages).findByText('세 줄 요약');
      expect(messages.textContent).not.toContain('기다리고 있습니다');
      expect(messages.textContent).not.toContain('늦어지고 있습니다');
    } finally {
      vi.useRealTimers();
    }
  });

  it('**중지를 누르면 기다림이 사라진다** — 멈추라고 했는데 "늦어지고 있다"고 말하지 않는다 (P12 코드 리뷰 10)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const s = stream([{ type: 'ping' }, { type: 'end', status: 'stopped', saved: false, conversationId: null, evicted: 0, message: null }], 1);
      routes['POST /api/llm/ask'] = () => s.res;
      routes['POST /api/llm/stop'] = () => json(200, { stopped: true });
      renderAt('/llm');
      fireEvent.change(await screen.findByLabelText('질문'), { target: { value: 'q' } });
      await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
      fireEvent.click(screen.getByRole('button', { name: '보내기' }));
      const live = await screen.findByLabelText('흘러나오는 답');
      await within(live).findByText(/답변을 기다리고 있습니다/);
      act(() => void vi.advanceTimersByTime(6_000));
      expect(live.textContent).toContain('답변이 늦어지고 있습니다.');
      await waitFor(() => expect(screen.getByRole('button', { name: '중지' })).toHaveProperty('disabled', false));
      fireEvent.click(screen.getByRole('button', { name: '중지' }));
      expect(live.textContent).not.toContain('기다리고 있습니다');
      expect(live.textContent).not.toContain('늦어지고 있습니다');
      await act(async () => s.release());
    } finally {
      vi.useRealTimers();
    }
  });

  it('이어 묻기는 대화 id를 보내고 같은 대화를 다시 읽는다', async () => {
    routes['GET /api/llm/conversations/c1'] = () => json(200, conversation('c1', { promptName: '세 줄' }));
    routes['POST /api/llm/ask'] = () => stream([{ type: 'delta', text: '둘째' }, { type: 'end', status: 'done', saved: true, conversationId: 'c1', evicted: 1, message: null }]).res;
    renderAt('/llm/c1');
    expect(await screen.findByText('지시문: 세 줄')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('질문'), { target: { value: '둘째 질문' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText('보관 상한을 넘어 오래된 대화 1개를 지웠다')).toBeTruthy();
    expect(ask()[0].body).toEqual({ providerId: 'p1', question: '둘째 질문', conversationId: 'c1' });
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/llm/conversations/c1').length).toBe(2));
  });

  it('**저장되지 않으면 까닭을 말하고 질문을 입력칸에 되돌린다** (D.5)', async () => {
    routes['POST /api/llm/ask'] = () =>
      stream([{ type: 'end', status: 'failed', saved: false, conversationId: null, evicted: 0, message: 'LLM 서버에 닿지 않는다 (ECONNREFUSED)' }]).res;
    renderAt('/llm');
    fireEvent.change(await screen.findByLabelText('질문'), { target: { value: '다시 물을 질문' } });
    await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('LLM 서버에 닿지 않는다 (ECONNREFUSED)');
    await waitFor(() => expect(screen.getByLabelText('질문')).toHaveProperty('value', '다시 물을 질문'));
  });

  it('흐름을 열기 전의 거절(409)도 문장 그대로 말하고 질문을 되돌린다', async () => {
    routes['POST /api/llm/ask'] = () => json(409, { message: '이미 답을 받고 있다 — 끝나거나 중지한 뒤에 묻는다' });
    renderAt('/llm');
    fireEvent.change(await screen.findByLabelText('질문'), { target: { value: 'q' } });
    await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/이미 답을 받고 있다/);
    await waitFor(() => expect(screen.getByLabelText('질문')).toHaveProperty('value', 'q'));
  });

  it('**흐름이 열리기 전에는 중지를 누르지 못한다** — 서버가 자리를 잡기 전이라 닿지 않는다. 보내기와 다른 단추다 (검토 반영)', async () => {
    let open = () => undefined as void;
    const opened = new Promise<void>((r) => (open = r));
    const s = stream([{ type: 'delta', text: '앞' }, { type: 'end', status: 'done', saved: false, conversationId: null, evicted: 0, message: 'x' }], 1);
    routes['POST /api/llm/ask'] = () => opened.then(() => s.res);
    renderAt('/llm');
    fireEvent.change(await screen.findByLabelText('질문'), { target: { value: 'q' } });
    await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText(/보내는 중…/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '중지' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '보내기' })).toHaveProperty('disabled', true);
    await act(async () => open());
    await waitFor(() => expect(screen.getByRole('button', { name: '중지' })).toHaveProperty('disabled', false));
    await act(async () => s.release());
  });

  it('**멈출 것이 없었다는 답이면 다시 누를 수 있다**', async () => {
    const s = stream([{ type: 'delta', text: '앞부분' }, { type: 'end', status: 'done', saved: false, conversationId: null, evicted: 0, message: 'x' }], 1);
    routes['POST /api/llm/ask'] = () => s.res;
    routes['POST /api/llm/stop'] = () => json(200, { stopped: false });
    renderAt('/llm');
    fireEvent.change(await screen.findByLabelText('질문'), { target: { value: 'q' } });
    await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('앞부분');
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '중지' })).toHaveProperty('disabled', false));
    await act(async () => s.release());
  });

  it('**페이지를 떠나면 받던 답을 멈춘다** — 요청을 끊고, 떠난 흐름의 결과로 화면을 옮기지 않는다 (검토 반영)', async () => {
    let s: ReturnType<typeof stream> | null = null;
    routes['POST /api/llm/ask'] = (_b, init) => {
      s = stream([{ type: 'delta', text: '앞부분' }, { type: 'end', status: 'done', saved: true, conversationId: 'c1', evicted: 0, message: null }], 1, init?.signal);
      return s.res;
    };
    renderAt('/llm');
    fireEvent.change(await screen.findByLabelText('질문'), { target: { value: 'q' } });
    await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('앞부분');
    fireEvent.click(screen.getByRole('link', { name: '내 지시문' }));
    expect(await screen.findByText('지시문 화면')).toBeTruthy();
    expect(ask()[0].signal?.aborted).toBe(true);
    await act(async () => (s as unknown as { release: () => void }).release());
    // 끝난 흐름이 `/llm/c1`로 끌고 가지 않는다
    expect(screen.getByText('지시문 화면')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/llm/conversations/c1')).toBe(false);
  });

  it('**받는 중에 주소로 다른 대화를 열면**(뒤로 가기) 받던 답을 멈추고 그 대화를 연다 — 옛 흐름이 되돌리지 않는다', async () => {
    routes['GET /api/llm/conversations/c1'] = () => json(200, conversation('c1'));
    routes['GET /api/llm/conversations/other'] = () => json(200, conversation('other', { title: '다른 대화', messages: [] }));
    routes['POST /api/llm/ask'] = (_b, init) =>
      stream([{ type: 'delta', text: '앞부분' }, { type: 'end', status: 'done', saved: true, conversationId: 'c1', evicted: 0, message: null }], 1, init?.signal).res;
    renderAt('/llm/c1');
    await screen.findByText('세 줄 요약');
    fireEvent.change(screen.getByLabelText('질문'), { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('앞부분');
    fireEvent.click(screen.getByRole('button', { name: '시험: /llm/other로' }));
    expect(await screen.findByRole('heading', { name: '다른 대화' })).toBeTruthy();
    expect(ask()[0].signal?.aborted).toBe(true);
    expect(screen.queryByLabelText('흘러나오는 답')).toBeNull();
    expect(screen.getByRole('button', { name: '보내기' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('질문'), { target: { value: '다음' } });
    expect(screen.getByRole('button', { name: '보내기' })).toHaveProperty('disabled', false);
    // 옛 흐름은 c1을 다시 읽지 않는다 — 처음 연 한 번뿐
    expect(calls.filter((c) => c.url === '/api/llm/conversations/c1')).toHaveLength(1);
  });

  it('**주소의 id는 경로로 넣을 때 다시 싼다** — `%2F`로 다른 API를 부르지 못한다 (보안 검토)', async () => {
    routes['GET /api/llm/conversations/..%2F..%2Fpages%2Fp1%2Fexport'] = () => json(400, { message: '대화 id가 아니다' });
    renderAt('/llm/..%2F..%2Fpages%2Fp1%2Fexport');
    expect((await screen.findByRole('alert')).textContent).toBe('대화 id가 아니다');
    expect(calls.some((c) => c.url.includes('/api/pages'))).toBe(false);
  });

  it('**중지는 서버에 멈추라고 하고 끝 줄을 기다린다** (FR-1113)', async () => {
    const s = stream(
      [
        { type: 'delta', text: '앞부분' },
        { type: 'end', status: 'stopped', saved: true, conversationId: 'c9', evicted: 0, message: null },
      ],
      1,
    );
    routes['POST /api/llm/ask'] = () => s.res;
    routes['POST /api/llm/stop'] = () => json(200, { stopped: true });
    routes['GET /api/llm/conversations/c9'] = () => json(200, conversation('c9'));
    renderAt('/llm');
    fireEvent.change(await screen.findByLabelText('질문'), { target: { value: 'q' } });
    await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('앞부분');
    fireEvent.click(screen.getByRole('button', { name: '중지' }));
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/llm/stop')).toBe(true);
    expect(screen.getByRole('button', { name: '멈추는 중…' })).toHaveProperty('disabled', true);
    await act(async () => s.release());
    expect(await screen.findByText('중지했다 — 거기까지 저장했다')).toBeTruthy();
  });

  it('Ctrl+Enter로 보내고, Enter만으로는 보내지 않는다', async () => {
    routes['POST /api/llm/ask'] = () => stream([{ type: 'end', status: 'done', saved: false, conversationId: null, evicted: 0, message: 'x' }]).res;
    renderAt('/llm');
    const box = await screen.findByLabelText('질문');
    await screen.findByRole('option', { name: '사내 Qwen · mock-qwen3' });
    fireEvent.change(box, { target: { value: 'q' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(ask()).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(ask()).toHaveLength(1));
  });

  it('저장된 답에는 상태 표지와 "답 복사"가 있다', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    routes['GET /api/llm/conversations/c1'] = () =>
      json(200, conversation('c1', { messages: [{ id: 'm2', role: 'assistant', content: '반쯤', model: 'mock-qwen3', status: 'failed', createdAt: new Date().toISOString() }] }));
    renderAt('/llm/c1');
    expect(await screen.findByText('끊김')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '답 복사' }));
    expect(await screen.findByText('답을 복사했다')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('반쯤');
  });

  it('없는 대화를 열면 까닭을 말한다', async () => {
    routes['GET /api/llm/conversations/gone'] = () => json(404, { message: '대화를 찾을 수 없다 — 지웠거나 보존 기간이 지났다' });
    renderAt('/llm/gone');
    expect((await screen.findByRole('alert')).textContent).toMatch(/보존 기간이 지났다/);
  });
});
