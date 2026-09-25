import { describe, expect, it } from 'vitest';
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
    expect(p.text.length).toBeGreaterThan(0);
    if (order[order.length - 1] !== p.kind) order.push(p.kind);
  }
  return {
    thinking: pieces.filter((p) => p.kind === 'thinking').map((p) => p.text).join(''),
    answer: pieces.filter((p) => p.kind === 'answer').map((p) => p.text).join(''),
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
