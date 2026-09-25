import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, LOG_EVENTS, REQUEST_ID_PATTERN } from './constants';

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

  it('영역은 정해진 것만 — 기동·요청·헬스·인증·세션·메일·LLM·실시간 편집', () => {
    const areas = new Set(LOG_EVENTS.map((e) => e.split('.')[0]));
    expect([...areas].sort()).toEqual(['app', 'auth', 'collab', 'health', 'http', 'llm', 'mail', 'session']);
  });

  it('**사내 IdP와의 처리가 실패하면 남는 줄이 있다** — 바깥 탓이라 warn이다 (FR-1215, P11 코드 리뷰)', () => {
    expect(LOG_EVENTS).toContain('auth.oidc_failed');
  });
});

describe('REQUEST_ID_PATTERN — 요청 식별자의 모양 (P11 D.2) — 앱이 받는 머리말과 감사 조회가 같은 판정을 쓴다', () => {
  it('nginx의 32자 16진과 앱의 UUID를 받는다', () => {
    for (const ok of ['c4f74de7a73ff592ec5ec63e597de58b', '8ca77575-3994-4302-8f0f-73e0f7a91839', 'req-0001']) expect(REQUEST_ID_PATTERN.test(ok), ok).toBe(true);
  });

  it('**줄바꿈·따옴표·공백**, 8자 미만·64자 초과는 받지 않는다 — 로그 줄을 꾸미는 값이다', () => {
    for (const bad of ['bad id "x"', 'abc\ndef-ghij', 'short', 'x'.repeat(65), '', 'abcdefgh ']) expect(REQUEST_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('AUDIT_ACTIONS — P11', () => {
  it('위임을 바꾸면 남는다 (FR-1205)', () => {
    expect(AUDIT_ACTIONS).toContain('user.grants.change');
  });
});
