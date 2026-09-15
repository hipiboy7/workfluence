import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, EnvValidationError, extractEnvExampleKeys, parseEnv } from './env';

const valid = {
  WF_DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/db',
  WF_SESSION_SECRET: 'x'.repeat(32),
};

describe('parseEnv', () => {
  it('WF_ 키만 골라 파싱하고 기본값을 채운다', () => {
    const env = parseEnv({ ...valid, PATH: '/usr/bin', HOME: '/home' });
    expect(env.WF_ENV).toBe('development');
    expect(env.WF_PORT).toBe(3000);
    expect(env.WF_DB_AUTO_MIGRATE).toBe(false);
    expect(env.WF_SESSION_IDLE_MINUTES).toBe(30);
  });

  it('스키마에 없는 WF_ 키는 기동 실패 (미배선·오타 키 차단)', () => {
    expect(() => parseEnv({ ...valid, WF_TYPO: '1' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, WF_TYPO: '1' })).toThrow(/WF_TYPO/);
  });

  it('타입·범위가 틀리면 기동 실패', () => {
    expect(() => parseEnv({ ...valid, WF_PORT: 'abc' })).toThrow(/WF_PORT/);
    expect(() => parseEnv({ ...valid, WF_PORT: '70000' })).toThrow(/WF_PORT/);
    expect(() => parseEnv({ ...valid, WF_COOKIE_SECURE: 'yes' })).toThrow(/WF_COOKIE_SECURE/);
    expect(() => parseEnv({ ...valid, WF_SESSION_SECRET: 'short' })).toThrow(/32자/);
    expect(() => parseEnv({ WF_SESSION_SECRET: valid.WF_SESSION_SECRET })).toThrow(/WF_DATABASE_URL/);
  });

  it('빈 문자열 값은 미설정으로 취급해 기본값을 쓴다', () => {
    expect(parseEnv({ ...valid, WF_PORT: '' }).WF_PORT).toBe(3000);
  });

  it('운영에서 자동 마이그레이션은 금지', () => {
    expect(() => parseEnv({ ...valid, WF_ENV: 'production', WF_DB_AUTO_MIGRATE: 'true' })).toThrow(/production/);
    expect(parseEnv({ ...valid, WF_ENV: 'production', WF_DB_AUTO_MIGRATE: 'false' }).WF_ENV).toBe('production');
  });

  it('불리언·정수 변환', () => {
    const env = parseEnv({ ...valid, WF_COOKIE_SECURE: 'true', WF_TRUST_PROXY: 'false', WF_SESSION_ABSOLUTE_HOURS: '8' });
    expect(env.WF_COOKIE_SECURE).toBe(true);
    expect(env.WF_TRUST_PROXY).toBe(false);
    expect(env.WF_SESSION_ABSOLUTE_HOURS).toBe(8);
  });
});

describe('.env.example ↔ 스키마 키 집합 (CLAUDE.md 5절)', () => {
  it('키 집합이 정확히 같다', () => {
    const content = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
    const exampleKeys = extractEnvExampleKeys(content).sort();
    expect(exampleKeys).toEqual([...ENV_KEYS].sort());
  });

  it('extractEnvExampleKeys는 주석·빈 줄을 무시한다', () => {
    expect(extractEnvExampleKeys('# c\n\nA=1\n  B = 2 \n#D=4')).toEqual(['A', 'B']);
  });
});
