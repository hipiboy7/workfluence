import { describe, expect, it } from 'vitest';
import { requestIdFrom } from './request-id';

/**
 * A등급 — 요청 식별자의 모양 (P11 D.2, FR-1210). 받은 값은 **로그 줄에 그대로 들어가므로** 모양이 맞을 때만 쓴다 — 아니면
 * 부른 쪽이 새로 만든다(`null`)
 */
describe('requestIdFrom', () => {
  it('nginx의 `$request_id`(32자 16진)와 UUID를 그대로 쓴다', () => {
    expect(requestIdFrom('0f1e2d3c4b5a69788796a5b4c3d2e1f0')).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    expect(requestIdFrom('3f2a7b1c-9d4e-4f60-8a1b-2c3d4e5f6a7b')).toBe('3f2a7b1c-9d4e-4f60-8a1b-2c3d4e5f6a7b');
  });

  it('머리말이 둘이면 첫째', () => {
    expect(requestIdFrom(['abcdef12', 'zzzzzzzz'])).toBe('abcdef12');
  });

  it('**없거나 모양이 틀리면 쓰지 않는다** — 로그 줄을 꾸미는 값(줄바꿈·따옴표·빈칸)도', () => {
    for (const bad of [undefined, '', 'short', 'x'.repeat(65), 'abc def12', 'abcdef12\n{"level":50}', 'abcd"ef12', '한글요청번호입니다', ['bad value'], []]) {
      expect(requestIdFrom(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('길이의 경계 — 8자와 64자는 받는다', () => {
    expect(requestIdFrom('a'.repeat(8))).toBe('a'.repeat(8));
    expect(requestIdFrom('a'.repeat(64))).toBe('a'.repeat(64));
    expect(requestIdFrom('a'.repeat(7))).toBeNull();
  });
});
