import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from '@workfluence/shared';
import { afterFailure, afterSuccess, isLocked, remainingLockMs } from './lockout';

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
