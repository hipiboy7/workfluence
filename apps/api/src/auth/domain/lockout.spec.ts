import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from '@workfluence/shared';
import { admitAttempt, afterFailure, afterSuccess, isLocked, lockAfterFailure, lockExpiredReserveCount, remainingLockMs } from './lockout';

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

describe('afterFailure (FR-205)', () => {
  it('임계 미만이면 횟수만 올리고 잠그지 않는다', () => {
    const s1 = afterFailure({ failedAttempts: 0, lockedUntil: null }, T0, policy);
    expect(s1).toEqual({ failedAttempts: 1, lockedUntil: null });
    const s4 = afterFailure({ failedAttempts: 3, lockedUntil: null }, T0, policy);
    expect(s4).toEqual({ failedAttempts: 4, lockedUntil: null });
  });

  it('임계(5회)에 도달하면 잠근다', () => {
    const s = afterFailure({ failedAttempts: 4, lockedUntil: null }, T0, policy);
    expect(s.failedAttempts).toBe(5);
    expect(s.lockedUntil).toEqual(at(policy.lockoutMinutes * MIN));
    expect(isLocked(s, T0)).toBe(true);
  });

  it('잠긴 뒤 또 실패하면 잠금 시각이 뒤로 밀린다', () => {
    const locked = { failedAttempts: 5, lockedUntil: at(15 * MIN) };
    const next = afterFailure(locked, at(10 * MIN), policy);
    expect(next.failedAttempts).toBe(6);
    expect(next.lockedUntil).toEqual(at(25 * MIN));
  });

  it('입력 상태를 바꾸지 않는다 (순수)', () => {
    const input = { failedAttempts: 4, lockedUntil: null };
    afterFailure(input, T0, policy);
    expect(input).toEqual({ failedAttempts: 4, lockedUntil: null });
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
 * **확인하기 전에 센다** (P13 D.4, FR-1431). 실패 횟수는 DB가 한 문장으로 올리고(자리 잡기), 판정은 여기서 한다. 동시에 N건이 와도
 * 확인까지 가는 것은 기준 횟수만큼이다 — 확인 뒤에 세면 동시에 온 추측이 모두 확인까지 가서, 5회 잠금이 약 20배 느슨했다(측정 S3)
 */
describe('admitAttempt — 자리를 잡은 뒤 확인할지 (P13 FR-1431)', () => {
  it('잡은 수가 기준 이하면 확인한다', () => {
    expect(admitAttempt(1, policy)).toBe('verify');
    expect(admitAttempt(policy.lockoutThreshold, policy)).toBe('verify');
  });

  it('**기준을 넘은 자리는 확인하지 않고 잠김으로 답한다** — 동시에 온 여섯째부터', () => {
    expect(admitAttempt(policy.lockoutThreshold + 1, policy)).toBe('locked');
    expect(admitAttempt(policy.lockoutThreshold + 50, policy)).toBe('locked');
  });

  it('자리를 못 잡았으면(지금 잠겨 있다) 잠김이다', () => {
    expect(admitAttempt(null, policy)).toBe('locked');
  });
});

describe('lockAfterFailure — 틀린 확인 뒤 잠글지 (P13 FR-1431)', () => {
  it('잡은 수가 기준에 닿으면 지금부터 잠근다', () => {
    expect(lockAfterFailure(policy.lockoutThreshold, T0, policy)).toEqual(at(policy.lockoutMinutes * MIN));
  });

  it('기준 전이면 잠그지 않는다', () => {
    expect(lockAfterFailure(policy.lockoutThreshold - 1, T0, policy)).toBeNull();
    expect(lockAfterFailure(1, T0, policy)).toBeNull();
  });
});

describe('lockExpiredReserveCount — 잠금이 풀린 뒤의 자리 (P13 D.4)', () => {
  it('**풀린 뒤에는 한 번만 확인한다** — 틀리면 다시 잠긴다(예전과 같다). 그래서 잡는 수는 기준과 같다', () => {
    const n = lockExpiredReserveCount(policy);
    expect(n).toBe(policy.lockoutThreshold);
    expect(admitAttempt(n, policy)).toBe('verify');
    expect(lockAfterFailure(n, T0, policy)).not.toBeNull();
    // 동시에 온 둘째는 기준을 넘는다
    expect(admitAttempt(n + 1, policy)).toBe('locked');
  });
});
