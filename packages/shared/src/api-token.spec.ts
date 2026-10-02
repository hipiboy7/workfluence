import { describe, expect, it } from 'vitest';
import {
  apiTokenClaims,
  normalizeScopes,
  requiredScopes,
  resolveTokenExpiry,
  scopeAllows,
  tokenRowProblem,
  tokenUserProblem,
} from './api-token';
import { API_JWT, API_TOKEN_LIMITS, API_TOKEN_SCOPES } from './constants';
import { createApiTokenDto } from './schemas';

const USER = '3f1c9a52-8d4e-4b7a-9c1e-2a6b8d0f4e11';
const TOKEN = '7b2e4d6f-1a3c-4e5b-8f9a-0c1d2e3f4a5b';
const DAY_MS = 86_400_000;

describe('상수', () => {
  it('한 사람 10개 · 기본 90일 · 최대 365일 (계획서 Q2·Q5)', () => {
    expect(API_TOKEN_LIMITS.maxPerUser).toBe(10);
    expect(API_TOKEN_LIMITS.defaultDays).toBe(90);
    expect(API_TOKEN_LIMITS.maxDays).toBe(365);
  });

  it('scope는 read·write·admin 셋이다 (계획서 Q3·Q4)', () => {
    expect([...API_TOKEN_SCOPES]).toEqual(['read', 'write', 'admin']);
  });

  it('발급자·대상·알고리즘을 고정한다 — 검증이 이 값만 받는다', () => {
    expect(API_JWT).toEqual({ issuer: 'workfluence', audience: 'workfluence-api', algorithm: 'HS256' });
  });
});

