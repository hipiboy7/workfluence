import { createLineSplitter, parseLlmEvent, type LlmAskDto, type LlmStreamEvent } from '@workfluence/shared';
import { readApiError, requestInit } from '../api';

/**
 * LLM 질문의 **흐름 하나**와 화면 상태 기계 (P10_설계서_Llm D.1·G절).
 *
 * `LlmPage.tsx`에서 떼어 둔다 — 그리는 일과 상태 기계를 나눠 **상태 기계를 브라우저 없이 시험한다**(`llmStream.spec.ts`,
 * `collabLink.ts`와 같은 판단). 무엇이 그려지는지는 컴포넌트 시험(`LlmPage.spec.tsx`)이 본다.
 */

type EndEvent = Extract<LlmStreamEvent, { type: 'end' }>;

/** `end` 없이 흐름이 끊겼을 때 스스로 만드는 끝 — 서버가 저장했는지 모르므로 목록을 다시 보라고 말한다 */
export const LOST_END: EndEvent = {
  type: 'end',
  status: 'failed',
  saved: false,
  conversationId: null,
  evicted: 0,
  message: '연결이 끊겼다 — 답이 저장됐는지 목록을 다시 본다',
};

/**
 * 흐름을 끝까지 읽는다 — 줄마다 `onEvent`. 모양이 틀린 줄은 버린다. **`end`는 늘 한 번 온다** — 서버가 보내지 못하고 끊겼으면
 * `LOST_END`를 대신 부른다. 바이트가 글자 가운데서 갈라져 와도 된다(`TextDecoder`의 `stream`).
 */
export async function readLlmStream(body: ReadableStream<Uint8Array>, onEvent: (e: LlmStreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines = createLineSplitter();
  let ended = false;
  const handle = (line: string) => {
    const e = parseLlmEvent(line);
    if (!e || ended) return;
    if (e.type === 'end') ended = true;
    onEvent(e);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const l of lines.push(decoder.decode(value, { stream: true }))) handle(l);
    }
    for (const l of [...lines.push(decoder.decode()), ...lines.end()]) handle(l);
  } catch {
    // 끊겼다 — 아래에서 끝을 대신 말한다
  }
  if (!ended) onEvent(LOST_END);
}

export type AskOptions = {
  /** 끊으면 요청을 끊는다 — 서버는 창을 닫은 것처럼 받은 데까지 저장한다 (FR-1122). 페이지를 떠날 때 쓴다 */
  signal?: AbortSignal;
  /** 흐름이 열렸다 — 서버가 확인을 마치고 그 사람의 자리를 잡았다. **이때부터 중지가 닿는다** */
  onOpen?: () => void;
  fetchImpl?: typeof fetch;
};

/**
 * 질문을 보낸다 (D.1). 흐름을 열기 전의 실패(400·404·409·503)는 **`ApiError`로 던지고**, 열린 뒤의 결과는 모두 `end` 한 줄이다.
 * `api()`와 같은 요청 모양(같은 출처 쿠키·CSRF 머리말, 7절)을 쓴다.
 */
export async function askLlm(dto: LlmAskDto, onEvent: (e: LlmStreamEvent) => void, opts: AskOptions = {}): Promise<void> {
  const res = await (opts.fetchImpl ?? fetch)('/api/llm/ask', { ...requestInit({ method: 'POST', json: dto }), signal: opts.signal });
  if (!res.ok || !res.body) throw await readApiError(res);
  opts.onOpen?.();
  await readLlmStream(res.body, onEvent);
}

type TextEvent = Extract<LlmStreamEvent, { type: 'delta' | 'thinking' }>;

/**
 * 흘러오는 글자를 모아 `ms`마다 한 번에 넘긴다 — 조각마다 그리면 답이 길어질수록 느려진다(그릴 때마다 답 전체를 다시 그린다)
 * (검토 반영 — 코드 리뷰). 글자가 아닌 줄(`rethink`·`end` 등)은 **모아 둔 것을 먼저 넘긴 뒤** 곧바로 넘긴다 — 차례가 바뀌지 않는다.
 */
export function batchLlmEvents(onEvent: (e: LlmStreamEvent) => void, ms: number): { push(e: LlmStreamEvent): void; flush(): void; cancel(): void } {
  let pending: TextEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  const flush = () => {
    const p = pending;
    cancel();
    if (p) onEvent(p);
  };
  return {
    push(e) {
      if (e.type !== 'delta' && e.type !== 'thinking') {
        flush();
        onEvent(e);
        return;
      }
      if (pending && pending.type !== e.type) flush();
      pending = pending ? { ...pending, text: pending.text + e.text } : e;
      timer ??= setTimeout(flush, ms);
    },
    flush,
    cancel,
  };
}

