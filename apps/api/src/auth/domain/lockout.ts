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

/** 로그인 성공을 반영한 다음 상태. 누적 실패와 잠금을 모두 지운다. */
export function afterSuccess(): LockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}

/**
 * **틀린 확인 뒤의 잠금** (P13 D.4, FR-1431). 실패 횟수는 DB가 한 문장으로 올리고(`failed_attempts + 1 RETURNING`), 올린 뒤의 수가
 * 기준에 닿았거나 넘었으면 지금부터 잠근다 — 잠금이 풀린 뒤의 실패도 다시 잠근다(성공하기 전까지 횟수는 지워지지 않는다). 읽고 계산해
 * 다시 쓰면 동시에 온 요청이 서로를 덮는다(측정 S3)
 */
export function lockAfterFailure(failedAttempts: number, now: Date, policy: LockoutPolicy): Date | null {
  return failedAttempts >= policy.lockoutThreshold ? new Date(now.getTime() + policy.lockoutMinutes * 60_000) : null;
}
