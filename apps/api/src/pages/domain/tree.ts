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

/**
 * **옮긴 뒤 새 부모 아래의 순서** (A등급, P14_설계서_Spaces D.1, FR-1502).
 *
 * `siblings`는 새 부모 아래 형제의 **지금 순서**다(화면과 같은 순서 — 자리, 만든 시각). 옮기는 페이지가 그 안에 있으면(같은 부모 안에서 옮기기)
 * 먼저 빼고, `index`(0부터 — 자기를 뺀 형제 가운데 몇 번째) 자리에 끼운다. 형제 수보다 크면 맨 뒤다. 서비스는 돌려받은 순서대로 자리를
 * 0부터 다시 매긴다 — 예전에는 받은 자리 값을 그대로 적어 같은 값이 여럿 생겼다.
 *
 * **조회하지 않는다** — `checkMove`와 같은 판단.
 */
export function placeAt(siblings: readonly string[], movedId: string, index: number): string[] {
  const rest = siblings.filter((id) => id !== movedId);
  const at = Math.max(0, Math.min(Math.trunc(index), rest.length));
  return [...rest.slice(0, at), movedId, ...rest.slice(at)];
}
