import { describe, expect, it } from 'vitest';
import { LLM_LIMITS } from '@workfluence/shared';
import { createThinkSplitter, type Piece } from './think';

/**
 * A등급 — **테스트 먼저** (P10_설계서_Llm D.2·FR-1119).
 *
 * reasoning parser를 켜지 않은 vLLM은 Qwen3의 생각 과정을 답 앞에 `<think>…</think>`로 흘린다. 태그가 조각 경계에서
 * 갈라져 온다. **답의 맨 앞에서만** 생각 과정으로 본다 — 가운데의 `<think>`는 답의 글자다.
 */

/** 나온 조각을 종류별로 잇는다 — 조각을 어디서 나누는지는 이 함수의 약속이 아니다 */
function run(chunks: string[]): { thinking: string; answer: string; order: Piece['kind'][] } {
  const s = createThinkSplitter();
  const pieces = [...chunks.flatMap((c) => s.push(c)), ...s.end()];
  const order: Piece['kind'][] = [];
  for (const p of pieces) {
    expect(p.kind === 'rethink' || p.text.length > 0).toBe(true);
    if (order[order.length - 1] !== p.kind) order.push(p.kind);
  }
  return {
    thinking: pieces.map((p) => (p.kind === 'thinking' ? p.text : '')).join(''),
    answer: pieces.map((p) => (p.kind === 'answer' ? p.text : '')).join(''),
    order,
  };
}

describe('createThinkSplitter', () => {
  it('생각 과정이 없으면 모두 답이다', () => {
    expect(run(['안녕', '하세요'])).toEqual({ thinking: '', answer: '안녕하세요', order: ['answer'] });
  });

  it('맨 앞의 `<think>…</think>`를 떼고, 닫는 태그 뒤의 빈 줄은 답에 넣지 않는다', () => {
    expect(run(['<think>\n생각\n</think>\n\n답'])).toEqual({ thinking: '\n생각\n', answer: '답', order: ['thinking', 'answer'] });
  });

  it('**태그가 조각 경계에서 갈라져 와도 된다**', () => {
    expect(run(['<th', 'ink>생', '각</thi', 'nk>', '\n', '\n답'])).toMatchObject({ thinking: '생각', answer: '답' });
    expect(run(['<', 't', 'h', 'i', 'n', 'k', '>', 'a', '<', '/', 't', 'h', 'i', 'n', 'k', '>', 'b'])).toMatchObject({ thinking: 'a', answer: 'b' });
  });

  it('여는 태그 앞의 빈칸·줄바꿈은 버린다', () => {
    expect(run(['\n  <think>a</think>b'])).toMatchObject({ thinking: 'a', answer: 'b' });
  });

  it('**가운데의 `<think>`는 답이다** — HTML 태그를 묻는 질문의 답일 수 있다', () => {
    expect(run(['답 <think> 태그</think> 끝'])).toEqual({ thinking: '', answer: '답 <think> 태그</think> 끝', order: ['answer'] });
  });

  it('`<`로 시작해도 `<think>`가 아니면 곧바로 답이다 — 끝까지 붙들지 않는다', () => {
    const s = createThinkSplitter();
    expect(s.push('<b>굵게')).toEqual([{ kind: 'answer', text: '<b>굵게' }]);
  });

  it('`<think>`의 앞부분만 오고 끝나면 답이다', () => {
    expect(run(['<thi'])).toMatchObject({ thinking: '', answer: '<thi' });
  });

  it('생각하는 중에 끝나면(중지) 생각 과정만 있고 답은 비었다', () => {
    expect(run(['<think>생각 중', '</thi'])).toMatchObject({ thinking: '생각 중</thi', answer: '' });
  });

  it('빈 생각 블록(`/no_think`)은 빈 생각이다 — 답만 남는다', () => {
    expect(run(['<think>\n\n</think>\n\n답'])).toMatchObject({ thinking: '\n\n', answer: '답' });
  });

  it('닫는 태그 뒤의 `</think>`는 답의 글자다', () => {
    expect(run(['<think>a</think>b</think>c'])).toMatchObject({ thinking: 'a', answer: 'b</think>c' });
  });

  it('생각 과정이 없던 답의 앞 줄바꿈은 그대로 둔다 — 답을 고치지 않는다', () => {
    expect(run(['\n안녕'])).toMatchObject({ thinking: '', answer: '\n안녕' });
  });

  it('닫는 태그 뒤가 빈칸뿐이고 끝나면 답은 비었다', () => {
    expect(run(['<think>a</think>', '\n\n'])).toMatchObject({ thinking: 'a', answer: '' });
  });

  it('빈 조각은 아무것도 내지 않는다', () => {
    const s = createThinkSplitter();
    expect(s.push('')).toEqual([]);
    expect(s.end()).toEqual([]);
  });
});

