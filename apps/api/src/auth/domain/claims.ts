import { ROLES, type Role } from '@workfluence/shared';

/**
 * OIDC 클레임 처리 순수 함수 (A등급, P1_설계서_Auth 3.3절).
 * 시계도 DB도 쓰지 않는다 — 입력이 같으면 결과가 같다.
 */

/**
 * `groups` 클레임을 문자열 배열로 정규화한다.
 *
 * **IdP마다 모양이 다르다** (리스크 1). 배열로 주는 곳, 쉼표로 이어 붙여 주는 곳,
 * 공백으로 나누는 곳이 있다. 실 IdP가 무엇을 줄지 아직 모르므로(확인 필요 A) 셋 다 받는다.
 * 모르는 모양이면 빈 배열이고, 그러면 mapGroupsToRole이 null을 내 로그인이 거부된다 —
 * **조용히 member로 떨어지지 않는다.**
 */
export function parseGroups(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === 'string')
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  return parts.map((g) => g.trim()).filter((g) => g.length > 0);
}

/** 역할 우열. 인덱스가 작을수록 높다 (ROLES = root, admin, member). */
function rank(role: Role): number {
  return ROLES.indexOf(role);
}

/**
 * 그룹 목록을 역할 하나로 접는다 (FR-216).
 *
 * 여러 그룹이 매핑되면 **가장 높은 역할**을 준다. 낮은 쪽을 주면 관리자가 일반 그룹에도
 * 속해 있다는 이유로 권한을 잃는다. 어느 것도 매핑되지 않으면 `null`이고, 호출부는
 * 로그인을 거부한다 — 기본 거부다 (FR-218).
 */
export function mapGroupsToRole(raw: unknown, roleMap: Record<string, Role>): Role | null {
  let best: Role | null = null;
  for (const group of parseGroups(raw)) {
    const role = roleMap[group];
    if (role && (best === null || rank(role) < rank(best))) best = role;
  }
  return best;
}
