import { describe, expect, it } from 'vitest';
import { errorStack, errorText } from './error-text';

/**
 * 로그에 가는 오류 문장 (7절 로그 규칙, P10 검토 반영 — 사용자 요청 "로깅 체계를 검토해 줘" 2026-09-25).
 * **drizzle의 문장에는 질의의 매개변수가 그대로 있다** — 문서 본문·질문·지시문이 로그로 샌다. 그 문장은 싣지 않는다.
 */
const pg = Object.assign(new Error('null value in column "title" violates not-null constraint'), { code: '23502', detail: 'Failing row contains (비밀 본문)' });
const drizzle = new Error('Failed query: insert into "page_versions" ("content_json") values ($1)\nparams: {"text":"비밀 본문"}', { cause: pg });

describe('errorText', () => {
  it('**DB 오류는 PostgreSQL의 코드와 문장만** — 질의·매개변수·detail은 싣지 않는다', () => {
    expect(errorText(drizzle)).toBe('23502 null value in column "title" violates not-null constraint');
    expect(errorText(drizzle)).not.toContain('비밀');
  });

  it('원인 없는 drizzle 문장도 싣지 않는다', () => {
    const bare = new Error('Failed query: select … params: 비밀');
    expect(errorText(bare)).toBe('Error (DB 질의 실패 — 문장은 싣지 않는다)');
  });

  it('그 밖의 오류는 이름과 문장, 길면 줄인다', () => {
    expect(errorText(new TypeError('x is not a function'))).toBe('TypeError: x is not a function');
    expect(errorText(new Error('a\nb'))).toBe('Error: a b');
    expect(errorText(new Error('z'.repeat(1000))).length).toBe(500);
    expect(errorText('문자열')).toBe('문자열');
    expect(errorText(42)).toBe('42');
    expect(errorText(new Error('x', { cause: { code: '23503' } }))).toBe('23503');
  });
});

describe('errorStack — 추적 정보도 문장을 싣지 않는다', () => {
  it('첫 줄(문장)을 errorText로 바꾸고 호출 위치만 남긴다', () => {
    const stack = errorStack(drizzle) as string;
    expect(stack.split('\n')[0]).toBe('23502 null value in column "title" violates not-null constraint');
    expect(stack).toMatch(/\n\s+at /);
    expect(stack).not.toContain('비밀');
    expect(stack).not.toContain('params');
  });

  it('오류가 아니면 없다', () => {
    expect(errorStack('x')).toBeUndefined();
  });
});
