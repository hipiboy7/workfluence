/** Node의 작업 스레드 풀 기본 크기 — 이 앱은 `UV_THREADPOOL_SIZE`를 바꾸지 않는다 */
export const NODE_DEFAULT_THREADPOOL = 4;

/**
 * 한 프로세스에서 **한꺼번에 도는 argon2의 수** (A등급, P13 FR-1433, 병합 전 코드 리뷰 9).
 *
 * argon2(node-argon2)는 Node의 작업 스레드 풀(libuv — 기본 4개)에서 돈다. 그 풀은 정적 파일(화면 번들)·첨부의 읽기·쓰기·DNS 조회도
 * 쓴다. 상한이 코어 수이면 4코어가 넘는 서버에서 몰린 로그인이 풀을 다 쥐어, 그동안 화면 파일과 첨부가 argon2 뒤에 선다. 그래서 **풀에
 * 한 자리는 남긴다.** 코어가 더 적으면 코어 수가 상한이다 — 코어를 넘겨 돌려도 처리량은 늘지 않았다(측정 S0a).
 *
 * 값을 읽지 못하면 안전한 쪽으로 — 코어 수를 모르면 1, 풀 크기를 모르면 Node의 기본값 4
 */
export function argonSlots(cores: number, threadpool: number): number {
  const pool = Number.isFinite(threadpool) && threadpool >= 1 ? Math.floor(threadpool) : NODE_DEFAULT_THREADPOOL;
  const cpu = Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;
  return Math.max(1, Math.min(cpu, pool - 1));
}
