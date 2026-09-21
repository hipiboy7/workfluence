/**
 * 계정 잠금 판정 순수 함수 (A등급, P1_설계서_Auth 0절, FR-205).
 *
 * **시계를 주입받는다.** `Date.now()`를 안에서 부르면 경계(정각·1ms 전후)를 테스트할 수 없고,
 * 테스트가 느려지거나 간헐적으로 깨진다.
 */

export type LockoutPolicy = { readonly lockoutThreshold: number; readonly lockoutMinutes: number };
export type LockoutState = { failedAttempts: number; lockedUntil: Date | null };

/** 지금 잠겨 있는가. 잠금 시각 **정각은 풀린 것**으로 본다. */
export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** 남은 잠금 시간(ms). 관리자 화면 표시용. 잠겨 있지 않으면 0. */
export function remainingLockMs(state: LockoutState, now: Date): number {
  if (!isLocked(state, now)) return 0;
  return state.lockedUntil!.getTime() - now.getTime();
}

/**
 * 로그인 실패를 반영한 다음 상태.
 *
 * 잠긴 상태에서 또 실패하면 잠금이 **지금부터 다시** 걸린다. 잠긴 동안 계속 두드리는 것이
 * 공격 신호이고, 그때 잠금이 원래대로 풀리면 두드림이 공짜가 된다.
 */
export function afterFailure(state: LockoutState, now: Date, policy: LockoutPolicy): LockoutState {
  const failedAttempts = state.failedAttempts + 1;
  const lockedUntil =
    failedAttempts >= policy.lockoutThreshold ? new Date(now.getTime() + policy.lockoutMinutes * 60_000) : state.lockedUntil;
  return { failedAttempts, lockedUntil };
}

/** 로그인 성공을 반영한 다음 상태. 누적 실패와 잠금을 모두 지운다. */
export function afterSuccess(): LockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}
