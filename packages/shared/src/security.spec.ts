import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from './constants';
import { checkPasswordPolicy, countCharClasses } from './permissions';
import { generateSpaceKey, generateTemporaryPassword, maskEmail, maskUsername } from './security';

/** 결정적 난수: 0,1,2,... 순환 */
function sequence(): (max: number) => number {
  let i = 0;
  return (max) => i++ % max;
}

describe('maskUsername', () => {
  it('앞 2자와(5자 이상이면) 뒤 1자만 남긴다', () => {
    expect(maskUsername('hong.gd')).toBe('ho****d');
    expect(maskUsername('kim')).toBe('ki*');
    expect(maskUsername('abcd')).toBe('ab**');
    expect(maskUsername('ab')).toBe('a*');
    expect(maskUsername('a')).toBe('a');
    expect(maskUsername('')).toBe('');
  });
});

describe('maskEmail', () => {
  it('로컬 파트 앞 2자만 노출', () => {
    expect(maskEmail('hong.gd@example.internal')).toBe('ho*****@example.internal');
    expect(maskEmail('a@x.y')).toBe('a*@x.y');
  });
});

describe('generateTemporaryPassword', () => {
  it('길이를 지키고 4종을 모두 포함해 정책(2종)을 항상 만족한다', () => {
    const pw = generateTemporaryPassword(sequence());
    expect(pw).toHaveLength(12);
    expect(countCharClasses(pw)).toBe(4);
    expect(checkPasswordPolicy(pw, PASSWORD_POLICY)).toEqual([]);
  });

  it('혼동 문자(0, O, 1, l, I, i, o)를 쓰지 않는다', () => {
    const rng = sequence();
    for (let k = 0; k < 20; k++) expect(generateTemporaryPassword(rng, 16)).not.toMatch(/[01OolIi]/);
  });

  it('실제 무작위 소스에서도 정책을 만족한다', () => {
    const rng = (max: number) => Math.floor(Math.random() * max);
    for (let k = 0; k < 200; k++) expect(checkPasswordPolicy(generateTemporaryPassword(rng), PASSWORD_POLICY)).toEqual([]);
  });

  it('길이 4 미만은 거부', () => {
    expect(() => generateTemporaryPassword(sequence(), 3)).toThrow();
  });
});

describe('generateSpaceKey', () => {
  it('WF + 6자', () => {
    expect(generateSpaceKey(sequence())).toMatch(/^WF[A-Z2-9]{6}$/);
  });
});