describe('apiTokenClaims — 서명이 맞은 뒤 클레임의 모양을 본다', () => {
  const good = { sub: USER, jti: TOKEN, scope: 'read write', iat: 1, exp: 2 };

  it('맞는 클레임이면 사용자·토큰·scope를 꺼낸다', () => {
    expect(apiTokenClaims(good)).toEqual({ ok: true, userId: USER, tokenId: TOKEN, scopes: ['read', 'write'] });
  });

  it('식별자는 소문자로 맞춘다 (CLAUDE.md 7절 입력 — 경계에서 소문자)', () => {
    const r = apiTokenClaims({ ...good, sub: USER.toUpperCase(), jti: TOKEN.toUpperCase() });
    expect(r).toMatchObject({ ok: true, userId: USER, tokenId: TOKEN });
  });

  it.each([
    ['sub 없음', { ...good, sub: undefined }],
    ['sub가 uuid가 아님', { ...good, sub: 'root' }],
    ['jti 없음', { ...good, jti: undefined }],
    ['jti가 uuid가 아님', { ...good, jti: 'abc' }],
    ['scope 없음', { ...good, scope: undefined }],
    ['scope가 문자열이 아님', { ...good, scope: ['read'] }],
    ['빈 scope', { ...good, scope: '' }],
    ['모르는 scope', { ...good, scope: 'read delete' }],
    ['객체가 아님', 'token'],
    ['null', null],
  ])('%s → TOKEN_INVALID', (_name, claims) => {
    expect(apiTokenClaims(claims)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('scope의 중복·순서는 정규화한다', () => {
    expect(apiTokenClaims({ ...good, scope: 'write read write' })).toMatchObject({ ok: true, scopes: ['read', 'write'] });
  });
});

describe('normalizeScopes', () => {
  it('중복을 없애고 read → write → admin 순서로 둔다', () => {
    expect(normalizeScopes(['admin', 'write', 'read', 'write'])).toEqual(['read', 'write', 'admin']);
  });
});

describe('requiredScopes — 요청이 요구하는 scope', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('%s는 read', (m) => {
    expect(requiredScopes(m, false)).toEqual(['read']);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s는 write', (m) => {
    expect(requiredScopes(m, false)).toEqual(['write']);
  });

  it('메서드는 대소문자를 가리지 않는다', () => {
    expect(requiredScopes('post', false)).toEqual(['write']);
  });

  it('관리 경로는 admin을 더 요구한다', () => {
    expect(requiredScopes('GET', true)).toEqual(['admin', 'read']);
    expect(requiredScopes('POST', true)).toEqual(['admin', 'write']);
  });
});

describe('scopeAllows', () => {
  it('write는 read를 포함한다', () => {
    expect(scopeAllows(['write'], ['read'])).toBe(true);
  });

  it('read는 write를 포함하지 않는다', () => {
    expect(scopeAllows(['read'], ['write'])).toBe(false);
  });

  it('admin은 read·write를 대신하지 않는다 — 관리 경로도 읽기·쓰기 scope를 따로 본다', () => {
    expect(scopeAllows(['admin'], ['admin', 'read'])).toBe(false);
    expect(scopeAllows(['admin', 'read'], ['admin', 'read'])).toBe(true);
    expect(scopeAllows(['admin', 'read'], ['admin', 'write'])).toBe(false);
    expect(scopeAllows(['admin', 'write'], ['admin', 'read'])).toBe(true);
  });

  it('admin이 없으면 관리 경로는 막힌다', () => {
    expect(scopeAllows(['read', 'write'], ['admin', 'read'])).toBe(false);
  });

  it('빈 scope는 아무것도 못 한다', () => {
    expect(scopeAllows([], ['read'])).toBe(false);
  });
});

describe('tokenRowProblem — 토큰 행이 살아 있는가', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const row = { id: TOKEN, userId: USER, revokedAt: null, expiresAt: new Date(now.getTime() + DAY_MS) };
  const claims = { userId: USER, tokenId: TOKEN };

  it('살아 있으면 null', () => {
    expect(tokenRowProblem(row, claims, now)).toBeNull();
  });

  it('행이 없으면 TOKEN_UNKNOWN — 서명은 맞아도 우리가 낸 기록이 없다', () => {
    expect(tokenRowProblem(null, claims, now)).toBe('TOKEN_UNKNOWN');
  });

  it('폐기됐으면 TOKEN_REVOKED', () => {
    expect(tokenRowProblem({ ...row, revokedAt: new Date(now.getTime() - 1) }, claims, now)).toBe('TOKEN_REVOKED');
  });

  it('만료 시각에 닿으면 TOKEN_EXPIRED (같은 순간도 만료)', () => {
    expect(tokenRowProblem({ ...row, expiresAt: now }, claims, now)).toBe('TOKEN_EXPIRED');
  });

  it('폐기가 만료보다 먼저 말해진다', () => {
    expect(tokenRowProblem({ ...row, revokedAt: now, expiresAt: now }, claims, now)).toBe('TOKEN_REVOKED');
  });

  it('행의 주인이 클레임의 사용자와 다르면 TOKEN_UNKNOWN', () => {
    expect(tokenRowProblem({ ...row, userId: TOKEN }, claims, now)).toBe('TOKEN_UNKNOWN');
  });
});

describe('tokenUserProblem — 토큰 주인이 지금 쓸 수 있는 계정인가', () => {
  const active = { status: 'active', mustChangePassword: false };

  it('활성이면 null', () => {
    expect(tokenUserProblem(active)).toBeNull();
  });

  it.each(['pending', 'suspended'])('%s → ACCOUNT_INACTIVE', (status) => {
    expect(tokenUserProblem({ ...active, status })).toBe('ACCOUNT_INACTIVE');
  });

  it('사용자가 없으면 ACCOUNT_INACTIVE', () => {
    expect(tokenUserProblem(null)).toBe('ACCOUNT_INACTIVE');
  });

  it('비밀번호 변경이 강제된 계정의 토큰은 막는다 — 화면에서 바꾸기 전까지', () => {
    expect(tokenUserProblem({ ...active, mustChangePassword: true })).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('resolveTokenExpiry', () => {
  const now = new Date('2026-10-02T00:00:00Z');

  it('날 수를 주지 않으면 기본 90일', () => {
    expect(resolveTokenExpiry(now, undefined, 365)).toEqual({ ok: true, expiresAt: new Date(now.getTime() + 90 * DAY_MS) });
  });

  it('운영 상한이 기본보다 짧으면 기본은 상한이 된다', () => {
    expect(resolveTokenExpiry(now, undefined, 30)).toEqual({ ok: true, expiresAt: new Date(now.getTime() + 30 * DAY_MS) });
  });

  it('상한과 같으면 받는다', () => {
    expect(resolveTokenExpiry(now, 365, 365)).toEqual({ ok: true, expiresAt: new Date(now.getTime() + 365 * DAY_MS) });
  });

  it('상한을 넘으면 EXPIRY_TOO_LONG과 상한을 알린다', () => {
    expect(resolveTokenExpiry(now, 31, 30)).toEqual({ ok: false, code: 'EXPIRY_TOO_LONG', maxDays: 30 });
  });
});

describe('createApiTokenDto', () => {
  const ok = { name: '보고서 봇', scopes: ['read'] };

  it('이름은 앞뒤 공백을 떼고, 날 수는 없어도 된다', () => {
    expect(createApiTokenDto.parse({ ...ok, name: '  보고서 봇 ' })).toEqual({ name: '보고서 봇', scopes: ['read'] });
  });

  it.each([
    ['빈 이름', { ...ok, name: '   ' }],
    ['긴 이름', { ...ok, name: 'x'.repeat(API_TOKEN_LIMITS.nameMaxChars + 1) }],
    ['빈 scope', { ...ok, scopes: [] }],
    ['모르는 scope', { ...ok, scopes: ['delete'] }],
    ['0일', { ...ok, expiresInDays: 0 }],
    ['366일', { ...ok, expiresInDays: 366 }],
    ['소수 날', { ...ok, expiresInDays: 1.5 }],
  ])('%s는 받지 않는다', (_name, body) => {
    expect(createApiTokenDto.safeParse(body).success).toBe(false);
  });

  it('scope는 정규화된다', () => {
    expect(createApiTokenDto.parse({ ...ok, scopes: ['write', 'read', 'write'] }).scopes).toEqual(['read', 'write']);
  });
});
