import type { PageSummary } from '@workfluence/shared';

/**
 * 페이지 트리 펼치기 (P14_설계서_Spaces D.2). 스페이스 화면의 트리, 새 페이지의 위치 고르기, 옮기기 칸이 이것 하나를 쓴다 — 셋이 따로 펼치면
 * 순서나 들여쓰기가 서로 어긋난다.
 *
 * 서버는 트리를 **화면의 순서**(자리, 만든 시각)로 준다(`GET /api/pages?spaceId=`). 여기서는 부모별로 묶어 그 순서를 지킨 채 한 줄로 펼친다.
 */

export type TreeRow = PageSummary & { depth: number };

/**
 * 부모 → 자식 순서로 한 줄로 펼치고 들여쓰기 깊이를 붙인다. **부모가 목록에 없는 페이지도 버리지 않는다** — 맨 위 단계 뒤에 붙인다(그런 데이터가
 * 생겨도 화면에서 사라지지 않게). 순환된 데이터가 있어도 한 번씩만 보인다
 */
export function flattenTree(pages: readonly PageSummary[]): TreeRow[] {
  const byParent = new Map<string | null, PageSummary[]>();
  for (const p of pages) {
    const list = byParent.get(p.parentId) ?? [];
    list.push(p);
    byParent.set(p.parentId, list);
  }
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const p of byParent.get(parentId) ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ ...p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const p of pages) {
    if (seen.has(p.id)) continue;
    // 부모를 찾지 못한 가지 — 맨 위 단계로 보인다
    seen.add(p.id);
    out.push({ ...p, depth: 0 });
    walk(p.id, 1);
  }
  return out;
}

/** 그 페이지와 그 아래 전부 — 옮기기에서 새 부모로 고를 수 없는 것 (P14 FR-1501) */
export function subtreeIds(pages: readonly PageSummary[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pages) {
      if (p.parentId !== null && ids.has(p.parentId) && !ids.has(p.id)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** 그 부모 아래의 형제 — 서버의 순서 그대로 */
export function childrenOf(pages: readonly PageSummary[], parentId: string | null): PageSummary[] {
  return pages.filter((p) => p.parentId === parentId);
}

/** 들여쓰기한 이름 — 고르기 목록(`<option>`)에는 모양을 넣을 수 없어 글자로 들인다 */
export function indentedTitle(row: TreeRow): string {
  return `${'  '.repeat(row.depth)}${row.depth > 0 ? '└ ' : ''}${row.title}`;
}
