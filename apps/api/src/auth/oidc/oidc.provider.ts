import type { Role } from '@workfluence/shared';

/**
 * IdP 경계 (P1_설계서_Auth 3.1절, CLAUDE.md 2절 DIP).
 *
 * `AuthService`는 이 인터페이스만 안다. 구현은 둘이다.
 * - `HttpOidcProvider` — 실제 IdP. Discovery·JWKS·토큰 교환
 * - `MockOidcProvider` — 개발·테스트. 설정으로 정해 둔 클레임을 그대로 돌려준다
 *
 * **이 경계가 확인 필요 A(개발 서버가 사내 IdP에 못 나갈 수 있다)를 막힌 채로 진행하게 해 준다.**
 * 다만 모의 제공자로 검증되지 않는 것이 하나 있다 — **실 IdP가 실제로 무엇을 주는가**.
 * 그래서 실연동은 완료 기준에서 뺐다 (A.6).
 */

export type PkcePair = { verifier: string; challenge: string };

/** IdP가 준 클레임 중 우리가 쓰는 것만. groups는 모양이 제각각이라 unknown으로 받아 claims.ts가 푼다 */
export type OidcClaims = {
  sub: string;
  preferredUsername?: string;
  email?: string;
  groups: unknown;
};

export interface OidcProvider {
  /** 사용자를 보낼 authorize URL */
  authorizationUrl(state: string, nonce: string, pkce?: PkcePair): Promise<string>;
  /** code를 토큰으로 바꾸고 id_token을 검증해 클레임을 낸다 */
  exchange(code: string, nonce: string, verifier?: string): Promise<OidcClaims>;
}

export const OIDC_PROVIDER = Symbol('OIDC_PROVIDER');

/** 매핑 결과를 담는 값. role이 null이면 로그인 거부다 (FR-218) */
export type ResolvedIdentity = { claims: OidcClaims; role: Role | null };
