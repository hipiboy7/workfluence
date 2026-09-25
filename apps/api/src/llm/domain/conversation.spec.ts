import { LLM_LIMITS } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { buildChatMessages, canPin, conversationTitle, expiresAt, retentionCutoff } from './conversation';

/** A등급 — **테스트 먼저** (P10_설계서_Llm D.2·D.3·D.5, FR-1119·1127·1131·1133). */

describe('conversationTitle', () => {
  it('첫 질문의 첫 줄', () => {
    expect(conversationTitle('회의록을 요약해 줘\n\n본문…')).toBe('회의록을 요약해 줘');
  });

  it('앞의 빈 줄과 앞뒤 빈칸을 건너뛴다', () => {
    expect(conversationTitle('\n\n   이것이 제목   \n둘째')).toBe('이것이 제목');
  });

  it(`${LLM_LIMITS.titleChars}자를 넘으면 자르고 말줄임표`, () => {
    const out = conversationTitle('가'.repeat(100));
    expect(out).toBe(`${'가'.repeat(LLM_LIMITS.titleChars)}…`);
  });

  it('**글자 단위로 자른다** — 한글·이모지가 반쪽으로 깨지지 않게', () => {
    const out = conversationTitle('😀'.repeat(100));
    expect(out).toBe(`${'😀'.repeat(LLM_LIMITS.titleChars)}…`);
  });

  it('빈 질문이면 이름 없음', () => {
    expect(conversationTitle('  \n ')).toBe('(제목 없음)');
  });
});

describe('buildChatMessages — LLM에 보내는 것 (D.2)', () => {
  it('지시문 · 이력 · 이번 질문 차례다', () => {
    expect(
      buildChatMessages('세 줄로 답한다', [
        { role: 'user', content: '첫 질문' },
        { role: 'assistant', content: '첫 답' },
      ], '둘째 질문'),
    ).toEqual([
      { role: 'system', content: '세 줄로 답한다' },
      { role: 'user', content: '첫 질문' },
      { role: 'assistant', content: '첫 답' },
      { role: 'user', content: '둘째 질문' },
    ]);
  });

  it('지시문이 없거나 비었으면 system이 없다', () => {
    expect(buildChatMessages(null, [], 'q')).toEqual([{ role: 'user', content: 'q' }]);
    expect(buildChatMessages('  \n', [], 'q')).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('**빈 답은 이력에 넣지 않는다** — 중지돼 글자가 없던 답', () => {
    expect(
      buildChatMessages(null, [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 'b' },
      ], 'c'),
    ).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
  });
});

describe('보존 기간 (D.5)', () => {
  const now = new Date('2026-09-25T00:00:00.000Z');

  it('기준 시각은 지금에서 N일 전이다', () => {
    expect(retentionCutoff(now, 7).toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('지워지는 시각은 기준에서 N일 뒤다', () => {
    expect(expiresAt(new Date('2026-09-20T12:00:00.000Z'), 7).toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  it('두 함수는 같은 경계를 쓴다 — 지워질 시각이 지금이면 기준 시각이 곧 그 대화의 기준이다', () => {
    const from = retentionCutoff(now, 7);
    expect(expiresAt(from, 7).getTime()).toBe(now.getTime());
  });
});

describe('canPin (FR-1133)', () => {
  it('상한 아래면 된다', () => {
    expect(canPin(19, 20)).toBe(true);
    expect(canPin(0, 1)).toBe(true);
  });

  it('차면 안 된다 — 상한을 지금보다 낮춘 경우도', () => {
    expect(canPin(20, 20)).toBe(false);
    expect(canPin(25, 20)).toBe(false);
    expect(canPin(0, 0)).toBe(false);
  });
});
