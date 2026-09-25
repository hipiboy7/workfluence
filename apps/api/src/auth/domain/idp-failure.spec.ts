import { describe, expect, it } from 'vitest';
import { idpFailureKind } from './idp-failure';

/**
 * A등급 — 사내 IdP와의 처리 실패를 가른다 (P11 A.1-17, 종료 루틴 자체 점검 1). **거절**은 다시 해도 같다(401 — 관리자에게 알린다),
 * **닿지 않음**은 잠시 뒤 다시 하면 된다(502). id_token 검증 실패(jose)가 `HttpException`이 아니라 닿지 않음(502 "잠시 뒤 다시")으로 가던 것
 */
describe('idpFailureKind', () => {
  it('**토큰을 받아들이지 않은 것**(서명·iss·aud·exp·모르는 키·허용하지 않는 알고리즘·깨진 토큰)은 거절이다', () => {
    for (const code of [
      'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      'ERR_JWT_CLAIM_VALIDATION_FAILED',
      'ERR_JWT_EXPIRED',
      'ERR_JWKS_NO_MATCHING_KEY',
      'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
      'ERR_JWKS_INVALID',
      'ERR_JOSE_ALG_NOT_ALLOWED',
      'ERR_JOSE_NOT_SUPPORTED',
      'ERR_JWT_INVALID',
      'ERR_JWS_INVALID',
    ]) {
      expect(idpFailureKind(code), code).toBe('rejected');
    }
  });

  it('**키 목록을 제때 받지 못한 것**은 닿지 않음이다 — 잠시 뒤 다시 하면 된다', () => {
    expect(idpFailureKind('ERR_JWKS_TIMEOUT')).toBe('unreachable');
  });

  it('그 밖(망·TLS의 코드, 코드가 없거나 문자열이 아님)은 닿지 않음이다', () => {
    for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ECONNREFUSED', 'ENOTFOUND', '', undefined, null, 42]) {
      expect(idpFailureKind(code), String(code)).toBe('unreachable');
    }
  });
});
