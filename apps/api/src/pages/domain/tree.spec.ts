import { describe, expect, it } from 'vitest';
import { PAGE_TREE_MAX_DEPTH } from '@workfluence/shared';
import { PAGE_POSITION_GAP as GAP, PAGE_POSITION_LIMIT } from '@workfluence/shared';
import { checkMove, placeAt, type TreeNode } from './tree';

/** A등급 (P2_설계서_Page 0절). 테스트를 먼저 썼다. 조회는 밖에서 하고 여기는 판정만 한다. */

const node = (id: string, parentId: string | null, spaceId = 'S'): TreeNode => ({ id, parentId, spaceId });
const base = { selfId: 'P', spaceId: 'S', maxDepth: PAGE_TREE_MAX_DEPTH, subtreeHeight: 0 };

describe('checkMove — 루트로 이동', () => {
  it('부모가 없으면 언제나 된다', () => {
    expect(checkMove({ ...base, ancestors: [] })).toEqual({ ok: true });
  });
});

describe('checkMove — 순환 (FR-326)', () => {
  it('자기 자신을 부모로 두면 막는다', () => {
    expect(checkMove({ ...base, ancestors: [node('P', null)] })).toEqual({ ok: false, reason: 'cycle' });
  });

  it('자손을 부모로 두면 막는다 — 조상 사슬에 자기가 나온다', () => {
    expect(checkMove({ ...base, ancestors: [node('C', 'P'), node('P', null)] })).toEqual({ ok: false, reason: 'cycle' });
  });

  it('형제나 남의 가지 아래로는 된다', () => {
    expect(checkMove({ ...base, ancestors: [node('A', null)] })).toEqual({ ok: true });
    expect(checkMove({ ...base, ancestors: [node('B', 'A'), node('A', null)] })).toEqual({ ok: true });
  });

  it('생성(selfId=null)은 순환이 있을 수 없다', () => {
    expect(checkMove({ ...base, selfId: null, ancestors: [node('A', null)] })).toEqual({ ok: true });
  });
});

describe('checkMove — 다른 스페이스 (FR-327)', () => {
  it('조상 중 하나라도 다른 스페이스면 막는다', () => {
    expect(checkMove({ ...base, ancestors: [node('A', null, 'OTHER')] })).toEqual({ ok: false, reason: 'cross-space' });
    expect(checkMove({ ...base, ancestors: [node('B', 'A'), node('A', null, 'OTHER')] })).toEqual({ ok: false, reason: 'cross-space' });
  });

  it('순환과 겹치면 순환을 먼저 알린다 — 더 근본적인 오류다', () => {
    expect(checkMove({ ...base, ancestors: [node('P', null, 'OTHER')] })).toEqual({ ok: false, reason: 'cycle' });
  });
});

describe('checkMove — 깊이 (FR-328)', () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => node(`A${i}`, i === n - 1 ? null : `A${i + 1}`));

  it('한도 직전까지는 된다', () => {
    // 조상 9개 + 자기 자신 = 깊이 10
    expect(checkMove({ ...base, ancestors: chain(PAGE_TREE_MAX_DEPTH - 1) })).toEqual({ ok: true });
  });

  it('한도를 넘으면 막는다', () => {
    expect(checkMove({ ...base, ancestors: chain(PAGE_TREE_MAX_DEPTH) })).toEqual({ ok: false, reason: 'too-deep' });
  });

  it('**옮기는 가지의 높이도 센다** — 자기만 보면 자손이 한도를 넘는다', () => {
    // 조상 5 + 자기 1 = 6. 자손이 5단 더 있으면 11이 되어 한도를 넘는다
    expect(checkMove({ ...base, ancestors: chain(5), subtreeHeight: 5 })).toEqual({ ok: false, reason: 'too-deep' });
    expect(checkMove({ ...base, ancestors: chain(5), subtreeHeight: 4 })).toEqual({ ok: true });
  });
});

