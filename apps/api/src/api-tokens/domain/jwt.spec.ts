import { API_JWT } from '@workfluence/shared';
import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { parseBearer, signApiToken, verifyApiToken } from './jwt';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const OTHER = 'other-secret-0123456789abcdef0123456789abcdef';
const USER = '3f1c9a52-8d4e-4b7a-9c1e-2a6b8d0f4e11';
const TOKEN = '7b2e4d6f-1a3c-4e5b-8f9a-0c1d2e3f4a5b';
const NOW = new Date('2026-10-02T00:00:00Z');
const LATER = new Date('2026-12-31T00:00:00Z');

const sign = () => signApiToken({ userId: USER, tokenId: TOKEN, scopes: ['read', 'write'], issuedAt: NOW, expiresAt: LATER }, SECRET);
const key = (s: string) => new TextEncoder().encode(s);

describe('signApiToken → verifyApiToken', () => {
  it('왕복하면 사용자·토큰·scope가 그대로 나온다', async () => {
    const jwt = await sign();
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: true, userId: USER, tokenId: TOKEN, scopes: ['read', 'write'] });
  });

  it('헤더는 HS256·JWT, 클레임은 iss·aud·sub·jti·scope·iat·exp', async () => {
    const jwt = await sign();
    const [h, p] = jwt.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
    expect(h).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(p).toEqual({
      iss: API_JWT.issuer,
      aud: API_JWT.audience,
      sub: USER,
      jti: TOKEN,
      scope: 'read write',
      iat: NOW.getTime() / 1000,
      exp: LATER.getTime() / 1000,
    });
  });

  it('다른 키로 서명한 것은 TOKEN_INVALID', async () => {
    const jwt = await signApiToken({ userId: USER, tokenId: TOKEN, scopes: ['read'], issuedAt: NOW, expiresAt: LATER }, OTHER);
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('만료 뒤는 TOKEN_EXPIRED', async () => {
    const jwt = await sign();
    expect(await verifyApiToken(jwt, SECRET, new Date(LATER.getTime() + 1000))).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('`alg: none`은 받지 않는다', async () => {
    const jwt = new UnsecuredJWT({ scope: 'read', jti: TOKEN })
      .setSubject(USER)
      .setIssuer(API_JWT.issuer)
      .setAudience(API_JWT.audience)
      .setIssuedAt(NOW)
      .setExpirationTime(LATER)
      .encode();
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('같은 키라도 다른 알고리즘(HS512)은 받지 않는다 — 알고리즘은 고정이다', async () => {
    const jwt = await new SignJWT({ scope: 'read' })
      .setProtectedHeader({ alg: 'HS512', typ: 'JWT' })
      .setSubject(USER)
      .setJti(TOKEN)
      .setIssuer(API_JWT.issuer)
      .setAudience(API_JWT.audience)
      .setIssuedAt(NOW)
      .setExpirationTime(LATER)
      .sign(key(SECRET));
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it.each([
    ['발급자', { iss: 'someone-else', aud: API_JWT.audience }],
    ['대상', { iss: API_JWT.issuer, aud: 'workfluence-web' }],
  ])('%s가 다르면 TOKEN_INVALID', async (_name, override) => {
    const jwt = await new SignJWT({ scope: 'read' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(USER)
      .setJti(TOKEN)
      .setIssuer(override.iss)
      .setAudience(override.aud)
      .setIssuedAt(NOW)
      .setExpirationTime(LATER)
      .sign(key(SECRET));
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('만료(exp)가 없는 토큰은 받지 않는다', async () => {
    const jwt = await new SignJWT({ scope: 'read' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(USER)
      .setJti(TOKEN)
      .setIssuer(API_JWT.issuer)
      .setAudience(API_JWT.audience)
      .setIssuedAt(NOW)
      .sign(key(SECRET));
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('서명이 맞아도 클레임 모양이 틀리면 TOKEN_INVALID (모르는 scope)', async () => {
    const jwt = await new SignJWT({ scope: 'read root' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(USER)
      .setJti(TOKEN)
      .setIssuer(API_JWT.issuer)
      .setAudience(API_JWT.audience)
      .setIssuedAt(NOW)
      .setExpirationTime(LATER)
      .sign(key(SECRET));
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('본문을 바꿔 치면 TOKEN_INVALID', async () => {
    const [h, , s] = (await sign()).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: USER, jti: TOKEN, scope: 'read write admin' })).toString('base64url');
    expect(await verifyApiToken(`${h}.${forged}.${s}`, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it.each(['', 'abc', 'a.b.c', 'a.b'])('모양이 틀린 문자열 %j → TOKEN_INVALID', async (jwt) => {
    expect(await verifyApiToken(jwt, SECRET, NOW)).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });

  it('키가 32바이트보다 짧으면 서명하지 않는다 — HS256의 키는 해시 길이 이상이어야 한다', async () => {
    await expect(
      signApiToken({ userId: USER, tokenId: TOKEN, scopes: ['read'], issuedAt: NOW, expiresAt: LATER }, 'short'),
    ).rejects.toThrow();
  });
});

describe('parseBearer', () => {
  it('Bearer 뒤의 값을 꺼낸다', () => {
    expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('방식 이름은 대소문자를 가리지 않는다 (RFC 9110 11.1)', () => {
    expect(parseBearer('bearer abc')).toBe('abc');
  });

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'Token abc'])('%j → null', (h) => {
    expect(parseBearer(h)).toBeNull();
  });

  it('여러 값이 오면(배열) 받지 않는다', () => {
    expect(parseBearer(['Bearer a', 'Bearer b'])).toBeNull();
  });
});
