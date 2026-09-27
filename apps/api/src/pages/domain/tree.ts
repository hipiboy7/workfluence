import { PAGE_POSITION_GAP, PAGE_POSITION_LIMIT } from '@workfluence/shared';

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

export type SiblingSlot = { id: string; position: number };

/**
 * **옮긴 페이지의 새 자리** (A등급, P14_설계서_Spaces D.1, FR-1502).
 *
 * `siblings`는 새 부모 아래 형제의 **지금 순서**다(화면과 같은 순서 — 자리, 만든 시각). 옮기는 페이지가 그 안에 있으면(같은 부모 안에서 옮기기)
 * 먼저 빼고, `index`(0부터 — 자기를 뺀 형제 가운데 몇 번째) 자리에 끼운다. 형제 수보다 크면 맨 뒤다.
 *
 * - **틈이 있으면 옮긴 한 줄만** — 이웃 사이의 가운데, 맨 앞이면 첫 형제 − 간격, 맨 뒤면 마지막 + 간격(`PAGE_POSITION_GAP`). `renumber`는 `null`
 * - **틈이 없으면**(이웃이 붙었거나 같다 — 옛 API가 받은 값을 그대로 적어 겹친 자리도) 또는 자리가 한도(`PAGE_POSITION_LIMIT`)를 넘으면 형제 전체를
 *   간격으로 다시 매긴다 — `renumber`에 새 순서의 모든 줄. 서비스는 그 가운데 바뀐 줄만 고친다
 *
 * 형제마다 다시 쓰는 것이 늘 필요한 방식이면, 줄마다 검색 색인까지 다시 써서 본문이 큰 형제 300개 아래로 옮기는 데 1.2초였다(병합 전 보안 검토 1).
 * **조회하지 않는다** — `checkMove`와 같은 판단.
 */
export function placeAt(siblings: readonly SiblingSlot[], movedId: string, index: number): { position: number; renumber: SiblingSlot[] | null } {
  const rest = siblings.filter((s) => s.id !== movedId);
  const at = Math.max(0, Math.min(Math.trunc(index), rest.length));
  if (rest.length === 0) return { position: 0, renumber: null };
  const prev = at > 0 ? rest[at - 1].position : null;
  const next = at < rest.length ? rest[at].position : null;
  let position: number | null;
  if (prev === null) position = next! - PAGE_POSITION_GAP;
  else if (next === null) position = prev + PAGE_POSITION_GAP;
  else position = next - prev >= 2 ? prev + Math.floor((next - prev) / 2) : null;
  if (position !== null && Math.abs(position) <= PAGE_POSITION_LIMIT) return { position, renumber: null };
  const order = [...rest.slice(0, at), { id: movedId, position: 0 }, ...rest.slice(at)];
  const renumber = order.map((s, i) => ({ id: s.id, position: i * PAGE_POSITION_GAP }));
  return { position: at * PAGE_POSITION_GAP, renumber };
}
