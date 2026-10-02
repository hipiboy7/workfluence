import { API_JWT, apiTokenClaims, type ApiTokenClaims, type ApiTokenScope } from '@workfluence/shared';
import { errors, jwtVerify, SignJWT } from 'jose';

/**
 * 공개 API 토큰의 JWT (A등급, docs/spinoff/public-api 계획서 4.1절).
 *
 * 알고리즘·발급자·대상은 고정값(`API_JWT`)만 받는다. 서명이 맞은 뒤의 클레임 모양은 공유 판정(`apiTokenClaims`)이 본다.
 * 여기서 `ok`가 나와도 **끝이 아니다** — 토큰 행(폐기·만료)과 사용자(정지)는 가드가 요청마다 다시 본다.
 */

/** HS256의 키는 해시 출력(32바이트) 이상이어야 한다 (RFC 7518 3.2) */
const MIN_SECRET_BYTES = 32;

function secretKey(secret: string): Uint8Array {
  const key = new TextEncoder().encode(secret);
  if (key.byteLength < MIN_SECRET_BYTES) throw new Error(`API JWT 키는 ${MIN_SECRET_BYTES}바이트 이상이어야 한다`);
  return key;
}

export type SignInput = { userId: string; tokenId: string; scopes: readonly ApiTokenScope[]; issuedAt: Date; expiresAt: Date };

export async function signApiToken(input: SignInput, secret: string): Promise<string> {
  return new SignJWT({ scope: input.scopes.join(' ') })
    .setProtectedHeader({ alg: API_JWT.algorithm, typ: 'JWT' })
    .setIssuer(API_JWT.issuer)
    .setAudience(API_JWT.audience)
    .setSubject(input.userId)
    .setJti(input.tokenId)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.expiresAt)
    .sign(secretKey(secret));
}

export type VerifyResult = ApiTokenClaims | { ok: false; code: 'TOKEN_EXPIRED' };

export async function verifyApiToken(jwt: string, secret: string, now: Date): Promise<VerifyResult> {
  const key = secretKey(secret);
  try {
    const { payload } = await jwtVerify(jwt, key, {
      algorithms: [API_JWT.algorithm],
      issuer: API_JWT.issuer,
      audience: API_JWT.audience,
      currentDate: now,
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
    });
    return apiTokenClaims(payload);
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, code: 'TOKEN_EXPIRED' };
    return { ok: false, code: 'TOKEN_INVALID' };
  }
}

/** `Authorization: Bearer <값>`. 방식 이름은 대소문자를 가리지 않고, 값에 빈칸이 있거나 헤더가 여럿이면 받지 않는다 */
export function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header);
  return m ? m[1]! : null;
}
