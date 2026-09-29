// @vitest-environment happy-dom
import type { LlmConversationList, LlmPromptView } from '@workfluence/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmPromptsPage } from './LlmPromptsPage';

/**
 * 컴포넌트 시험 — 내 지시문 (P10_설계서_Llm G절 FR-1125~1129 · P17 설계서 J.6 LLM 문맥). 서버는 가짜 `fetch`다.
 * 무엇이 그려지고 무엇을 부르나를 본다 — 왼쪽 칸의 LLM 문맥, 구획 폼의 라벨(E2E가 `getByLabel('이름')`·`('지시')`로 찾는다),
 * 지우기 전의 확인 대화(J.5.10 — E2E가 지우기를 보지 않는다)
 */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let prompts: LlmPromptView[] = [];
let conversations: () => Response;

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, body: null, text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)) }) as unknown as Response;

const prompt = (id: string, name: string, content: string): LlmPromptView => ({ id, name, content, updatedAt: new Date().toISOString() });
const list: LlmConversationList = {
  items: [
    {
      id: 'c1',
      title: '회의록 요약',
      providerId: 'p1',
      providerName: '사내 Qwen',
      promptName: null,
      pinned: false,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 2 * 86_400_000 - 60_000).toISOString(),
    },
  ],
  limits: { retentionDays: 7, conversationMax: 100, pinnedMax: 20 },
};

