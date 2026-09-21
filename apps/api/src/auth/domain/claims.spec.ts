import { describe, expect, it } from 'vitest';
import type { Role } from '@workfluence/shared';
import { mapGroupsToRole, parseGroups } from './claims';

/** A등급 (P1_설계서_Auth 0절). 테스트를 먼저 썼다. */

describe('parseGroups — IdP마다 groups 모양이 다르다 (리스크 1)', () => {
  it('배열은 그대로, 문자열이 아닌 원소는 버린다', () => {
    expect(parseGroups(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseGroups(['a', 1, null, 'b'])).toEqual(['a', 'b']);
  });

  it('쉼표·공백으로 이어 붙인 문자열도 받는다', () => {
    expect(parseGroups('a,b')).toEqual(['a', 'b']);
    expect(parseGroups('a b')).toEqual(['a', 'b']);
    expect(parseGroups('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  it('없거나 빈 값은 빈 배열', () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
    expect(parseGroups('  ')).toEqual([]);
    expect(parseGroups(42)).toEqual([]);
    expect(parseGroups({ a: 1 })).toEqual([]);
  });

  it('앞뒤 공백을 떼고 빈 조각은 버린다', () => {
    expect(parseGroups([' a ', '', '  '])).toEqual(['a']);
    expect(parseGroups('a,,b,')).toEqual(['a', 'b']);
  });
});

describe('mapGroupsToRole (FR-216, FR-218)', () => {
  const map: Record<string, Role> = { 'wf-admins': 'admin', 'wf-users': 'member', 'wf-root': 'root' };

  it('매핑된 그룹의 역할을 준다', () => {
    expect(mapGroupsToRole(['wf-users'], map)).toBe('member');
    expect(mapGroupsToRole(['wf-admins'], map)).toBe('admin');
  });

  it('여러 개가 맞으면 가장 높은 역할을 준다 — 순서에 의존하지 않는다', () => {
    expect(mapGroupsToRole(['wf-users', 'wf-admins'], map)).toBe('admin');
    expect(mapGroupsToRole(['wf-admins', 'wf-users'], map)).toBe('admin');
    expect(mapGroupsToRole(['wf-users', 'wf-root', 'wf-admins'], map)).toBe('root');
  });

  it('어느 것도 매핑되지 않으면 null — 기본 거부 (FR-218)', () => {
    expect(mapGroupsToRole(['other'], map)).toBeNull();
    expect(mapGroupsToRole([], map)).toBeNull();
    expect(mapGroupsToRole(undefined, map)).toBeNull();
  });

  it('매핑표가 비어 있으면 무조건 null', () => {
    expect(mapGroupsToRole(['wf-admins'], {})).toBeNull();
  });

  it('문자열 groups도 같은 결과', () => {
    expect(mapGroupsToRole('wf-users,wf-admins', map)).toBe('admin');
  });

  it('그룹 이름은 대소문자를 구분한다 — IdP가 정확히 주는 값을 쓴다', () => {
    expect(mapGroupsToRole(['WF-ADMINS'], map)).toBeNull();
  });
});
