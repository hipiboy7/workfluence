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

/**
 * **확인하기 전에 센다** (P13 D.4, FR-1431). DB가 실패 횟수를 한 문장으로 먼저 올리고(자리 잡기), 잡은 뒤의 수로 이번 시도를 확인할지
 * 정한다. 자리를 못 잡았으면(`null` — 지금 잠겨 있다) 잠김이다. 기준 이하의 자리만 확인한다 — 동시에 N건이 와도 확인까지 가는 것은
 * 기준 횟수만큼이다. 확인 뒤에 세면 동시에 온 추측이 모두 확인까지 가서, 5회 잠금이 약 20배 느슨했다(P13 측정 S3)
 */
export function admitAttempt(reserved: number | null, policy: LockoutPolicy): 'verify' | 'locked' {
  if (reserved === null) return 'locked';
  return reserved <= policy.lockoutThreshold ? 'verify' : 'locked';
}

/**
 * **틀린 확인 뒤의 잠금** (P13 D.4). 잡은 자리가 기준에 닿았으면 지금부터 잠근다. 횟수는 자리를 잡을 때 이미 올랐다
 */
export function lockAfterFailure(reserved: number, now: Date, policy: LockoutPolicy): Date | null {
  return reserved >= policy.lockoutThreshold ? new Date(now.getTime() + policy.lockoutMinutes * 60_000) : null;
}

/**
 * **잠금이 풀린 뒤의 첫 자리** (P13 D.4). 예전처럼 풀린 뒤에는 한 번만 확인하고, 틀리면 다시 잠근다 — 그래서 자리 잡기가 풀린 잠금을
 * 보면 횟수를 이 값으로 둔다(확인은 되고, 틀리면 기준에 닿아 잠긴다). 동시에 온 둘째는 기준을 넘어 확인하지 않는다
 */
export function lockExpiredReserveCount(policy: LockoutPolicy): number {
  return policy.lockoutThreshold;
}
