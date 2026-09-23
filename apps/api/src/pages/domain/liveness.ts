/**
 * 살아 있는 WebSocket을 계속 붙여 둘지 판정한다 (P7_설계서_Hardening C.1·C.2절).
 *
 * **업그레이드 때 한 번 판정하고 마는 것이 문제였다.** 로그인한 채 편집을 열어 두면
 * 로그아웃해도, 관리자가 세션을 끊어도, Crew에서 빠져도 그 연결은 계속 쓴다 (보류 20 ①).
 *
 * 여기 있는 것은 **판정뿐**이다. 세션과 권한을 읽어 오는 일과 소켓을 닫는 일은
 * 게이트웨이가 한다 — 조건의 조합을 실제 연결로 시험하는 것은 느리고 불확실하다
 * (`realtime.ts`와 같은 판단).
 */

/** 직전 ping에 pong이 돌아오지 않았으면 그 연결은 죽은 것이다 (FR-801) */
export function shouldTerminate(alive: boolean): boolean {
  return !alive;
}

/**
 * 재판정할 차례인가 (FR-800).
 *
 * **경과가 음수면 아니다.** 시계가 뒤로 가면(NTP 보정) 모든 연결이 한꺼번에 차례가 되어
 * DB에 연결 수만큼의 질의가 한 번에 몰린다.
 */
export function dueForRecheck(lastCheckedAt: number, now: number, intervalMs: number): boolean {
  const elapsed = now - lastCheckedAt;
  return elapsed >= 0 && elapsed >= intervalMs;
}

export type LiveState = {
  /** 세션 저장소에 그 sid가 아직 있고 만료되지 않았는가 */
  sessionAlive: boolean;
  userActive: boolean;
  mustChangePassword: boolean;
  /** 지금도 이 스페이스에 쓸 수 있는가 */
  canWrite: boolean;
};

/**
 * 끊어야 할 이유. 없으면 `null`.
 *
 * **순서가 있다.** 넓은 이유를 먼저 말한다 — 세션이 없는 사람에게 "쓰기 권한 없음"이라고
 * 로그를 남기면 운영자가 권한 설정을 뒤지게 된다.
 */
export function revocationReason(s: LiveState): string | null {
  if (!s.sessionAlive) return '세션 없음';
  if (!s.userActive) return '계정 비활성';
  if (s.mustChangePassword) return '비밀번호 변경 필요';
  if (!s.canWrite) return '쓰기 권한 없음';
  return null;
}
