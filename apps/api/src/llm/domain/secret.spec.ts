import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretError, openSecret, parseMasterKey, providerAad, sealSecret } from './secret';

/**
 * A등급 — **테스트 먼저** (P10_설계서_Llm D.4, FR-1102·1103).
 *
 * 키 하나가 새면 사내 LLM 서버를 누구나 부를 수 있다. 그래서 "풀린다"보다 **"틀린 것으로는 안 풀린다"**를 더 많이 본다.
 */

const key = Buffer.alloc(32, 7);
const aad = providerAad('11111111-1111-4111-8111-111111111111');

describe('sealSecret · openSecret', () => {
  it('넣은 것이 그대로 나온다', () => {
    expect(openSecret(sealSecret('sk-사내-키', key, aad), key, aad)).toBe('sk-사내-키');
  });

  it('모양은 `v1.IV.태그.암호문`이고 **평문이 보이지 않는다**', () => {
    const sealed = sealSecret('plain-api-key-value', key, aad);
    expect(sealed.split('.')).toHaveLength(4);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('plain-api-key-value');
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('**같은 키를 두 번 넣어도 암호문이 다르다** — IV가 매번 새로다', () => {
    expect(sealSecret('k', key, aad)).not.toBe(sealSecret('k', key, aad));
  });

  it('IV를 주면 결정적이다 — 시험을 위한 문', () => {
    const iv = Buffer.alloc(12, 1);
    expect(sealSecret('k', key, aad, iv)).toBe(sealSecret('k', key, aad, iv));
  });

  it('다른 마스터 키로는 풀리지 않는다 — 마스터 키를 바꾼 경우 (D.4)', () => {
    const sealed = sealSecret('k', key, aad);
    expect(() => openSecret(sealed, Buffer.alloc(32, 8), aad)).toThrow(SecretError);
  });

  it('**다른 행으로 옮겨 붙이면 풀리지 않는다** — AAD가 행 id에 묶여 있다', () => {
    const sealed = sealSecret('k', key, aad);
    expect(() => openSecret(sealed, key, providerAad('22222222-2222-4222-8222-222222222222'))).toThrow(SecretError);
  });

  it('암호문·태그를 한 글자라도 바꾸면 풀리지 않는다', () => {
    const [v, iv, tag, ct] = sealSecret('k-long-enough', key, aad).split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => openSecret([v, iv, tag, flip(ct)].join('.'), key, aad)).toThrow(SecretError);
    expect(() => openSecret([v, iv, flip(tag), ct].join('.'), key, aad)).toThrow(SecretError);
    expect(() => openSecret([v, flip(iv), tag, ct].join('.'), key, aad)).toThrow(SecretError);
  });

  it('모양이 틀리면 SecretError — 판이 다르거나 조각이 모자라다', () => {
    const sealed = sealSecret('k', key, aad);
    expect(() => openSecret(sealed.replace(/^v1/, 'v2'), key, aad)).toThrow(SecretError);
    expect(() => openSecret('garbage', key, aad)).toThrow(SecretError);
    expect(() => openSecret('v1.a.b', key, aad)).toThrow(SecretError);
    expect(() => openSecret('v1...', key, aad)).toThrow(SecretError);
  });

  it('**SecretError의 문장에 평문도 키도 없다** — 오류는 로그로 간다', () => {
    try {
      openSecret(sealSecret('secret-value', key, aad), Buffer.alloc(32, 9), aad);
      throw new Error('풀리면 안 된다');
    } catch (e) {
      expect(e).toBeInstanceOf(SecretError);
      expect(String((e as Error).message)).not.toContain('secret-value');
    }
  });

  it('긴 키도 넣고 뺀다', () => {
    const long = randomBytes(2048).toString('base64');
    expect(openSecret(sealSecret(long, key, aad), key, aad)).toBe(long);
  });
});

describe('parseMasterKey', () => {
  it('비면 null — 키 없는 LLM만 등록된다 (FR-1103)', () => {
    expect(parseMasterKey('')).toBeNull();
  });

  it('base64url(43자)과 base64(44자)를 둘 다 32바이트로 읽는다', () => {
    const bytes = randomBytes(32);
    expect(parseMasterKey(bytes.toString('base64url'))?.equals(bytes)).toBe(true);
    expect(parseMasterKey(bytes.toString('base64'))?.equals(bytes)).toBe(true);
  });

  it('32바이트가 아니면 던진다 — 기동에서 이미 걸렀어야 하는 것이 여기 오면 시끄럽게', () => {
    expect(() => parseMasterKey(randomBytes(16).toString('base64url'))).toThrow(/32/);
  });
});

describe('providerAad', () => {
  it('행 id를 담는다', () => {
    expect(providerAad('abc')).toBe('llm_providers:abc');
  });
});
