import { describe, expect, it } from 'vitest';
import { blobPath } from './blob-path';

const SHA = 'a'.repeat(64);

describe('blobPath (FR-412)', () => {
  it('앞 두 자로 디렉토리를 나눈다', () => {
    expect(blobPath('/data', SHA)).toBe(`/data/aa/${SHA}`);
  });

  it('해시 형식이 아니면 거부한다 — **경로를 만드는 값이기 때문이다**', () => {
    for (const bad of ['', '../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), `${SHA}/x`, 'a/b']) {
      expect(() => blobPath('/data', bad)).toThrow(/SHA-256/);
    }
  });

  it('루트가 상대 경로여도 그대로 이어 붙인다 — 절대화는 호출부의 일이다', () => {
    expect(blobPath('.local/attachments', SHA)).toBe(`.local/attachments/aa/${SHA}`);
  });
});
