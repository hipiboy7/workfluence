import { z } from 'zod';
import { API_TOKEN_LIMITS, API_TOKEN_SCOPES, type ApiTokenScope } from './constants';

/**
 * 공개 API 토큰의 판정 (A등급, docs/spinoff/public-api 계획서 4.1절).
 *
 * 서명·`iss`·`aud`·`exp`는 JWT 라이브러리가 본다. 여기는 그 뒤 — 클레임의 모양, 토큰 행이 살아 있는가, 주인이 쓸 수 있는 계정인가,
 * scope가 요청에 맞는가. **순수 JWT만으로는 정지·폐기를 그 자리에서 먹일 수 없어서** 요청마다 행과 사용자를 다시 본다(CLAUDE.md 7절).
 */

export type ApiTokenProblem =
  | 'TOKEN_INVALID'
  | 'TOKEN_UNKNOWN'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'ACCOUNT_INACTIVE'
  | 'PASSWORD_CHANGE_REQUIRED';

export type ApiTokenClaims =
  | { ok: true; userId: string; tokenId: string; scopes: ApiTokenScope[] }
  | { ok: false; code: 'TOKEN_INVALID' };

const uuid = z.uuid().toLowerCase();
const scopeSchema = z.enum(API_TOKEN_SCOPES);

/** 중복을 없애고 `API_TOKEN_SCOPES`의 순서로 둔다 — 같은 권한이 같은 글자가 되게 */
export function normalizeScopes(scopes: readonly ApiTokenScope[]): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((s) => scopes.includes(s));
}

/** JWT `scope`는 빈칸으로 나눈 문자열이다 (RFC 8693 4.2) */
export function apiTokenClaims(payload: unknown): ApiTokenClaims {
  const invalid = { ok: false, code: 'TOKEN_INVALID' } as const;
  if (typeof payload !== 'object' || payload === null) return invalid;
  const p = payload as Record<string, unknown>;
  const sub = uuid.safeParse(p.sub);
  const jti = uuid.safeParse(p.jti);
  if (!sub.success || !jti.success || typeof p.scope !== 'string') return invalid;
  const parts = p.scope.split(' ').filter((s) => s !== '');
  if (parts.length === 0) return invalid;
  const scopes: ApiTokenScope[] = [];
  for (const s of parts) {
    const r = scopeSchema.safeParse(s);
    if (!r.success) return invalid;
    scopes.push(r.data);
  }
  return { ok: true, userId: sub.data, tokenId: jti.data, scopes: normalizeScopes(scopes) };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 요청이 요구하는 scope. 관리 경로는 `admin`을 **더한다** */
export function requiredScopes(method: string, adminRoute: boolean): ApiTokenScope[] {
  const base: ApiTokenScope = SAFE_METHODS.has(method.toUpperCase()) ? 'read' : 'write';
  return adminRoute ? ['admin', base] : [base];
}

/** `write`는 `read`를 포함한다. 그 밖에는 포함 관계가 없다 */
export function scopeAllows(granted: readonly ApiTokenScope[], required: readonly ApiTokenScope[]): boolean {
  return required.every((r) => granted.includes(r) || (r === 'read' && granted.includes('write')));
}

export type ApiTokenRow = { id: string; userId: string; revokedAt: Date | null; expiresAt: Date };

/** 폐기를 만료보다 먼저 말한다 — 누가 끊었는지가 더 쓸모 있는 답이다 */
export function tokenRowProblem(
  row: ApiTokenRow | null,
  claims: { userId: string; tokenId: string },
  now: Date,
): 'TOKEN_UNKNOWN' | 'TOKEN_REVOKED' | 'TOKEN_EXPIRED' | null {
  if (!row || row.id !== claims.tokenId || row.userId !== claims.userId) return 'TOKEN_UNKNOWN';
  if (row.revokedAt) return 'TOKEN_REVOKED';
  if (row.expiresAt.getTime() <= now.getTime()) return 'TOKEN_EXPIRED';
  return null;
}

/** 세션 가드와 같은 규칙이다 (`apps/api/src/auth/auth.guard.ts`) — 활성이 아니거나 비밀번호 변경이 강제되면 막는다 */
export function tokenUserProblem(
  user: { status: string; mustChangePassword: boolean } | null,
): 'ACCOUNT_INACTIVE' | 'PASSWORD_CHANGE_REQUIRED' | null {
  if (!user || user.status !== 'active') return 'ACCOUNT_INACTIVE';
  if (user.mustChangePassword) return 'PASSWORD_CHANGE_REQUIRED';
  return null;
}

const DAY_MS = 86_400_000;

export type TokenExpiry = { ok: true; expiresAt: Date } | { ok: false; code: 'EXPIRY_TOO_LONG'; maxDays: number };

/** `maxDays`는 운영 상한이다. 날 수를 주지 않으면 기본과 상한 가운데 짧은 쪽 */
export function resolveTokenExpiry(now: Date, days: number | undefined, maxDays: number): TokenExpiry {
  const d = days ?? Math.min(API_TOKEN_LIMITS.defaultDays, maxDays);
  if (d > maxDays) return { ok: false, code: 'EXPIRY_TOO_LONG', maxDays };
  return { ok: true, expiresAt: new Date(now.getTime() + d * DAY_MS) };
}

/**
 * 공개 API(`/api/v1/…`)의 경로인가. 그 경로는 세션을 보지 않고 Bearer만 받으므로 CSRF 헤더가 필요 없다 — **그래서 판정이 느슨하면 CSRF 방어에 구멍이
 * 난다.** `.`·`..` 조각, 인코딩된 점·빗금(`%2e`·`%2f`)이 든 경로는 공개 API로 치지 않는다(어느 처리기에 닿을지 경로 문자열로 말할 수 없다)
 */
export function isPublicApiPath(path: string): boolean {
  if (!path.startsWith('/api/v1/')) return false;
  if (/%2e|%2f|%5c|\\/i.test(path)) return false;
  return !path.split('/').some((seg) => seg === '.' || seg === '..');
}
