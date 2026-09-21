/**
 * 페이지 트리 이동 판정 (A등급, P2_설계서_Page 3.3절).
 *
 * **조회하지 않는다.** 조상 사슬을 받아 판정만 한다 — DB를 붙이면 경계 테스트가 느려지고
 * 간헐적으로 깨진다. 서비스가 부모를 따라 올라가며 모아서 넘긴다.
 */

export type TreeNode = { id: string; parentId: string | null; spaceId: string };

export type MoveCheck = { ok: true } | { ok: false; reason: 'cycle' | 'cross-space' | 'too-deep' };

export type MoveArgs = {
  /** 이동하는 페이지. 생성이면 `null` (아직 없으므로 순환이 있을 수 없다) */
  selfId: string | null;
  /** 이동할 페이지가 속한 스페이스 */
  spaceId: string;
  /** 새 부모부터 루트까지 **순서대로**. 루트로 옮기면 빈 배열 */
  ancestors: readonly TreeNode[];
  maxDepth: number;
  /**
   * 옮기는 페이지 **아래**로 뻗은 가지의 높이 (자손이 없으면 0).
   *
   * 자기 위치만 보면 자손이 한도를 넘는다. 옮긴 뒤 가장 깊은 자손이 어디에 놓이는지를 봐야 한다.
   */
  subtreeHeight: number;
};

export function checkMove(args: MoveArgs): MoveCheck {
  const { selfId, spaceId, ancestors, maxDepth, subtreeHeight } = args;

  for (const a of ancestors) {
    // 순환을 먼저 본다. 스페이스가 달라도 자기 아래로 가는 것이 더 근본적인 오류다
    if (selfId !== null && a.id === selfId) return { ok: false, reason: 'cycle' };
  }
  for (const a of ancestors) {
    if (a.spaceId !== spaceId) return { ok: false, reason: 'cross-space' };
  }

  // 조상 수 + 자기 자신 + 가장 깊은 자손
  if (ancestors.length + 1 + subtreeHeight > maxDepth) return { ok: false, reason: 'too-deep' };
  return { ok: true };
}
