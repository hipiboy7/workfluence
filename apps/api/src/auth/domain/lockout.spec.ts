import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from '@workfluence/shared';
import { afterSuccess, isLocked, lockAfterFailure, remainingLockMs } from './lockout';

/** A등급 (P1_설계서_Auth 0절). 테스트를 먼저 썼다. 시계는 주입한다. */

const T0 = new Date('2026-09-21T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const policy = PASSWORD_POLICY;

describe('isLocked', () => {
  it('lockedUntil이 없으면 잠기지 않았다', () => {
    expect(isLocked({ failedAttempts: 4, lockedUntil: null }, T0)).toBe(false);
  });

  it('잠금 시각 이전이면 잠겨 있다', () => {
    expect(isLocked({ failedAttempts: 5, lockedUntil: at(15 * MIN) }, T0)).toBe(true);
  });

  it('잠금 시각 1ms 전은 아직 잠김, 정각과 이후는 풀림', () => {
    const state = { failedAttempts: 5, lockedUntil: at(15 * MIN) };
    expect(isLocked(state, at(15 * MIN - 1))).toBe(true);
    expect(isLocked(state, at(15 * MIN))).toBe(false);
    expect(isLocked(state, at(15 * MIN + 1))).toBe(false);
  });

  it('시간이 지나면 저절로 풀린다 — 상태를 고쳐 쓰지 않아도 된다', () => {
    // '잠김'을 status에 저장하지 않는 이유가 이것이다 (schema.ts 주석)
    expect(isLocked({ failedAttempts: 5, lockedUntil: at(1) }, at(999 * MIN))).toBe(false);
  });
});

describe('afterSuccess', () => {
  it('성공하면 횟수와 잠금을 모두 지운다', () => {
    expect(afterSuccess()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});

describe('remainingLockMs — 관리자 화면 표시용', () => {
  it('잠겨 있으면 남은 시간, 아니면 0', () => {
    const s = { failedAttempts: 5, lockedUntil: at(15 * MIN) };
    expect(remainingLockMs(s, at(5 * MIN))).toBe(10 * MIN);
    expect(remainingLockMs(s, at(20 * MIN))).toBe(0);
    expect(remainingLockMs({ failedAttempts: 0, lockedUntil: null }, T0)).toBe(0);
  });
});

/**
 * **틀린 확인 뒤의 잠금** (P13 D.4, FR-1431). 실패 횟수는 DB가 한 문장으로 올리고(`failed_attempts + 1 RETURNING`), 올린 뒤의 수로
 * 잠글지 정한다 — 읽고 계산해 다시 쓰면 동시에 온 요청이 서로를 덮는다(측정 S3)
 */
describe('lockAfterFailure — 올린 뒤의 실패 횟수로 잠글지 (P13 FR-1431)', () => {
  it('기준에 닿으면 지금부터 잠근다', () => {
    expect(lockAfterFailure(policy.lockoutThreshold, T0, policy)).toEqual(at(policy.lockoutMinutes * MIN));
  });

  it('**기준을 넘어서도 잠근다** — 잠금이 풀린 뒤의 실패는 다시 잠근다(성공하기 전까지 횟수는 지워지지 않는다)', () => {
    expect(lockAfterFailure(policy.lockoutThreshold + 3, T0, policy)).toEqual(at(policy.lockoutMinutes * MIN));
    expect(lockAfterFailure(policy.lockoutThreshold + 3, at(90 * MIN), policy)).toEqual(at((90 + policy.lockoutMinutes) * MIN));
  });

  it('기준 전이면 잠그지 않는다', () => {
    expect(lockAfterFailure(policy.lockoutThreshold - 1, T0, policy)).toBeNull();
    expect(lockAfterFailure(1, T0, policy)).toBeNull();
  });
});
