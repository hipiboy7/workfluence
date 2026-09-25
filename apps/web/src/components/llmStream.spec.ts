import { CSRF_HEADER, encodeLlmEvent, type LlmStreamEvent } from '@workfluence/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { LOST_END, askLlm, batchLlmEvents, chatReducer, daysLeft, initialChat, readLlmStream, statusLabel, type ChatState } from './llmStream';

/**
 * LLM 질문의 흐름 하나와 화면 상태 기계 — **브라우저 없이** 본다 (P10_설계서_Llm D.1·D.5·G절, 3절).
 * 무엇이 그려지는지는 `LlmPage.spec.tsx`가, 화면 전체의 흐름은 E2E가 본다.
 */

type End = Extract<LlmStreamEvent, { type: 'end' }>;
const end = (over: Partial<End> = {}): End => ({ type: 'end', status: 'done', saved: true, conversationId: 'c1', evicted: 0, message: null, ...over });
const run = (actions: Parameters<typeof chatReducer>[1][], from: ChatState = initialChat) => actions.reduce(chatReducer, from);
const sending = run([{ type: 'send', question: '질문' }]);
/** 흐름이 열렸다 — 서버가 자리를 잡았다 */
const streaming = run([{ type: 'opened' }], sending);

/** 바이트 조각을 차례로 내는 흐름 — 조각 경계는 시험이 정한다 */
function bodyOf(chunks: Uint8Array[], failAt = -1): ReadableStream<Uint8Array> {
  let i = 0;
  return {
    getReader: () => ({
      read: () => {
        if (i === failAt) return Promise.reject(new Error('끊김'));
        return Promise.resolve(i < chunks.length ? { done: false as const, value: chunks[i++] } : { done: true as const, value: undefined });
      },
    }),
  } as unknown as ReadableStream<Uint8Array>;
}
const enc = new TextEncoder();

describe('chatReducer — 받는 동안', () => {
  it('보내면 보내는 중이 되고 앞의 알림·오류를 지운다 — 흐름이 열리면 받는 중', () => {
    const s = run([{ type: 'failed', message: '앞 오류' }, { type: 'send', question: '질문' }]);
    expect(s).toEqual({ phase: 'sending', live: { question: '질문', answer: '', thinking: '' }, error: null, notice: null, restore: null, lastEnd: null });
    expect(run([{ type: 'opened' }], s).phase).toBe('streaming');
    // 열리는 것은 보내는 중에만 — 끝난 뒤 늦게 온 것은 버린다
    expect(run([{ type: 'opened' }]).phase).toBe('idle');
  });

  it('답과 생각 과정을 따로 이어 붙이고, 살아 있음 줄은 아무것도 바꾸지 않는다', () => {
    const s = run(
      [
        { type: 'event', event: { type: 'thinking', text: '음' } },
        { type: 'event', event: { type: 'delta', text: '안' } },
        { type: 'event', event: { type: 'ping' } },
        { type: 'event', event: { type: 'delta', text: '녕' } },
      ],
      sending,
    );
    expect(s.live).toEqual({ question: '질문', answer: '안녕', thinking: '음' });
  });

  it('흐르는 것이 없을 때 온 조각은 버린다', () => {
    expect(run([{ type: 'event', event: { type: 'delta', text: 'x' } }])).toEqual(initialChat);
  });

  it('**`rethink` — 지금까지의 답을 생각 과정으로 옮긴다** (FR-1119)', () => {
    const s = run(
      [
        { type: 'event', event: { type: 'delta', text: '곰곰이…' } },
        { type: 'event', event: { type: 'rethink' } },
        { type: 'event', event: { type: 'delta', text: '42' } },
      ],
      streaming,
    );
    expect(s.live).toEqual({ question: '질문', answer: '42', thinking: '곰곰이…' });
  });

  it('**중지는 흐름이 열린 뒤에만** — 그 전에는 서버가 자리를 잡지 않아 멈출 것이 없다 (검토 반영)', () => {
    expect(run([{ type: 'stop' }], sending).phase).toBe('sending');
    expect(run([{ type: 'stop' }], streaming).phase).toBe('stopping');
    expect(run([{ type: 'stop' }]).phase).toBe('idle');
  });

  it('**멈출 것이 없었다는 답이면 다시 누를 수 있게** 받는 중으로 돌린다 — 끝난 뒤면 그대로', () => {
    const stopping = run([{ type: 'stop' }], streaming);
    expect(run([{ type: 'stop-missed' }], stopping).phase).toBe('streaming');
    expect(run([{ type: 'stop-missed' }], streaming).phase).toBe('streaming');
    expect(run([{ type: 'event', event: end() }, { type: 'stop-missed' }], stopping).phase).toBe('idle');
  });
});