/**
 * 검토 반영 (P10 코드 리뷰 14 · 보안 검토 1). 테스트를 먼저 썼다.
 *
 * Qwen3-*-Thinking-2507처럼 대화 틀이 `<think>`를 미리 넣는 모델은 **닫는 태그만** 낸다 — `생각…</think>답`. 앞에 흘려보낸 것이
 * 생각 과정이었다는 것은 `</think>`를 보고서야 안다. 그래서 `rethink` 표지를 낸다: "지금까지의 답은 생각 과정이었다".
 */
function resolve(chunks: string[]): { thinking: string; answer: string; rethinks: number } {
  const s = createThinkSplitter();
  const pieces = [...chunks.flatMap((c) => s.push(c)), ...s.end()];
  let thinking = '';
  let answer = '';
  let rethinks = 0;
  for (const p of pieces) {
    if (p.kind === 'rethink') {
      rethinks++;
      thinking += answer;
      answer = '';
    } else if (p.kind === 'thinking') thinking += p.text;
    else answer += p.text;
  }
  return { thinking, answer, rethinks };
}

describe('닫는 태그만 오는 모양 (Thinking-2507)', () => {
  it('**앞의 것을 생각 과정으로 돌리고, 닫는 태그 뒤를 답으로**', () => {
    expect(resolve(['Okay… Let me think.\n', '</th', 'ink>\n\nThe answer is 42.'])).toEqual({ thinking: 'Okay… Let me think.\n', answer: 'The answer is 42.', rethinks: 1 });
  });

  it('첫 번째 닫는 태그만 — 그 뒤의 `</think>`는 답의 글자다', () => {
    expect(resolve(['추론</think>답 </think> 끝'])).toEqual({ thinking: '추론', answer: '답 </think> 끝', rethinks: 1 });
  });

  it('**답 안에 여는 태그가 먼저 있었으면 짝이다** — 태그를 묻는 질문의 답', () => {
    expect(resolve(['답 <think> 태그</think> 끝'])).toEqual({ thinking: '', answer: '답 <think> 태그</think> 끝', rethinks: 0 });
    expect(resolve(['답 <thi', 'nk> 태그</thi', 'nk> 끝'])).toEqual({ thinking: '', answer: '답 <think> 태그</think> 끝', rethinks: 0 });
  });

  it('닫는 태그의 앞부분만 오고 끝나면 답이다', () => {
    expect(resolve(['답 </thi'])).toEqual({ thinking: '', answer: '답 </thi', rethinks: 0 });
  });

  it('`</`로 시작해도 닫는 태그가 아니면 그대로 답이다', () => {
    expect(resolve(['a </b> c'])).toEqual({ thinking: '', answer: 'a </b> c', rethinks: 0 });
  });

  it('여는 태그로 시작한 흐름에서는 표지를 내지 않는다', () => {
    expect(resolve(['<think>a</think>b'])).toEqual({ thinking: 'a', answer: 'b', rethinks: 0 });
  });
});

describe('앞 빈칸의 상한', () => {
  it('**빈칸만 끝없이 와도 붙들지 않는다** — 상한을 넘으면 답으로 넘겨 답 상한이 걸리게', () => {
    const s = createThinkSplitter();
    const out = s.push(' '.repeat(LLM_LIMITS.thinkLeadMaxChars + 1));
    expect(out.map((p) => p.kind)).toEqual(['answer']);
  });

  it('상한 안의 빈칸은 여는 태그를 기다린다', () => {
    const s = createThinkSplitter();
    expect(s.push(' '.repeat(10))).toEqual([]);
    expect(s.push('<think>a</think>b').map((p) => p.kind)).toEqual(['thinking', 'answer']);
  });
});
