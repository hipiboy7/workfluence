import { describe, expect, it } from 'vitest';
import { buildChatRequest, createSseParser, readChatChunk, readErrorMessage, readModelIds } from './openai';

/**
 * A등급 — **테스트 먼저** (P10_설계서_Llm D.2).
 *
 * 사내 LLM 서버(vLLM)의 흐름은 OpenAI 호환 SSE다. 조각이 줄 가운데서 끊겨 오고, 생각 과정이 다른 필드로 오고, 오류가
 * 두 모양으로 온다. **실연동 확인은 보류 29다** — 여기 모양은 vLLM 문서와 OpenAI 형식에서 온 가정이다.
 */

describe('createSseParser — SSE를 이벤트 자료로 나눈다', () => {
  it('`data:` 줄과 빈 줄이 이벤트 하나다', () => {
    const p = createSseParser();
    expect(p.push('data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('**조각이 줄 가운데서 끊겨 와도 된다**', () => {
    const p = createSseParser();
    expect(p.push('da')).toEqual([]);
    expect(p.push('ta: x')).toEqual([]);
    expect(p.push('\n')).toEqual([]);
    expect(p.push('\ndata: y\n\n')).toEqual(['x', 'y']);
  });

  it('CRLF와 CR도 줄 끝이다', () => {
    expect(createSseParser().push('data: x\r\n\r\ndata: y\r\r')).toEqual(['x', 'y']);
  });

  it('CRLF가 조각 경계에서 갈라져도 빈 줄을 하나 더 만들지 않는다', () => {
    const p = createSseParser();
    expect(p.push('data: x\r')).toEqual([]);
    expect(p.push('\ndata: y\r\n\r\n')).toEqual(['x\ny']);
  });

  it('`:`로 시작하는 줄(살아 있음)과 다른 칸(event·id·retry)은 버린다', () => {
    expect(createSseParser().push(': keep-alive\n\nevent: message\nid: 3\nretry: 10\ndata: z\n\n')).toEqual(['z']);
  });

  it('`data:` 줄이 여럿이면 줄바꿈으로 잇는다 (SSE 규칙)', () => {
    expect(createSseParser().push('data: a\ndata: b\n\n')).toEqual(['a\nb']);
  });

  it('콜론 뒤 빈칸은 하나만 뗀다', () => {
    expect(createSseParser().push('data:x\n\ndata:  y\n\n')).toEqual(['x', ' y']);
  });

  it('`data`만 있는 줄은 빈 자료다', () => {
    expect(createSseParser().push('data\ndata: a\n\n')).toEqual(['\na']);
  });

  it('**빈 줄 없이 끝나도 마지막 이벤트를 잃지 않는다**', () => {
    const p = createSseParser();
    expect(p.push('data: tail')).toEqual([]);
    expect(p.end()).toEqual(['tail']);
    expect(p.end()).toEqual([]);
  });

  it('`[DONE]`도 자료로 넘긴다 — 판단은 읽는 쪽이 한다', () => {
    expect(createSseParser().push('data: [DONE]\n\n')).toEqual(['[DONE]']);
  });
});

describe('readChatChunk — 조각 하나를 읽는다', () => {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra });

  it('`delta.content`가 답이다', () => {
    expect(readChatChunk(chunk({ content: '안녕' }))).toMatchObject({ answer: '안녕', thinking: '', done: false, error: null });
  });

  it('생각 과정은 `reasoning_content`로도 `reasoning`으로도 온다 (FR-1119)', () => {
    expect(readChatChunk(chunk({ reasoning_content: '음' })).thinking).toBe('음');
    expect(readChatChunk(chunk({ reasoning: '흠' })).thinking).toBe('흠');
  });

  it('역할만 있는 첫 조각·`null` 내용은 빈 글자다', () => {
    expect(readChatChunk(chunk({ role: 'assistant', content: '' }))).toMatchObject({ answer: '', thinking: '' });
    expect(readChatChunk(chunk({ content: null })).answer).toBe('');
    expect(readChatChunk(chunk({ content: 3 })).answer).toBe('');
  });

  it('`finish_reason`을 읽는다', () => {
    const data = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
    expect(readChatChunk(data).finish).toBe('length');
  });

  it('마지막 조각의 `usage`로 토큰 수를 읽는다 — `choices`가 비어 온다', () => {
    const data = JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } });
    expect(readChatChunk(data).usage).toEqual({ promptTokens: 12, completionTokens: 34 });
    expect(readChatChunk(JSON.stringify({ choices: [], usage: { prompt_tokens: 'x' } })).usage).toBeNull();
  });

  it('`[DONE]`은 끝이다', () => {
    expect(readChatChunk('[DONE]')).toMatchObject({ done: true, error: null });
  });

  it('흐름 안의 오류를 두 모양 다 읽는다', () => {
    expect(readChatChunk(JSON.stringify({ error: { message: 'boom', type: 'x' } })).error).toBe('boom');
    expect(readChatChunk(JSON.stringify({ object: 'error', message: 'bad' })).error).toBe('bad');
  });

  it('JSON이 아니면 오류다 — 모르는 것을 답으로 보여 주지 않는다', () => {
    expect(readChatChunk('<html>').error).toMatch(/읽을 수 없다/);
    expect(readChatChunk('null').error).toMatch(/읽을 수 없다/);
  });
});

describe('readErrorMessage — 거절의 까닭 (FR-1120)', () => {
  it('vLLM 모양', () => {
    const body = JSON.stringify({ object: 'error', message: "This model's maximum context length is 32768 tokens.", type: 'BadRequestError', code: 400 });
    expect(readErrorMessage(400, body)).toBe("This model's maximum context length is 32768 tokens.");
  });

  it('OpenAI 모양', () => {
    expect(readErrorMessage(401, JSON.stringify({ error: { message: 'invalid api key' } }))).toBe('invalid api key');
  });

  it('**JSON이 아니면 상태 코드만** — 프록시의 HTML 오류 쪽을 화면에 쏟지 않는다', () => {
    expect(readErrorMessage(502, '<html><body>502 Bad Gateway</body></html>')).toBe('HTTP 502');
    expect(readErrorMessage(500, '')).toBe('HTTP 500');
    expect(readErrorMessage(500, JSON.stringify({ message: 5 }))).toBe('HTTP 500');
  });

  it('길면 300자로 줄이고 공백을 모은다', () => {
    const out = readErrorMessage(400, JSON.stringify({ message: `a\n\n${'x'.repeat(400)}` }));
    expect(out.length).toBe(300);
    expect(out.startsWith('a x')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('readModelIds — 연결 확인 (FR-1105)', () => {
  it('`data[].id`를 모은다', () => {
    expect(readModelIds({ object: 'list', data: [{ id: 'Qwen/Qwen3-32B' }, { id: 'x' }] })).toEqual(['Qwen/Qwen3-32B', 'x']);
  });

  it('id가 없는 것은 건너뛰고, 모양이 아니면 null', () => {
    expect(readModelIds({ data: [{ id: 'a' }, { name: 'b' }, 3] })).toEqual(['a']);
    expect(readModelIds({ models: [] })).toBeNull();
    expect(readModelIds(null)).toBeNull();
    expect(readModelIds('x')).toBeNull();
  });
});

describe('buildChatRequest', () => {
  it('흘려보내기와 토큰 수를 켠다', () => {
    expect(buildChatRequest('m', [{ role: 'user', content: 'q' }])).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });
});