describe('chatReducer — 끝 줄 (D.1·D.5)', () => {
  it('저장되면 알림 없이 끝나고, 상한 때문에 지운 것이 있으면 수를 말한다', () => {
    expect(run([{ type: 'event', event: end() }], sending)).toMatchObject({ phase: 'idle', error: null, notice: null, restore: null });
    expect(run([{ type: 'event', event: end({ evicted: 2 }) }], sending).notice).toBe('보관 상한을 넘어 오래된 대화 2개를 지웠다');
  });

  it('중지돼 저장되면 그렇게 말한다', () => {
    expect(run([{ type: 'event', event: end({ status: 'stopped', evicted: 1 }) }], sending).notice).toBe(
      '중지했다 — 거기까지 저장했다 · 보관 상한을 넘어 오래된 대화 1개를 지웠다',
    );
  });

  it('저장됐지만 끊긴 답은 까닭을 말한다', () => {
    expect(run([{ type: 'event', event: end({ status: 'failed', message: 'boom' }) }], sending).error).toBe('boom');
    expect(run([{ type: 'event', event: end({ status: 'failed' }) }], sending).error).toBe('답이 중간에 끊겼다');
    // 빈 문장도 까닭이 없는 것이다
    expect(run([{ type: 'event', event: end({ status: 'failed', message: '' }) }], sending).error).toBe('답이 중간에 끊겼다');
  });

  it('**저장되지 않으면 까닭을 말하고 질문을 되돌린다**', () => {
    const s = run([{ type: 'event', event: end({ status: 'failed', saved: false, conversationId: null, message: 'LLM 서버에 닿지 않는다' }) }], sending);
    expect(s).toMatchObject({ phase: 'idle', error: 'LLM 서버에 닿지 않는다', restore: '질문' });
    expect(run([{ type: 'event', event: end({ status: 'stopped', saved: false }) }], sending).error).toMatch(/글자가 없어/);
    expect(run([{ type: 'event', event: end({ status: 'failed', saved: false }) }], sending).error).toBe('답을 받지 못했다');
    expect(run([{ type: 'event', event: end({ status: 'failed', saved: false, message: '' }) }], sending).error).toBe('답을 받지 못했다');
  });

  it('흐름을 열기 전의 실패도 질문을 되돌리고 흐르던 것을 내린다', () => {
    const s = run([{ type: 'failed', message: '이미 답을 받고 있다' }], sending);
    expect(s).toMatchObject({ phase: 'idle', live: null, error: '이미 답을 받고 있다', restore: '질문' });
  });

  it('저장된 대화를 다시 읽으면 흐르던 것을 내린다 — 알림은 남는다', () => {
    const s = run([{ type: 'event', event: end({ evicted: 1 }) }, { type: 'settled' }], sending);
    expect(s.live).toBeNull();
    expect(s.notice).toMatch(/1개/);
    expect(run([{ type: 'reset' }], s)).toEqual(initialChat);
  });
});

describe('readLlmStream — 흐름을 끝까지 읽는다', () => {
  it('**줄이 조각 경계에서, 글자가 바이트 가운데서 갈라져 와도 된다**', async () => {
    const bytes = enc.encode(encodeLlmEvent({ type: 'delta', text: '안녕하세요' }) + encodeLlmEvent(end()));
    // 첫 줄 가운데(10)와 '안'(24~26, 3바이트)의 가운데(25)를 가른다 — `{"type":"delta","text":"`가 24바이트다
    expect(new TextDecoder().decode(bytes.slice(24, 27))).toBe('안');
    const cuts = [0, 10, 25, bytes.length];
    const chunks = cuts.slice(1).map((c, i) => bytes.slice(cuts[i], c));
    const events: LlmStreamEvent[] = [];
    await readLlmStream(bodyOf(chunks), (e) => events.push(e));
    expect(events).toEqual([{ type: 'delta', text: '안녕하세요' }, end()]);
  });

  it('모양이 틀린 줄은 버리고, 끝 줄 뒤에 온 것도 버린다 — 끝은 한 번이다', async () => {
    const text = `그냥 글자\n${encodeLlmEvent({ type: 'ping' })}${encodeLlmEvent(end())}${encodeLlmEvent({ type: 'delta', text: '늦음' })}${encodeLlmEvent(end({ saved: false }))}`;
    const events: LlmStreamEvent[] = [];
    await readLlmStream(bodyOf([enc.encode(text)]), (e) => events.push(e));
    expect(events).toEqual([{ type: 'ping' }, end()]);
  });

  it('마지막 줄에 줄바꿈이 없어도 읽는다', async () => {
    const events: LlmStreamEvent[] = [];
    await readLlmStream(bodyOf([enc.encode(encodeLlmEvent(end()).trimEnd())]), (e) => events.push(e));
    expect(events).toEqual([end()]);
  });

  it('**끝 줄 없이 끊기면 끝을 대신 말한다** — 저장됐는지 모르므로 목록을 다시 보라고', async () => {
    const a: LlmStreamEvent[] = [];
    await readLlmStream(bodyOf([enc.encode(encodeLlmEvent({ type: 'delta', text: '반' }))]), (e) => a.push(e));
    expect(a).toEqual([{ type: 'delta', text: '반' }, LOST_END]);
    const b: LlmStreamEvent[] = [];
    await readLlmStream(bodyOf([enc.encode(encodeLlmEvent({ type: 'delta', text: '반' }))], 1), (e) => b.push(e));
    expect(b.at(-1)).toEqual(LOST_END);
  });
});