/**
 * **옮긴 페이지의 새 자리** (P14 D.1, FR-1502). 자리 값에 **틈**(`PAGE_POSITION_GAP`)을 두어, 옮기기는 보통 **옮긴 한 줄만** 고친다 — 이웃 사이의
 * 가운데, 맨 앞이면 첫 형제 − 간격, 맨 뒤면 마지막 + 간격. 틈이 없거나(이웃이 붙었거나 같다 — 옛 API가 남긴 겹친 자리) 한도에 닿으면 형제 전체를
 * 간격으로 다시 매긴다. 형제마다 다시 쓰면 줄마다 검색 색인까지 다시 써서, 본문이 큰 형제 300개 아래로 옮기는 데 1.2초였다(병합 전 보안 검토 1)
 */
const sib = (...rows: [string, number][]) => rows.map(([id, position]) => ({ id, position }));

describe('placeAt — 옮긴 페이지의 새 자리 (P14 FR-1502)', () => {
  it('빈 부모 아래는 0', () => {
    expect(placeAt([], 'x', 5)).toEqual({ position: 0, renumber: null });
  });

  it('**이웃 사이에 틈이 있으면 가운데 — 한 줄만 고친다**', () => {
    expect(placeAt(sib(['a', 0], ['b', GAP], ['c', 2 * GAP]), 'x', 1)).toEqual({ position: GAP / 2, renumber: null });
    expect(placeAt(sib(['a', 0], ['b', 3]), 'x', 1)).toEqual({ position: 1, renumber: null });
  });

  it('맨 앞은 첫 형제 − 간격, 맨 뒤는 마지막 + 간격 — **형제 수보다 크면 맨 뒤**', () => {
    expect(placeAt(sib(['a', 0], ['b', GAP]), 'x', 0)).toEqual({ position: -GAP, renumber: null });
    expect(placeAt(sib(['a', 0], ['b', GAP]), 'x', 2)).toEqual({ position: 2 * GAP, renumber: null });
    expect(placeAt(sib(['a', 0], ['b', GAP]), 'x', 99)).toEqual({ position: 2 * GAP, renumber: null });
  });

  it('**같은 부모 안에서 옮기면 자기를 뺀 형제 가운데 몇 번째**', () => {
    // a x b c 에서 x를 두 번째 자리로(자기를 뺀 a b c 가운데 2 = b와 c 사이)
    expect(placeAt(sib(['a', 0], ['x', GAP], ['b', 2 * GAP], ['c', 3 * GAP]), 'x', 2)).toEqual({ position: 2.5 * GAP, renumber: null });
    // 이미 맨 앞인 x를 맨 앞으로 — 자기를 뺀 첫 형제 앞
    expect(placeAt(sib(['x', 0], ['a', GAP]), 'x', 0)).toEqual({ position: 0, renumber: null });
    expect(placeAt(sib(['x', 0]), 'x', 0)).toEqual({ position: 0, renumber: null });
  });

  it('**틈이 없으면 형제 전체를 간격으로 다시 매긴다** — 붙은 자리도, 옛 API가 남긴 겹친 자리도', () => {
    expect(placeAt(sib(['a', 0], ['b', 1], ['c', 2]), 'x', 1)).toEqual({
      position: GAP,
      renumber: [
        { id: 'a', position: 0 },
        { id: 'x', position: GAP },
        { id: 'b', position: 2 * GAP },
        { id: 'c', position: 3 * GAP },
      ],
    });
    expect(placeAt(sib(['a', 5], ['b', 5]), 'x', 1).renumber?.map((r) => r.id)).toEqual(['a', 'x', 'b']);
  });

  it('**자리 값이 한도에 닿으면 다시 매긴다** — 끝으로 거듭 옮겨도 넘치지 않는다', () => {
    const atEnd = placeAt(sib(['a', PAGE_POSITION_LIMIT]), 'x', 1);
    expect(atEnd.renumber).toEqual([{ id: 'a', position: 0 }, { id: 'x', position: GAP }]);
    const atFront = placeAt(sib(['a', -PAGE_POSITION_LIMIT]), 'x', 0);
    expect(atFront.renumber?.map((r) => r.id)).toEqual(['x', 'a']);
    expect(Math.abs(placeAt(sib(['a', PAGE_POSITION_LIMIT - GAP - 1]), 'x', 1).position)).toBeLessThanOrEqual(PAGE_POSITION_LIMIT);
  });

  it('받은 목록을 바꾸지 않는다', () => {
    const siblings = sib(['a', 0], ['b', 1]);
    placeAt(siblings, 'x', 1);
    expect(siblings).toEqual(sib(['a', 0], ['b', 1]));
  });
});
