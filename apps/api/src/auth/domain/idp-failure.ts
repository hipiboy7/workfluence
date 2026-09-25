/** 사내 IdP와의 처리가 실패한 까닭의 부류 */
export type IdpFailureKind = 'rejected' | 'unreachable';

/** jose의 오류 코드 중 **다시 하면 될 수 있는 것** — 키 목록(JWKS)을 제때 받지 못했다 */
const TRANSIENT_JOSE = new Set(['ERR_JWKS_TIMEOUT']);

/**
 * 사내 IdP와의 처리 실패를 가른다 (P11_설계서_Ops A.1-17, 종료 루틴 자체 점검 1). 우리가 판정한 거절(`HttpException`)은 부르는 쪽이
 * 먼저 거른다 — 여기는 그 밖의 오류의 `code`만 본다.
 *
 * - **거절**(`rejected`) — id_token을 받아들이지 않았다: 서명·iss·aud·exp, 모르는 키, 허용하지 않는 알고리즘, 깨진 토큰(jose의
 *   `ERR_JW*`·`ERR_JOSE_*`). 다시 해도 같다 — 설정(`WF_OIDC_CLIENT_ID`·issuer)이나 IdP·서버의 시각을 봐야 한다
 * - **닿지 않음**(`unreachable`) — 망·TLS·Discovery, 키 목록을 제때 받지 못함. 잠시 뒤 다시 하면 될 수 있다
 */
export function idpFailureKind(code: unknown): IdpFailureKind {
  if (typeof code !== 'string' || TRANSIENT_JOSE.has(code)) return 'unreachable';
  return /^ERR_(JW[TSEK]|JWKS|JOSE)_/.test(code) ? 'rejected' : 'unreachable';
}