describe('askLlm — 질문을 보낸다', () => {
  it('같은 출처 쿠키·CSRF 머리말·JSON 몸통으로 보내고 흐름을 읽는다 — **흐름이 열렸다고 먼저 알린다**', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, body: bodyOf([enc.encode(encodeLlmEvent({ type: 'delta', text: 'a' }) + encodeLlmEvent(end()))]) } as unknown as Response),
    );
    const seen: string[] = [];
    const ac = new AbortController();
    await askLlm({ providerId: 'p', question: 'q' }, (e) => seen.push(e.type), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: ac.signal,
      onOpen: () => seen.push('opened'),
    });
    expect(seen).toEqual(['opened', 'delta', 'end']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/llm/ask');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ providerId: 'p', question: 'q' }), signal: ac.signal });
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('1');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('**흐름을 열기 전의 실패는 `ApiError`로 던진다** — 서버의 문장 그대로. 열렸다고 알리지 않는다', async () => {
    const fetchImpl = () => Promise.resolve({ ok: false, status: 409, body: null, text: () => Promise.resolve(JSON.stringify({ message: '이미 답을 받고 있다' })) } as unknown as Response);
    const onOpen = vi.fn();
    const e = await askLlm({ providerId: 'p', question: 'q' }, () => undefined, { fetchImpl: fetchImpl as unknown as typeof fetch, onOpen }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(409);
    expect((e as ApiError).message).toBe('이미 답을 받고 있다');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('성공인데 흐름이 없으면 그것도 오류다', async () => {
    const fetchImpl = () => Promise.resolve({ ok: true, status: 200, body: null, text: () => Promise.resolve('') } as unknown as Response);
    await expect(askLlm({ providerId: 'p', question: 'q' }, () => undefined, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('batchLlmEvents — 글자를 모아 그린다', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('**같은 종류의 글자는 간격마다 한 번에**, 종류가 바뀌면 앞의 것을 먼저', () => {
    vi.useFakeTimers();
    const out: LlmStreamEvent[] = [];
    const b = batchLlmEvents((e) => out.push(e), 50);
    b.push({ type: 'thinking', text: '음' });
    b.push({ type: 'thinking', text: '…' });
    b.push({ type: 'delta', text: '안' });
    b.push({ type: 'delta', text: '녕' });
    expect(out).toEqual([{ type: 'thinking', text: '음…' }]);
    vi.advanceTimersByTime(50);
    expect(out).toEqual([
      { type: 'thinking', text: '음…' },
      { type: 'delta', text: '안녕' },
    ]);
  });

  it('**글자가 아닌 줄은 모아 둔 것을 먼저 넘긴 뒤 곧바로** — 차례가 바뀌지 않는다', () => {
    vi.useFakeTimers();
    const out: LlmStreamEvent[] = [];
    const b = batchLlmEvents((e) => out.push(e), 50);
    b.push({ type: 'delta', text: '곰곰이' });
    b.push({ type: 'rethink' });
    b.push({ type: 'delta', text: '42' });
    b.push(end());
    expect(out).toEqual([{ type: 'delta', text: '곰곰이' }, { type: 'rethink' }, { type: 'delta', text: '42' }, end()]);
    // 넘긴 뒤 남은 타이머가 같은 것을 두 번 넘기지 않는다
    vi.advanceTimersByTime(100);
    expect(out).toHaveLength(4);
  });

  it('그만두면(`cancel`) 모아 둔 것을 버린다 — 떠난 화면에 그리지 않는다', () => {
    vi.useFakeTimers();
    const out: LlmStreamEvent[] = [];
    const b = batchLlmEvents((e) => out.push(e), 50);
    b.push({ type: 'delta', text: 'x' });
    b.cancel();
    vi.advanceTimersByTime(100);
    b.flush();
    expect(out).toEqual([]);
  });
});

describe('표시 도우미', () => {
  const now = Date.parse('2026-09-25T00:00:00Z');
  it('남은 날은 올림이고 지났으면 0', () => {
    expect(daysLeft('2026-09-28T05:00:00Z', now)).toBe(4);
    expect(daysLeft('2026-09-25T00:00:00Z', now)).toBe(0);
    expect(daysLeft('2026-09-20T00:00:00Z', now)).toBe(0);
  });
  it('끝난 답에는 표지가 없다', () => {
    expect([statusLabel('done'), statusLabel('stopped'), statusLabel('failed')]).toEqual([null, '중지됨', '끊김']);
  });
});
