import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, LOG_EVENTS } from './constants';

/** 설계 고정값 중 **이름의 모양**이 규칙인 것 (P11 D.4, FR-1214·1218) */

describe('LOG_EVENTS — 로그 줄의 안정된 event 코드', () => {
  it('**`영역.일` 두 마디, 소문자와 밑줄** — 문장을 고쳐도 코드는 그대로다', () => {
    for (const e of LOG_EVENTS) expect(e, e).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it('겹치지 않는다', () => {
    expect(new Set(LOG_EVENTS).size).toBe(LOG_EVENTS.length);
  });

  it('요청의 두 줄 — 접근 로그와 처리되지 않은 예외 — 가 있다', () => {
    expect(LOG_EVENTS).toContain('http.request');
    expect(LOG_EVENTS).toContain('http.unhandled');
  });

  it('영역은 정해진 것만 — 기동·요청·헬스·세션·메일·LLM·실시간 편집', () => {
    const areas = new Set(LOG_EVENTS.map((e) => e.split('.')[0]));
    expect([...areas].sort()).toEqual(['app', 'collab', 'health', 'http', 'llm', 'mail', 'session']);
  });
});

describe('AUDIT_ACTIONS — P11', () => {
  it('위임을 바꾸면 남는다 (FR-1205)', () => {
    expect(AUDIT_ACTIONS).toContain('user.grants.change');
  });
});
