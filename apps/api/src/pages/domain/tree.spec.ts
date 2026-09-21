import { describe, expect, it } from 'vitest';
import { PAGE_TREE_MAX_DEPTH } from '@workfluence/shared';
import { checkMove, type TreeNode } from './tree';

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