beforeEach(() => {
  calls = [];
  prompts = [prompt('pr1', '요약가', '세 줄로 요약한다')];
  conversations = () => json(200, list);
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/api/llm/prompts') return Promise.resolve(json(200, prompts));
    if (method === 'GET' && url === '/api/llm/conversations') return Promise.resolve(conversations());
    if (method === 'POST' && url === '/api/llm/prompts') {
      const b = body as { name: string; content: string };
      // 서버는 이름의 앞뒤 빈칸을 뗀다
      prompts = [...prompts, prompt('pr2', b.name.trim(), b.content)];
      return Promise.resolve(json(201, prompts.at(-1)));
    }
    if (method === 'PATCH' && url === '/api/llm/prompts/pr1') {
      const b = body as { name: string; content: string };
      prompts = [prompt('pr1', b.name, b.content)];
      return Promise.resolve(json(200, prompts[0]));
    }
    if (method === 'DELETE' && url === '/api/llm/prompts/pr1') {
      prompts = prompts.filter((p) => p.id !== 'pr1');
      return Promise.resolve(json(204, undefined));
    }
    return Promise.reject(new Error(`시험에 없는 요청: ${method} ${url}`));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/llm/prompts']}>
      <Routes>
        <Route path="/llm/prompts" element={<LlmPromptsPage />} />
        <Route path="/llm" element={<p>질문 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe('화면 틀 — LLM 문맥 (P17 설계서 J.3.3·J.6)', () => {
  it('왼쪽 칸은 새 대화(링크)·**내 지시문(지금 화면)**·대화 목록(읽기만) — 본문에는 h1 하나, "← LLM 질문"이 없다', async () => {
    renderPage();
    const aside = await screen.findByRole('complementary', { name: '대화 목록' });
    const item = await within(aside).findByRole('link', { name: /회의록 요약/ });
    expect(item.getAttribute('href')).toBe('/llm/c1');
    expect(aside.textContent).toContain('2일 뒤 지워짐');
    // 목록은 읽기만 한다 — 고정·지우기는 질문 화면에서
    expect(within(aside).queryAllByRole('button')).toHaveLength(0);

    const side = aside.closest('.side-inline');
    expect(side).not.toBeNull();
    const fresh = screen.getByRole('link', { name: '새 대화' });
    expect(side?.contains(fresh)).toBe(true);
    expect(fresh.getAttribute('href')).toBe('/llm');
    expect(screen.getByRole('link', { name: '내 지시문' }).getAttribute('aria-current')).toBe('page');
    expect(side?.querySelectorAll('h1, h2, h3')).toHaveLength(0);

    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['내 지시문']);
    expect(screen.queryByRole('link', { name: /←/ })).toBeNull();

    fireEvent.click(fresh);
    expect(await screen.findByText('질문 화면')).toBeTruthy();
  });

  it('대화 목록을 읽지 못해도 지시문은 보이고, 왼쪽 칸이 그렇게 말한다', async () => {
    conversations = () => json(500, { message: '서버 오류' });
    renderPage();
    expect(await screen.findByRole('region', { name: '요약가' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('complementary', { name: '대화 목록' }).textContent).toBe('대화 목록을 읽지 못했다.'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('지시문 저장·고치기·지우기 (FR-1125~1129)', () => {
  it('새 지시문은 구획 폼이다 — 라벨은 이름만("필수"는 라벨 밖), 저장하면 카드가 생기고 완료를 알린다', async () => {
    renderPage();
    await screen.findByRole('region', { name: '요약가' });
    const name = screen.getByLabelText('이름');
    const content = screen.getByLabelText('지시');
    expect(name).toHaveProperty('required', true);
    expect(content).toHaveProperty('required', true);
    // 도움말은 칸의 설명으로 이어진다
    expect(document.getElementById(content.getAttribute('aria-describedby') ?? '')?.textContent).toContain('/no_think');
    expect(name.closest('.form-row')).not.toBeNull();

    fireEvent.change(name, { target: { value: ' 번역가 ' } });
    fireEvent.change(content, { target: { value: '영어로 옮긴다' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('status')).textContent).toBe('"번역가"을(를) 저장했다');
    expect(screen.getByRole('status').className).toBe('notice success');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: ' 번역가 ', content: '영어로 옮긴다' });
    expect(await screen.findByRole('region', { name: '번역가' })).toBeTruthy();
    expect(screen.getByLabelText('이름')).toHaveProperty('value', '');
  });

  it('고치기는 그 카드 자리의 폼으로 고치고 PATCH한다', async () => {
    renderPage();
    const card = await screen.findByRole('region', { name: '요약가' });
    fireEvent.click(within(card).getByRole('button', { name: '요약가 고치기' }));
    const form = screen.getByRole('form', { name: '요약가 고치기' });
    fireEvent.change(within(form).getByLabelText('지시'), { target: { value: '다섯 줄로 요약한다' } });
    fireEvent.click(within(form).getByRole('button', { name: '고친 것 저장' }));
    expect((await screen.findByRole('status')).textContent).toBe('고쳤다 — 이제부터 시작하는 대화에 쓰인다');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: '요약가', content: '다섯 줄로 요약한다' });
    expect(screen.queryByRole('form', { name: '요약가 고치기' })).toBeNull();
    expect((await screen.findByRole('region', { name: '요약가' })).textContent).toContain('다섯 줄로 요약한다');
  });

  it('**지우기 전에 묻는다** — 그만두면 지우지 않는다. 처음 초점은 그만두기, 확정 단추는 "지우기"를 품지 않는다 (J.5.10)', async () => {
    renderPage();
    await screen.findByRole('region', { name: '요약가' });
    fireEvent.click(screen.getByRole('button', { name: '요약가 지우기' }));
    const dialog = await screen.findByRole('dialog', { name: '이 지시문을 지울까요?' });
    expect(dialog.textContent).toContain('"요약가" 지시문을 지운다. 되살릴 수 없다. 이 지시문으로 시작한 대화는 그대로다.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '그만두기' }));
    expect(within(dialog).queryByRole('button', { name: /지우/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '그만두기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '요약가 지우기' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '없앤다' }));
    expect((await screen.findByRole('status')).textContent).toBe('"요약가"을(를) 지웠다');
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/llm/prompts/pr1']);
    expect(screen.queryByRole('region', { name: '요약가' })).toBeNull();
    expect(screen.getByText('아직 지시문이 없다.')).toBeTruthy();
  });
});
