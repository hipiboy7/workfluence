import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scramSha256Verifier } from './scram';

/**
 * A등급 — PostgreSQL이 받는 **SCRAM-SHA-256 확인값**을 앱이 만든다 (병합 전 검토 — 앱 계정 비밀번호를 평문으로 DB 문장에 싣지 않는다).
 *
 * `ALTER ROLE … PASSWORD '<평문>'`은 그 문장이 실패하거나 `log_statement`가 켜져 있으면 postgres 로그에 평문이 남는다(`CLAUDE.md` 7절).
 * 확인값(`SCRAM-SHA-256$<반복>:<솔트>$<StoredKey>:<ServerKey>`)을 보내면 PostgreSQL은 그것을 그대로 저장한다 — 평문이 앱 밖으로 가지 않는다.
 * 맞는지는 **RFC 7677의 공개 예시**로 본다: 같은 비밀번호·솔트·반복으로 만든 키가 그 예시의 서버 서명과 클라이언트 증명을 맞춰야 한다.
 * 실제 PostgreSQL이 받는지는 `app-role.integration.spec.ts`가 그 계정으로 붙어 본다
 */

// RFC 7677 §3 — user "user", password "pencil"
const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
const AUTH_MESSAGE =
  'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
  'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
  'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
const CLIENT_PROOF = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
const SERVER_SIGNATURE = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

const parse = (v: string) => {
  const m = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m) throw new Error(`모양이 아니다: ${v}`);
  return { iterations: Number(m[1]), salt: Buffer.from(m[2], 'base64'), storedKey: Buffer.from(m[3], 'base64'), serverKey: Buffer.from(m[4], 'base64') };
};
const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest();

describe('scramSha256Verifier', () => {
  it('PostgreSQL이 받는 모양 — 반복 4096, 솔트와 두 키는 base64', () => {
    const v = parse(scramSha256Verifier('pencil', SALT));
    expect(v.iterations).toBe(4096);
    expect(v.salt.equals(SALT)).toBe(true);
    expect(v.storedKey).toHaveLength(32);
    expect(v.serverKey).toHaveLength(32);
  });

  it('**RFC 7677의 서버 서명을 맞춘다** — ServerKey가 맞다', () => {
    const { serverKey } = parse(scramSha256Verifier('pencil', SALT));
    expect(hmac(serverKey, AUTH_MESSAGE).toString('base64')).toBe(SERVER_SIGNATURE);
  });

  it('**RFC 7677의 클라이언트 증명을 맞춘다** — StoredKey가 맞다(증명에서 되찾은 ClientKey의 해시가 StoredKey다)', () => {
    const { storedKey } = parse(scramSha256Verifier('pencil', SALT));
    const signature = hmac(storedKey, AUTH_MESSAGE);
    const clientKey = Buffer.from(CLIENT_PROOF.map((b, i) => b ^ signature[i]));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
  });

  it('비밀번호가 다르면 다른 키 — 솔트가 같아도', () => {
    expect(parse(scramSha256Verifier('pencil', SALT)).storedKey.equals(parse(scramSha256Verifier('pencil2', SALT)).storedKey)).toBe(false);
  });

  it('**평문이 결과에 없다**', () => {
    expect(scramSha256Verifier('0123456789abcdef-secret', SALT)).not.toContain('0123456789abcdef-secret');
  });

  it('**인쇄 가능한 ASCII만 받는다** — PostgreSQL은 비밀번호를 SASLprep으로 고른 뒤 계산한다. ASCII 밖은 여기서 같게 만들 수 없다', () => {
    for (const bad of ['', 'has space', '한글비밀번호', 'tab\there', 'nl\nhere']) {
      expect(() => scramSha256Verifier(bad, SALT), JSON.stringify(bad)).toThrow(/ASCII/);
    }
  });

  it('솔트는 16바이트 이상', () => {
    expect(() => scramSha256Verifier('pencil', Buffer.alloc(8))).toThrow(/솔트/);
  });
});
