import { describe, expect, it } from 'vitest';
import { dbErrorText } from './db-error';

/** B등급 — 로그에 무엇이 가나 (FR-1117). **매개변수가 실린 drizzle 문장은 가지 않는다** */
describe('dbErrorText', () => {
  it('PostgreSQL의 코드와 문장만 — 질의와 매개변수는 싣지 않는다', () => {
    const pg = Object.assign(new Error('relation "llm_conversations" does not exist'), { code: '42P01', detail: 'Key (x)=(비밀 질문)' });
    const drizzle = new Error('Failed query: insert into "llm_messages" … params: 비밀 질문,비밀 답', { cause: pg });
    const out = dbErrorText(drizzle);
    expect(out).toBe('42P01 relation "llm_conversations" does not exist');
    expect(out).not.toContain('비밀');
  });

  it('원인이 없으면 이름만 — 문장은 싣지 않는다', () => {
    expect(dbErrorText(new TypeError('params: 비밀'))).toBe('TypeError');
    expect(dbErrorText('문자열')).toBe('string');
    expect(dbErrorText(new Error('x', { cause: { code: '23503' } }))).toBe('23503');
  });
});
