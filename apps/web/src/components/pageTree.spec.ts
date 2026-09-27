import type { PageSummary } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { childrenOf, flattenTree, indentedTitle, subtreeIds } from './pageTree';

/** 트리 펼치기 (P14 D.2) — 스페이스 화면·위치 고르기·옮기기 칸이 같이 쓴다 */

const page = (id: string, parentId: string | null, position = 0): PageSummary => ({
  id,
  spaceId: 's',
  parentId,
  title: id.toUpperCase(),
  position,
  currentVersionNo: 1,
  updatedAt: '2026-09-27T00:00:00.000Z',
});

// 서버의 순서(자리, 만든 시각) — 부모와 상관없이 한 줄로 온다
const pages = [page('a', null, 0), page('b', null, 1), page('a1', 'a', 0), page('a2', 'a', 1), page('a1x', 'a1', 0)];

describe('flattenTree', () => {
  it('부모 → 자식 순서로 펼치고 깊이를 붙인다 — 형제 사이의 순서는 서버 그대로', () => {
    expect(flattenTree(pages).map((r) => `${r.id}:${r.depth}`)).toEqual(['a:0', 'a1:1', 'a1x:2', 'a2:1', 'b:0']);
  });

  it('**부모가 목록에 없는 가지도 버리지 않는다** — 맨 위 단계 뒤에 붙는다', () => {
    const rows = flattenTree([page('a', null), page('lost', 'gone'), page('lost1', 'lost')]);
    expect(rows.map((r) => `${r.id}:${r.depth}`)).toEqual(['a:0', 'lost:0', 'lost1:1']);
  });

  it('순환된 데이터여도 멈추고 한 번씩만 보인다', () => {
    const rows = flattenTree([page('x', 'y'), page('y', 'x')]);
    expect(rows.map((r) => r.id).sort()).toEqual(['x', 'y']);
  });

  it('빈 스페이스', () => {
    expect(flattenTree([])).toEqual([]);
  });
});

describe('subtreeIds · childrenOf · indentedTitle', () => {
  it('그 페이지와 그 아래 전부 — 옮길 수 없는 새 부모', () => {
    expect([...subtreeIds(pages, 'a')].sort()).toEqual(['a', 'a1', 'a1x', 'a2']);
    expect([...subtreeIds(pages, 'a1')].sort()).toEqual(['a1', 'a1x']);
    expect([...subtreeIds(pages, 'b')]).toEqual(['b']);
  });

  it('형제는 서버의 순서 그대로', () => {
    expect(childrenOf(pages, 'a').map((p) => p.id)).toEqual(['a1', 'a2']);
    expect(childrenOf(pages, null).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('들여쓴 이름 — 깊이만큼 들이고 가지 표시. **줄바꿈 없는 공백**이다(보통 공백은 옵션 글자에서 접혀 깊이가 사라진다)', () => {
    const rows = flattenTree(pages);
    expect(indentedTitle(rows[0])).toBe('A');
    expect(indentedTitle(rows[2])).toBe(`${'\u00a0'.repeat(4)}└ A1X`);
    expect(indentedTitle(rows[2]).startsWith(' ')).toBe(false);
  });
});