/** 지금 흘러나오는 한 쌍 — 저장된 대화를 다시 읽을 때까지 화면에 둔다 */
export type LiveExchange = { question: string; answer: string; thinking: string };

export type ChatState = {
  /**
   * `idle` 묻기 전·끝난 뒤 · `sending` 보냈고 흐름이 열리기를 기다린다 — 서버가 아직 자리를 잡지 않아 **중지가 닿지 않는다** ·
   * `streaming` 받는 중 · `stopping` 멈추라고 했고 끝을 기다린다
   */
  phase: 'idle' | 'sending' | 'streaming' | 'stopping';
  live: LiveExchange | null;
  /** 받지 못했거나 끊긴 까닭 */
  error: string | null;
  /** 알릴 것 — 중지했다·상한 때문에 지웠다 */
  notice: string | null;
  /** 저장되지 않아 입력칸에 되돌릴 질문 (D.5) */
  restore: string | null;
  lastEnd: EndEvent | null;
};

export type ChatAction =
  | { type: 'send'; question: string }
  /** 흐름이 열렸다 — 이제 중지가 닿는다 */
  | { type: 'opened' }
  | { type: 'event'; event: LlmStreamEvent }
  | { type: 'stop' }
  /** 멈출 것이 없다는 답(끝나 가던 중)이거나 멈추라는 요청이 닿지 않았다 — 다시 누를 수 있게 받는 중으로 돌린다 */
  | { type: 'stop-missed' }
  /** 흐름을 열기 전에 실패했다 (`ApiError`) */
  | { type: 'failed'; message: string }
  /** 저장된 대화를 다시 읽었다 — 흘러나오던 것을 내린다 */
  | { type: 'settled' }
  /** 다른 대화로 옮겼다 */
  | { type: 'reset' };

export const initialChat: ChatState = { phase: 'idle', live: null, error: null, notice: null, restore: null, lastEnd: null };

function evictedNotice(n: number): string | null {
  return n > 0 ? `보관 상한을 넘어 오래된 대화 ${n}개를 지웠다` : null;
}

/** 끝 줄이 화면에 무엇을 남기나 (D.1·D.5) */
function onEnd(state: ChatState, e: EndEvent): ChatState {
  const base = { ...state, phase: 'idle' as const, lastEnd: e };
  if (e.saved) {
    const notice = [e.status === 'stopped' ? '중지했다 — 거기까지 저장했다' : null, evictedNotice(e.evicted)].filter(Boolean).join(' · ') || null;
    // 저장은 됐지만 끊긴 답 — 까닭을 말한다(FR-1120). 빈 문장도 까닭이 없는 것이다(`||`)
    return { ...base, notice, error: e.status === 'failed' ? e.message || '답이 중간에 끊겼다' : null, restore: null };
  }
  const fallback = e.status === 'stopped' ? '중지했다 — 답에 글자가 없어 저장하지 않았다' : '답을 받지 못했다';
  return { ...base, notice: null, error: e.message || fallback, restore: state.live?.question ?? null };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send':
      return { phase: 'sending', live: { question: action.question, answer: '', thinking: '' }, error: null, notice: null, restore: null, lastEnd: null };
    case 'opened':
      return state.phase === 'sending' ? { ...state, phase: 'streaming' } : state;
    case 'event': {
      const e = action.event;
      if (e.type === 'end') return onEnd(state, e);
      if (!state.live || e.type === 'ping') return state;
      if (e.type === 'delta') return { ...state, live: { ...state.live, answer: state.live.answer + e.text } };
      // 지금까지 흘러온 답은 생각 과정이었다 (FR-1119) — 생각 과정 쪽으로 옮긴다
      if (e.type === 'rethink') return { ...state, live: { ...state.live, thinking: state.live.thinking + state.live.answer, answer: '' } };
      return { ...state, live: { ...state.live, thinking: state.live.thinking + e.text } };
    }
    case 'stop':
      return state.phase === 'streaming' ? { ...state, phase: 'stopping' } : state;
    case 'stop-missed':
      return state.phase === 'stopping' ? { ...state, phase: 'streaming' } : state;
    case 'failed':
      return { ...state, phase: 'idle', live: null, error: action.message, notice: null, restore: state.live?.question ?? null };
    case 'settled':
      return { ...state, live: null, restore: null };
    case 'reset':
      return initialChat;
  }
}

/** 고정하지 않은 대화의 남은 날 — 화면의 "N일 뒤 지워짐" */
export function daysLeft(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 86_400_000));
}

/** 저장된 답의 상태 표지 — 끝난 답에는 아무것도 달지 않는다 */
export function statusLabel(status: 'done' | 'stopped' | 'failed'): string | null {
  if (status === 'stopped') return '중지됨';
  if (status === 'failed') return '끊김';
  return null;
}
