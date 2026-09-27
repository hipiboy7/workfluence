import { describe, expect, it } from 'vitest';
import { argonSlots } from './argon-slots';

/**
 * A등급 — 한 프로세스에서 한꺼번에 도는 argon2의 수 (P13 FR-1433, 병합 전 코드 리뷰 9).
 *
 * argon2(node-argon2)는 Node의 작업 스레드 풀(libuv, 기본 4개)에서 돈다. 그 풀은 정적 파일·첨부 읽기·쓰기·DNS 조회도 쓴다 — 상한이
 * 코어 수이면 4코어가 넘는 서버에서 몰린 로그인이 풀을 다 쥐어, 그동안 화면 파일과 첨부가 argon2 뒤에 선다. 그래서 **풀에 한 자리는
 * 남긴다.** 코어가 더 적으면 코어 수가 상한이다(측정 S0a — 코어를 넘겨 돌려도 처리량은 늘지 않았다)
 */
describe('argonSlots', () => {
  it('코어가 풀보다 적으면 코어 수 — 이 서버(2코어)는 2', () => {
    expect(argonSlots(2, 4)).toBe(2);
    expect(argonSlots(3, 4)).toBe(3);
  });

  it('**풀에 한 자리를 남긴다** — 8코어·풀 4이면 3', () => {
    expect(argonSlots(8, 4)).toBe(3);
    expect(argonSlots(4, 4)).toBe(3);
    expect(argonSlots(16, 16)).toBe(15);
  });

  it('적어도 하나 — 1코어, 풀이 하나뿐일 때도', () => {
    expect(argonSlots(1, 4)).toBe(1);
    expect(argonSlots(8, 1)).toBe(1);
  });

  it('**값을 읽지 못하면 안전한 쪽** — 코어 수를 모르면 1, 풀 크기를 모르면 Node의 기본 4로 본다', () => {
    expect(argonSlots(Number.NaN, 4)).toBe(1);
    expect(argonSlots(0, 4)).toBe(1);
    expect(argonSlots(8, Number.NaN)).toBe(3);
    expect(argonSlots(8, 0)).toBe(3);
  });
});
